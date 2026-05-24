# Tour Step 02: Open & mmap the GGUF file

Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

Step 01 ended with a fully populated `cli_config` on `main`'s stack. The relevant fields for this step are:

```
cfg.engine.model_path = "DS4.gguf"
cfg.engine.backend    = DS4_BACKEND_METAL     /* Apple Silicon build */
cfg.engine.warm_weights = false
```

`main` is now executing `ds4_engine_open(&engine, &cfg.engine)` at `ds4_cli.c:1590`. Stepping into that function (`ds4.c:17636`), the engine struct is zero-allocated, a few scalars from `opt` are copied across, and after acquiring an instance lock the very next call is:

```c
const bool graph_backend = ds4_backend_uses_graph(opt->backend);
model_open(&e->model, opt->model_path, graph_backend, true);
```

at `ds4.c:17663-17664`. `graph_backend` is `true` here because Metal is a graph backend; `prefetch_cpu` is `true` (the `true` literal in the call) so the CPU prefetch helper would fire on the CPU path. The process owns no model bytes yet — only a path string. Our job in this step is to walk the body of `model_open` (`ds4.c:1217`) and return with a fully parsed `ds4_model` whose `tensors[]` array indexes every byte of the GGUF without copying any of it.

DS4 Flash is around 24 GiB. We need to do this in milliseconds.

## 2. The problem

The GGUF file holds three sections: a small header, a key-value metadata table, and a tensor data block whose entries are each pointed at by an entry in a tensor directory. The job of this step is:

> Open the file, learn its size, expose its bytes to the rest of the process **without copying them**, sanity-check the header magic and version, parse the metadata table into an indexable structure, parse the tensor directory and turn each tensor's relative offset into an absolute offset into the mapping — all without reading the multi-gigabyte tensor payload itself.

Three constraints make this non-trivial:

1. **Memory budget.** A 24 GiB model on a 16 GiB MacBook is normal. Any solution that requires the file to fit in RAM is dead on arrival.
2. **Startup latency.** The user expects ds4 to start producing tokens within a few seconds of `Enter`, not minutes.
3. **Zero-copy handoff to the GPU.** On Metal, the GPU needs to read raw quant blocks. If those blocks live in a normal `malloc`'d buffer, the Metal driver has to copy them again into a `MTLBuffer`. If they live in a shared file-backed mapping, `MTLBuffer` can wrap them in place.

## 3. Naive approach

`fopen` then `fread` the whole file into a heap buffer. After it returns, walk that buffer in memory using pointer arithmetic to parse the metadata and tensor directory. Pass pointers into that buffer down to the inference layer. Free the buffer in `ds4_engine_close`.

For a small GGUF — a 100 MB tokenizer-only file, say — this is exactly right. The buffer fits, the `fread` is one syscall (well, a few), and pointer arithmetic on `void *` is the normal C way. The Chinese version of this trace correctly observes that "the idea isn't absurd".

## 4. Why the naive approach breaks

For DS4 Flash specifically the failure modes are concrete:

- **`malloc(24G)` fails or thrashes.** On an M2 MacBook Air with 24 GB of unified memory, allocating 24 GB of heap is a guaranteed `ENOMEM` or a swap-storm killing the system. On a 128 GB M3 Max it succeeds, but the process is now 24 GB resident — competing with everything else the user is running.
- **`fread` of 24 GB takes 30-60 seconds.** Even with NVMe at 3-4 GB/s sequential, you pay the full bandwidth cost up-front. Most users only touch a small fraction of the model in any given inference (MoE: only 6 of 256 experts per layer per token), so the up-front load is wasted on bytes that may never be read.
- **A `malloc` buffer breaks the Metal zero-copy story.** `MTLBuffer newBufferWithBytesNoCopy:length:options:deallocator:` wants a page-aligned, file-backed or `vm_allocate`'d region with a stable lifetime. A heap region copied from `fread` does not qualify. The Metal driver falls back to copying every accessed slice into a private buffer — a second 24 GB in GPU memory.
- **The eager read defeats the OS's own paging.** Modern kernels can map a file and bring in pages on demand from the page cache. `fread` opts out of that, manually duplicating the page cache into the heap.

The summary: when the model is larger than half of available RAM, eager `fread` is structurally wrong. Above that threshold the only acceptable answer is "let the kernel page it in lazily".

## 5. ds4's approach

ds4's approach is to **`mmap` the entire file once**, parse only the header / metadata / tensor directory in place inside the mapping, and let the tensor payload stay on disk until the inference kernels actually read it. The whole loader is around 100 lines.

`model_open` at `ds4.c:1217` does this in order:

```c
static void model_open(ds4_model *m, const char *path, bool metal_mapping,
                       bool prefetch_cpu) {
    memset(m, 0, sizeof(*m));
    m->fd = -1;

    int fd = open(path, O_RDONLY);
    if (fd == -1) ds4_die_errno("cannot open model", path);

    struct stat st;
    if (fstat(fd, &st) == -1) ds4_die_errno("cannot stat model", path);
    if (st.st_size < 32) ds4_die("model file is too small to be GGUF");

    const int mmap_flags = metal_mapping ? MAP_SHARED : MAP_PRIVATE;
    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, mmap_flags, fd, 0);
    if (map == MAP_FAILED) ds4_die_errno("cannot mmap model", path);

    m->fd = fd;
    m->map = map;
    m->size = (uint64_t)st.st_size;
    ...
}
```

That's `ds4.c:1219-1247`. The `mmap` call itself triggers **no disk I/O**. The kernel returns a virtual address; the bytes only materialize when something dereferences that address. For a 24 GiB file on a slow disk, `mmap` itself takes under a millisecond.

**Two `mmap` flag policies, one for each backend (`ds4.c:1241`):**

- **Metal path:** `MAP_SHARED`. The mapping is file-backed and shared. Metal can wrap a slice of this mapping as a no-copy `MTLBuffer` (the GPU code in `ds4_gpu.h` does exactly this via `ds4_gpu_set_model_map_range` invoked at `ds4.c:17711`). Weights never enter the CPU heap. They never even, strictly, enter CPU RAM in the traditional sense — on Apple Silicon's unified memory architecture, the GPU and CPU see the same physical pages.
- **CPU path:** `MAP_PRIVATE`. Copy-on-write read-only mapping. The comment above the flag (`ds4.c:1229-1240`) is explicit about why: a Darwin kernel bug in VM map-count accounting can panic the OS when the CPU backend streams a very large file-backed shared mapping. `MAP_PRIVATE` skirts the buggy code path while keeping all the benefits of `mmap`. The follow-on `model_prefetch_cpu_mapping` (`ds4.c:1108`) calls `posix_madvise(... POSIX_MADV_WILLNEED)` to ask the kernel to populate the page cache proactively — without copying.

For our trace the binary was built on Apple Silicon, so `metal_mapping = true`, so `MAP_SHARED`.

**Header read (`ds4.c:1249-1257`):** a tiny `ds4_cursor` (`ds4.c:404-409`) is created over the mapping. The cursor is just three fields — a base pointer, a size, and a position — that slides over the mapping with bounds-checked reads. Four scalars are pulled out:

```c
ds4_cursor c = cursor_at(m, 0);
uint32_t magic;
if (!cursor_u32(&c, &magic)) ds4_die(c.error);
if (magic != DS4_GGUF_MAGIC) ds4_die("model is not a GGUF file");   /* 'GGUF', 0x46554747 */
if (!cursor_u32(&c, &m->version)) ds4_die(c.error);
if (!cursor_u64(&c, &m->n_tensors)) ds4_die(c.error);
if (!cursor_u64(&c, &m->n_kv)) ds4_die(c.error);
if (m->version != 3) ds4_die("only GGUF v3 is supported");
```

`DS4_GGUF_MAGIC` is defined at `ds4.c:394`. The magic and version check are the file's first line of defense against being fed something that is not a GGUF v3 at all.

**Metadata parse (`ds4.c:1134` `parse_metadata`, called from `ds4.c:1259`):** allocates `m->kv = calloc(m->n_kv, sizeof(ds4_kv))` — one entry per metadata key. Each `ds4_kv` (`ds4.c:919-923`) holds just `{ key string view, type tag, value position }`. The **value bytes stay inside the mapping**; `kv->value_pos` is the offset to read them later. `skip_value` (`ds4.c:973`) walks past each value without decoding it, so the parse is a single forward pass. The one exception: `general.alignment` is read in line at `ds4.c:1148-1156` because the loop body below needs it. This per-key index typically costs tens of kilobytes regardless of model size.

**Tensor directory parse (`ds4.c:1164` `parse_tensors`, called from `ds4.c:1260`):** allocates `m->tensors = calloc(m->n_tensors, sizeof(ds4_tensor))`. Each `ds4_tensor` (`ds4.c:925-934`) holds:

```c
typedef struct {
    ds4_str name;                       /* points into the mmap */
    uint32_t ndim;
    uint64_t dim[DS4_MAX_DIMS];
    uint32_t type;                      /* GGUF quant type enum */
    uint64_t rel_offset;                /* offset relative to tensor_data_pos */
    uint64_t abs_offset;                /* filled below */
    uint64_t elements;
    uint64_t bytes;
} ds4_tensor;
```

The first loop reads `name`, `ndim`, `dim[]`, `type`, `rel_offset` for each tensor and computes `elements` and `bytes` (`ds4.c:1168-1195`). A second pass converts `rel_offset → abs_offset` (`ds4.c:1197-1210`):

```c
m->tensor_data_pos = align_up(c->pos, m->alignment);
for (uint64_t i = 0; i < m->n_tensors; i++) {
    ds4_tensor *t = &m->tensors[i];
    if (t->rel_offset > UINT64_MAX - m->tensor_data_pos) ds4_die("tensor offset overflow");
    t->abs_offset = m->tensor_data_pos + t->rel_offset;
    if (t->bytes != 0 &&
        (t->abs_offset > m->size || t->bytes > m->size - t->abs_offset)) {
        ds4_die("tensor points outside GGUF file");
    }
}
```

`align_up` is at `ds4.c:840`; `m->alignment` defaults to 32 but can be overridden by the GGUF's `general.alignment` metadata. The bounds check rejects malformed files that claim a tensor extends past EOF — an attack vector if you accept GGUFs from untrusted sources.

After this loop, looking up the bytes of any tensor is a single pointer addition (`tensor_data` at `ds4.c:1493`):

```c
static const void *tensor_data(const ds4_model *m, const ds4_tensor *t) {
    return m->map + t->abs_offset;
}
```

No string lookup, no syscalls, no copy. The whole step is summarized: **mmap the file, parse the small header / metadata / directory pieces in place, leave the gigabytes alone.**

## 6. Code locations

In suggested reading order:

- `ds4.c:394` — `DS4_GGUF_MAGIC` definition (`'GGUF'` little-endian, `0x46554747`).
- `ds4.c:404-409` — `ds4_cursor` struct: bounded cursor used to walk the mapping.
- `ds4.c:822-838` — `cursor_u32`, `cursor_u64`, `cursor_string`: bounds-checked primitive reads.
- `ds4.c:840` — `align_up`: the alignment helper used to compute `tensor_data_pos`.
- `ds4.c:919-934` — `ds4_kv` and `ds4_tensor` struct definitions.
- `ds4.c:936-949` — `ds4_model` struct: `{ fd, map, size, version, n_kv, n_tensors, alignment, tensor_data_pos, kv, tensors }`.
- `ds4.c:1108-1130` — `model_prefetch_cpu_mapping`: `posix_madvise(POSIX_MADV_WILLNEED)` for the CPU path, with a Darwin-VM-bug comment.
- `ds4.c:1134-1160` — `parse_metadata`: linear walk of the metadata table, values stay in the mapping.
- `ds4.c:1164-1211` — `parse_tensors`: read tensor directory then in-place convert `rel_offset → abs_offset` with bounds checks.
- `ds4.c:1217-1263` — `model_open`: `open` + `fstat` + `mmap` + magic check + `parse_metadata` + `parse_tensors` + optional CPU prefetch.
- `ds4.c:1493-1495` — `tensor_data`: the one-line tensor lookup that all of inference relies on.
- `ds4.c:17664` — the call site of `model_open` inside `ds4_engine_open`.

## 7. Branches and extensions

- **Full GGUF format specification.** The binary layout of magic / version / KV table / tensor directory / data section, plus the value-type taxonomy (`GGUF_VALUE_UINT8` ... `GGUF_VALUE_ARRAY` at `ds4.c:856-868`), is the subject of [03-gguf-loading.md](./03-gguf-loading.md). That chapter also describes the `cursor_*` family in detail and what `general.alignment` means.
- **Tokenizer-only loads.** A diagnostic path (`ds4_dump_text_tokenization` at `ds4.c:17203`) calls `model_open(&model, model_path, false, false)` — note `prefetch_cpu = false`. The intent is: open the GGUF to read tokenizer metadata but never page in the multi-gigabyte tensor data. See the diagnostic command zoo in [01-architecture-overview.md](./01-architecture-overview.md).
- **Warm-weights pass.** `--warm-weights` (`ds4_cli.c:1540`) flips a flag that makes `ds4_engine_open` call `model_warm_weights` (`ds4.c:1498`) after `model_open`. This walks every page of the tensor data so the first inference does not block on page faults. Useful for benchmarking. The branch is `ds4.c:17665`.
- **Metal MTLBuffer wrapping.** The Metal driver does not use `tensor_data` directly; instead it gets a single contiguous range via `ds4_gpu_set_model_map_range` (`ds4.c:17711`) and computes its own per-tensor pointers inside the mapping. See [10-metal-backend.md](./10-metal-backend.md) for the wrapping mechanics.
- **CUDA mapping (not exercised here).** The CUDA path also uses `MAP_SHARED` (because `ds4_backend_uses_graph(CUDA)` is true) and copies tensor data into device memory via the same `ds4_gpu_*` shim. See [11-cuda-backend.md](./11-cuda-backend.md).
- **Quantization block layouts.** The `t->type` field will be checked against the layer schema in step 03. The block byte-counts that drive `tensor_nbytes` (called at `ds4.c:1189`) are in the `gguf_types` table at `ds4.c:877` and are explained in [04-quantization.md](./04-quantization.md).

## 8. What you should now have in your head

- `mmap` is **address-space mapping, not memory loading.** The `mmap` call itself is microseconds; the gigabytes only materialize when something reads them, and only the touched pages enter RAM.
- ds4 selects `MAP_SHARED` for Metal/CUDA (zero-copy GPU buffer wrapping) and `MAP_PRIVATE` for CPU (Darwin VM-bug avoidance). The decision is one line at `ds4.c:1241`.
- **Metadata values are not copied out of the mapping.** `ds4_kv` (`ds4.c:919`) just stores the value's offset; the bytes stay on disk-backed pages. The metadata index typically costs tens of kilobytes, regardless of model size.
- **Tensor offsets are converted to absolute in a separate post-pass** (`ds4.c:1197-1210`). After this conversion, `tensor_data(m, t)` is a single pointer addition with no syscalls — the foundation that everything else in inference relies on for low-latency weight access.
- After step 02 the process holds: the file descriptor, the virtual address of the mapping, a few hundred kilobytes of metadata and tensor directory on the heap, and **zero bytes of tensor payload in resident memory.** All the heavy work of "loading the model" has been deferred to actual use.
