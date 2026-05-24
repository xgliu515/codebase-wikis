# Chapter 03: GGUF Loading, mmap, and Tensor Binding

> Code version locked to `antirez/ds4@f91c12b` (2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

This chapter explains what happens between `./ds4 -m DS4.gguf` and the engine being ready to do inference. Every byte of model weight is on disk; the engine has to get to it without copying, validate that it actually is DeepSeek V4 Flash, resolve all the tensor names into pointers, and hand the result to a GPU that may need a different view of the same memory.

The whole story takes ~2 seconds wall-clock on a warm cache and lives in 1100 lines of `ds4.c`. Each step has a *why*, and most of the *why*s are about avoiding copies of 80+ GB of weights.

---

## 1. The GGUF Format

ds4 only accepts GGUF v3. The format is the same one llama.cpp uses; ds4 implements a narrow subset of the reader.

### 1.1 The binary layout

A GGUF v3 file has four logical regions in this order:

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="GGUF v3 file layout with header, KV table, tensor directory, alignment padding, and tensor data regions">
<defs>
<marker id="ar31" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">GGUF v3 file layout (single mmap region)</text>
<text x="40" y="58" font-size="11" fill="#64748b">offset 0</text>
<rect x="120" y="44" width="520" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="380" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Header (24 bytes)</text>
<text x="380" y="78" text-anchor="middle" font-size="10" fill="#64748b">magic 'GGUF' | version=3 | n_tensors (u64) | n_kv (u64)</text>
<text x="660" y="70" font-size="10" fill="#94a3b8">ds4.c:1249</text>
<rect x="120" y="96" width="520" height="56" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="380" y="116" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">KV metadata table</text>
<text x="380" y="132" text-anchor="middle" font-size="10" fill="#64748b">n_kv variable-length entries: [str key][u32 type][value]</text>
<text x="380" y="146" text-anchor="middle" font-size="10" fill="#64748b">13 typed value kinds; strings and arrays are length-prefixed</text>
<text x="660" y="126" font-size="10" fill="#94a3b8">ds4.c:1134</text>
<rect x="120" y="160" width="520" height="56" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="380" y="180" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">Tensor directory</text>
<text x="380" y="196" text-anchor="middle" font-size="10" fill="#64748b">n_tensors entries: [str name][u32 ndim][u64 dim*][u32 type][u64 rel_offset]</text>
<text x="380" y="210" text-anchor="middle" font-size="10" fill="#64748b">Type code from gguf_types[]; rel_offset is into tensor data region</text>
<text x="660" y="190" font-size="10" fill="#94a3b8">ds4.c:1164</text>
<rect x="120" y="224" width="520" height="36" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3" rx="6"/>
<text x="380" y="246" text-anchor="middle" font-size="11" fill="#64748b">[alignment padding] - align_up(cursor, general.alignment) default 32</text>
<text x="660" y="246" font-size="10" fill="#94a3b8">ds4.c:840</text>
<rect x="120" y="268" width="520" height="60" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="380" y="288" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">Tensor data</text>
<text x="380" y="304" text-anchor="middle" font-size="10" fill="#64748b">Raw quantized bytes (Q8_0, IQ2_XXS, Q2_K, ...)</text>
<text x="380" y="320" text-anchor="middle" font-size="10" fill="#64748b">Read directly by inference kernels with no staging copy</text>
<text x="660" y="298" font-size="10" fill="#94a3b8">tensor_data()</text>
<text x="40" y="340" font-size="11" fill="#64748b">offset == file size</text>
<text x="380" y="350" text-anchor="middle" font-size="10" fill="#94a3b8">All four regions live in one MAP_SHARED or MAP_PRIVATE mmap of the whole file</text>
</svg>
<span class="figure-caption">Figure R3.1 | GGUF v3 file layout: header, KV metadata, tensor directory, alignment padding, then raw tensor bytes; the engine mmaps this once and walks it lazily.</span>

<details>
<summary>ASCII fallback</summary>

```
+-------------------------+   offset 0
|  Header (24 bytes)      |   magic, version, n_tensors, n_kv
+-------------------------+
|  KV metadata table      |   n_kv variable-length entries
+-------------------------+
|  Tensor directory       |   n_tensors fixed-shape entries
+-------------------------+
|  [alignment padding]    |   pad to general.alignment (default 32)
+-------------------------+
|  Tensor data            |   raw quantized bytes, exactly as the engine reads them
+-------------------------+   offset == file size
```

</details>

The header is fixed at 24 bytes and parsed at `ds4.c:1249-1257`:

```c
ds4_cursor c = cursor_at(m, 0);
uint32_t magic;
if (!cursor_u32(&c, &magic)) ds4_die(c.error);
if (magic != DS4_GGUF_MAGIC) ds4_die("model is not a GGUF file");
if (!cursor_u32(&c, &m->version)) ds4_die(c.error);
if (!cursor_u64(&c, &m->n_tensors)) ds4_die(c.error);
if (!cursor_u64(&c, &m->n_kv)) ds4_die(c.error);

if (m->version != 3) ds4_die("only GGUF v3 is supported");
```

`DS4_GGUF_MAGIC = 0x46554747` (`ds4.c:394`) — the four ASCII bytes `GGUF` interpreted as a little-endian u32.

### 1.2 KV metadata: 13 typed value kinds

GGUF metadata is a flat list of key-value pairs. The key is a length-prefixed UTF-8 string. The value carries an explicit type tag, and the type set is defined at `ds4.c:855-869`:

```c
enum {
    GGUF_VALUE_UINT8   = 0,
    GGUF_VALUE_INT8    = 1,
    GGUF_VALUE_UINT16  = 2,
    GGUF_VALUE_INT16   = 3,
    GGUF_VALUE_UINT32  = 4,
    GGUF_VALUE_INT32   = 5,
    GGUF_VALUE_FLOAT32 = 6,
    GGUF_VALUE_BOOL    = 7,
    GGUF_VALUE_STRING  = 8,
    GGUF_VALUE_ARRAY   = 9,
    GGUF_VALUE_UINT64  = 10,
    GGUF_VALUE_INT64   = 11,
    GGUF_VALUE_FLOAT64 = 12,
};
```

Scalars 0-7 and 10-12 have fixed widths (`scalar_value_size` at `ds4.c:951-973`). Strings and arrays are variable: a string is `[u64 len][bytes]`; an array is `[u32 element_type][u64 len][elements]`. ds4 never copies any of these values — it just records the file offset of each value in the KV index.

### 1.3 Tensor directory: name + shape + offset

Each tensor directory entry packs:

- A string `name` (length-prefixed UTF-8).
- `uint32_t ndim` and `uint64_t dim[ndim]` (the tensor shape, row-major).
- `uint32_t type` (one of the 30+ GGUF tensor type codes from `ds4.c:877-907`).
- `uint64_t rel_offset` (the byte offset of the tensor data within the tensor-data region, *not* the file).

ds4 stores the in-memory representation as `ds4_tensor` (`ds4.c:925-934`):

```c
typedef struct {
    ds4_str  name;
    uint32_t ndim;
    uint64_t dim[DS4_MAX_DIMS];
    uint32_t type;
    uint64_t rel_offset;
    uint64_t abs_offset;
    uint64_t elements;
    uint64_t bytes;
} ds4_tensor;
```

`abs_offset` is computed at load time as `tensor_data_pos + rel_offset` — the absolute byte offset into the mmap. `elements` and `bytes` are pre-computed for fast byte arithmetic later.

### 1.4 Why GGUF specifically

ds4 does not invent its own format. GGUF gives it three things that matter:

- **Native storage of quantized blocks.** Each tensor's bytes are exactly what the inference kernel will consume. There is no fp32/bf16 staging layer, no compressed-stream wrapper. The kernel reads the raw `iq2_xxs` or `q8_0` blocks directly.
- **Type tags per tensor.** A single mixed-precision model file can hold F16 tensors next to IQ2_XXS routed experts next to Q8_0 attention projections, and the loader treats each tensor according to its declared type.
- **Mmap-friendliness.** Tensor data is aligned to a configurable boundary (default 32 bytes, `ds4.c:1138`). The engine can hand any tensor's `(map + abs_offset, bytes)` range directly to a GPU API.

The cost is that ds4 inherits llama.cpp's metadata vocabulary (the `general.*` and architecture-specific keys). This is fine: the keys are documented and ds4 only reads what it needs.

---

## 2. The mmap Strategy

### 2.1 The single entry point

`model_open` (`ds4.c:1217-1263`) is the only place the engine opens a model file. It is called twice by `ds4_engine_open` — once for the main model and once optionally for the MTP draft model — and otherwise nowhere else:

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

    /* ... mmap_flags decision ... */
    const int mmap_flags = metal_mapping ? MAP_SHARED : MAP_PRIVATE;
    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, mmap_flags, fd, 0);
    if (map == MAP_FAILED) ds4_die_errno("cannot mmap model", path);

    m->fd = fd;
    m->map = map;
    m->size = (uint64_t)st.st_size;

    /* parse header (24 bytes) */
    ds4_cursor c = cursor_at(m, 0);
    uint32_t magic;
    if (!cursor_u32(&c, &magic)) ds4_die(c.error);
    if (magic != DS4_GGUF_MAGIC) ds4_die("model is not a GGUF file");
    if (!cursor_u32(&c, &m->version)) ds4_die(c.error);
    if (!cursor_u64(&c, &m->n_tensors)) ds4_die(c.error);
    if (!cursor_u64(&c, &m->n_kv)) ds4_die(c.error);

    if (m->version != 3) ds4_die("only GGUF v3 is supported");

    parse_metadata(m, &c);
    parse_tensors(m, &c);

    if (!metal_mapping && prefetch_cpu) model_prefetch_cpu_mapping(m);
}
```

In ~45 lines this function: opens the file read-only, stats it, mmaps the whole thing, parses the 24-byte header, parses the KV metadata table, parses the tensor directory, and on CPU backends issues a `posix_madvise(WILLNEED)` hint.

### 2.2 The model_path source

`ds4_engine_open` passes `opt->model_path` to `model_open`:

```c
/* ds4.c:17663-17664 */
const bool graph_backend = ds4_backend_uses_graph(opt->backend);
model_open(&e->model, opt->model_path, graph_backend, true);
```

`opt->model_path` is filled by each binary's `parse_options`. For the CLI, the default is the literal string `"ds4flash.gguf"` (`ds4_cli.c:1412`), overridable with `-m <path>` or `--model <path>` (`ds4_cli.c:1451-1452`). For ds4-server, the default and override path is identical; the same is true for the agent, bench, and eval binaries.

There is no path-resolution logic. The string is passed directly to `open(2)`. Operators rely on `download_model.sh` symlinking the active quant to `./ds4flash.gguf`, or pass an absolute path.

### 2.3 Why mmap and not read()

Calling `read(2)` and feeding 85 GiB of weight data into a `malloc`'d buffer would be a disaster on every machine that runs ds4. Three independent reasons:

- **RAM doubling.** `read()` requires the user-space buffer to coexist with the kernel page cache copy. On a 128 GB machine running an 85 GB model that already needs another ~20 GB for KV cache and scratch, doubling that 85 GB pushes the system into swap. mmap avoids the user-space copy entirely — the file-backed pages *are* the data structure.
- **Lazy page-in.** mmap does not bring all 85 GiB into memory at open. Pages are paged in on first touch; the OS's `readahead` machinery streams them in around the touch. On a cold start the first tokens are slower while pages fault in; subsequent tokens are at full speed once the working set is resident.
- **Zero-copy GPU sharing.** On Apple Silicon, the GPU sees the same physical pages as the CPU through unified memory. Metal can wrap a slice of the mmap as an `MTLBuffer` without copying; if ds4 used `read()`, the GPU would need its own copy. The CUDA path is more complicated (section 5 covers it) but still benefits from having one canonical memory region.

The cost of mmap is that the engine is at the mercy of the kernel's page replacement under memory pressure. `AGENT.md:31-32` is explicit about avoiding this:

```
- Avoid large CPU inference runs on macOS; the CPU path has previously exposed
  kernel VM failures with very large mappings.
```

This is the next subtlety.

### 2.4 `MAP_SHARED` vs `MAP_PRIVATE` — the Darwin VM workaround

The mmap flag depends on the backend. From `ds4.c:1229-1241`:

```c
/*
 * Metal wraps slices of this mapping as no-copy MTLBuffers, so the Metal
 * path keeps the file-backed shared mapping. The CPU path only reads the
 * weights through normal pointers and should not inherit Metal's VM policy:
 * use a private read-only mapping there.
 *
 * This is deliberately defensive against an OS-level Darwin VM bug observed
 * while the CPU backend streams the very large GGUF through a shared mmap:
 * the kernel can panic in VM map-count accounting instead of returning a
 * normal user-space failure. Keeping CPU inference off the shared mapping
 * avoids that VM accounting path while preserving normal file-backed reads.
 */
const int mmap_flags = metal_mapping ? MAP_SHARED : MAP_PRIVATE;
```

The decision tree:

- **Metal or CUDA backend** → `MAP_SHARED`. The GPU layer can wrap shared pages without copy; this is the cheapest path.
- **CPU backend** → `MAP_PRIVATE`. The kernel keeps a private copy-on-write view; the pages still come from the file, but the kernel's VM accounting goes through a different (less buggy) path.

The Darwin VM bug `AGENT.md` and the comment refer to was an actual kernel panic observed during CPU prefill on macOS. The fix is operational: keep CPU inference off the shared mapping. This is the kind of detail that does not appear in any GGUF spec but is forced by the realities of running a model at this scale.

For Linux + CUDA, `MAP_SHARED` is fine — the CUDA path has its own dance (section 5) for moving bytes to device memory.

### 2.5 The single tokenizer-only path

There is a third caller of `model_open` that does not go through `ds4_engine_open`: the tokenizer-only diagnostic, `ds4_dump_text_tokenization` (`ds4.h:125`). It loads just the vocab without preloading tensors, by passing `prefetch_cpu = false`. This is what `./ds4 --dump-tokens` uses; it lets you inspect tokenization without paying the 80 GB page-fault cost. The flag exists exactly because mmap is lazy — opening a model without `prefetch_cpu` is essentially free as long as you only touch the metadata.

---

## 3. Parsing the Metadata Table

### 3.1 The cursor abstraction

All GGUF parsing goes through a small cursor type (`ds4.c:404-409`):

```c
typedef struct {
    const uint8_t *base;
    uint64_t size;
    uint64_t pos;
    char error[256];
} ds4_cursor;
```

`cursor_at(m, pos)` (`ds4.c:1033-1041`) builds one pointed at any offset in the mmap. `cursor_u32`, `cursor_u64`, `cursor_string`, `cursor_read` advance the cursor, bounds-checking against `size`. On any error the cursor stores a message in `error` and the caller calls `ds4_die(c.error)`.

This is a careful design: GGUF parsing must be robust against malformed files. A buggy reader could read past the end of the mmap (segfault) or compute a wrong offset (silent garbage). The cursor's bounds checks guard against both. Every advance returns false and sets `error` if it would walk off the end.

### 3.2 What `parse_metadata` does

`parse_metadata` (`ds4.c:1134-1160`) walks the KV table once, recording each entry's key, type tag, and **the offset of its value** without actually decoding the value:

```c
static void parse_metadata(ds4_model *m, ds4_cursor *c) {
    m->kv = calloc((size_t)m->n_kv, sizeof(m->kv[0]));
    if (!m->kv) ds4_die("out of memory while allocating metadata table");

    m->alignment = 32;

    for (uint64_t i = 0; i < m->n_kv; i++) {
        ds4_kv *kv = &m->kv[i];

        if (!cursor_string(c, &kv->key)) ds4_die(c->error);
        if (!cursor_u32(c, &kv->type)) ds4_die(c->error);

        kv->value_pos = c->pos;

        if (ds4_streq(kv->key, "general.alignment") &&
            kv->type == GGUF_VALUE_UINT32)
        {
            ds4_cursor tmp = cursor_at(m, kv->value_pos);
            uint32_t alignment;
            if (cursor_u32(&tmp, &alignment) && alignment != 0) {
                m->alignment = alignment;
            }
        }

        if (!skip_value(c, kv->type, 0)) ds4_die(c->error);
    }
}
```

The key data structure is `ds4_kv` (`ds4.c:919-923`):

```c
typedef struct {
    ds4_str key;        /* ptr points into mmap; no copy */
    uint32_t type;
    uint64_t value_pos; /* offset of the encoded value in the file */
} ds4_kv;
```

Three design decisions worth highlighting:

- **Values are not decoded.** The KV index is just `(key, type, value_offset)`. Later code that needs a particular key calls `model_get_u32(m, "deepseek4.embedding_length", &v)` (`ds4.c:1057-1062`), which finds the key, builds a temporary cursor at `value_pos`, and decodes on demand. This keeps the metadata index tiny — about 32 bytes per entry independent of value size.
- **Keys reference into the mmap.** `ds4_str` (`ds4.c:397-400`) is a pointer plus a length. The pointer is the location of the key bytes inside the mmap. No string is copied; comparisons go through `ds4_streq` (`ds4.c:429-432`).
- **`general.alignment` is special-cased.** It is the *only* metadata key that has to be read during the metadata pass, because it controls where the tensor data region starts. The code reads it inline and stores the result on `ds4_model`.

The `skip_value` helper (`ds4.c`) implements per-type advance: scalars step forward by a fixed width; strings read a `u64` length and skip; arrays read the element type and length and recurse. This is the only piece of GGUF that requires understanding the variable-length encoding rules.

### 3.3 Cost vs. file size

The KV table has a few hundred entries for DS4 GGUFs. `parse_metadata` walks it once, doing pointer arithmetic and one comparison per entry. Cost: a few hundred microseconds. The whole point of the lazy-decode design is that opening a model is fast regardless of how much metadata it carries.

---

## 4. Parsing the Tensor Directory

### 4.1 What `parse_tensors` does

`parse_tensors` (`ds4.c:1164-1211`) walks the tensor directory and converts each entry to an in-memory `ds4_tensor`:

```c
static void parse_tensors(ds4_model *m, ds4_cursor *c) {
    m->tensors = calloc((size_t)m->n_tensors, sizeof(m->tensors[0]));
    if (!m->tensors) ds4_die("out of memory while allocating tensor table");

    for (uint64_t i = 0; i < m->n_tensors; i++) {
        ds4_tensor *t = &m->tensors[i];

        if (!cursor_string(c, &t->name)) ds4_die(c->error);
        if (!cursor_u32(c, &t->ndim)) ds4_die(c->error);
        if (t->ndim == 0 || t->ndim > DS4_MAX_DIMS) {
            ds4_die("tensor has an unsupported number of dimensions");
        }

        t->elements = 1;
        for (uint32_t d = 0; d < t->ndim; d++) {
            if (!cursor_u64(c, &t->dim[d])) ds4_die(c->error);
            if (t->dim[d] != 0 && t->elements > UINT64_MAX / t->dim[d]) {
                ds4_die("tensor element count overflow");
            }
            t->elements *= t->dim[d];
        }

        if (!cursor_u32(c, &t->type)) ds4_die(c->error);
        if (!cursor_u64(c, &t->rel_offset)) ds4_die(c->error);

        if (!tensor_nbytes(t->type, t->elements, &t->bytes)) {
            ds4_log(stderr,
                DS4_LOG_WARNING,
                "ds4: warning: tensor %.*s has unsupported GGUF type %u\n",
                (int)t->name.len, t->name.ptr, t->type);
        }
    }

    m->tensor_data_pos = align_up(c->pos, m->alignment);

    for (uint64_t i = 0; i < m->n_tensors; i++) {
        ds4_tensor *t = &m->tensors[i];
        if (t->rel_offset > UINT64_MAX - m->tensor_data_pos) {
            ds4_die("tensor offset overflow");
        }
        t->abs_offset = m->tensor_data_pos + t->rel_offset;
        if (t->bytes != 0 &&
            (t->abs_offset > m->size || t->bytes > m->size - t->abs_offset))
        {
            ds4_die("tensor points outside GGUF file");
        }
    }
}
```

Two passes:

1. **First pass (lines 1168-1195):** read each entry, fill in name, ndim, dims, type, rel_offset. Compute `elements` (product of dims, overflow-checked) and `bytes` (via `tensor_nbytes`).
2. **Second pass (lines 1199-1210):** now that `tensor_data_pos` is known, convert each `rel_offset` into an `abs_offset` and bounds-check it against the mmap size.

The two-pass structure exists because `tensor_data_pos` cannot be known until the directory is fully parsed (you need the cursor position after the last tensor entry plus the alignment padding). Computing absolute offsets in a second pass keeps the code clear.

`align_up` (`ds4.c:840-844`) is a single-line helper:

```c
static uint64_t align_up(uint64_t value, uint64_t alignment) {
    if (alignment <= 1) return value;
    const uint64_t mask = alignment - 1;
    return (value + mask) & ~mask;
}
```

### 4.2 `tensor_nbytes` and the type table

The mapping from tensor type code to byte size lives in `gguf_types[]` (`ds4.c:877-907`):

```c
static const gguf_type_info gguf_types[] = {
    [0]  = {"f32",      1,   4},
    [1]  = {"f16",      1,   2},
    [2]  = {"q4_0",    32,  18},
    [3]  = {"q4_1",    32,  20},
    /* ... */
    [8]  = {"q8_0",    32,  34},
    [10] = {"q2_k",   256,  84},
    [12] = {"q4_k",   256, 144},
    [15] = {"q8_k",   256, 292},
    [16] = {"iq2_xxs",256,  66},
    /* ... */
    [26] = {"i32",      1,   4},
};
```

Each entry says: tensor type X groups elements into blocks of `block_elems`, and each block takes `block_bytes` bytes. `tensor_nbytes` (`ds4.c:1024-1031`) divides total elements by block size, rounds up, multiplies by block bytes:

```c
static bool tensor_nbytes(uint32_t type, uint64_t elements, uint64_t *bytes) {
    const gguf_type_info *info = tensor_type(type);
    if (!info || info->block_elems == 0) return false;
    uint64_t blocks = (elements + info->block_elems - 1) / info->block_elems;
    if (blocks > UINT64_MAX / info->block_bytes) return false;
    *bytes = blocks * info->block_bytes;
    return true;
}
```

A 4096x2048 IQ2_XXS routed expert tensor has `8.4 M` elements, which is `32768` blocks of 256 elements each, taking `32768 * 66 = 2.16 MB` of storage. A single Q8_0 attention projection of 4096x1024 has `4.2 M` elements, `131072` blocks, `131072 * 34 = 4.46 MB`. These are the per-tensor bytes that `parse_tensors` records.

### 4.3 `ds4_tensor` as the canonical handle

After `parse_tensors`, the engine has an array of `ds4_tensor` values, one per tensor in the GGUF. Subsequent code looks up tensors by name (next section), but never re-parses the directory. The directory has been *consumed*; the in-memory `ds4_tensor` table is the source of truth.

Two `ds4_tensor` fields matter for the rest of the engine:

- `abs_offset` — the absolute byte offset into the mmap. `tensor_data(model, t)` (`ds4.c:1493-1495`) returns `m->map + t->abs_offset`.
- `bytes` — the byte size of the tensor. Used by GPU upload paths to know how big a buffer view to create.

`type` and `dim[]` are used by validators; `name`, `elements`, `rel_offset` are mostly diagnostic.

---

## 5. mmap and the Backends

### 5.1 The CPU path: direct pointer access

CPU inference reads weights through plain pointers. `tensor_data` (`ds4.c:1493-1495`) is a one-liner:

```c
static const void *tensor_data(const ds4_model *m, const ds4_tensor *t) {
    return m->map + t->abs_offset;
}
```

The matrix-multiply kernels, the attention kernels, the MoE dispatch — all of them call `tensor_data(model, layer->some_tensor)` and dereference. There is no abstraction between the mmap and the kernel. This is the lightest possible path and the reason the CPU code is the trustworthy reference.

The CPU backend also issues a courtesy `posix_madvise(MADV_WILLNEED)` over the whole mapping after parsing the directory. `model_prefetch_cpu_mapping` (`ds4.c:1108-1130`):

```c
static void model_prefetch_cpu_mapping(const ds4_model *m) {
    if (!m || !m->map || m->size == 0) return;

    /*
     * CPU generation touches expert weights according to router decisions, so a
     * long decode can fault in model pages that the prompt never touched. On
     * current Darwin kernels we have seen those late file-backed faults trigger
     * an OS-level VM panic in map-count accounting. This hint does not copy or
     * pin the GGUF; it just asks the kernel to start bringing the read-only
     * mapping into the page cache before token generation reaches it.
     */
#if defined(POSIX_MADV_WILLNEED)
    const int rc = posix_madvise((void *)m->map, (size_t)m->size, POSIX_MADV_WILLNEED);
    /* ... log on failure ... */
#endif
}
```

This is not a copy. The kernel is free to ignore the hint. But on Darwin it pushes the kernel to start streaming pages in before the router picks an unexpected expert that nobody touched in the prompt — and that hopefully avoids the late page-fault that exposed the VM bug. It is a workaround, openly documented as such.

### 5.2 The Metal path: zero-copy `MTLBuffer` views

Apple Silicon has unified memory: the GPU sees the same physical pages as the CPU. The Metal backend exploits this by creating `MTLBuffer` views that point directly at the mmap'ed weight bytes.

The wrap call lives in `ds4_metal.m`. The relevant pattern (search `newBufferWithBytesNoCopy` in `ds4_metal.m:508`):

```objc
id<MTLBuffer> buffer = [g_device newBufferWithBytesNoCopy:(void *)(model_addr + page_model_offset + off)
                                                   length:(NSUInteger)bytes
                                                  options:MTLResourceStorageModeShared
                                              deallocator:nil];
```

`newBufferWithBytesNoCopy` plus `MTLResourceStorageModeShared` says: "make a buffer that wraps these existing bytes, and let GPU and CPU share them." No copy happens; no kernel data ever leaves the file-backed page. The Metal API needs an aligned address and possibly a maximum-buffer-length limit (Metal has a per-buffer cap), so `ds4_metal.m` may register multiple overlapping buffer views to cover the entire model.

The Metal init is triggered from `ds4_engine_open` (`ds4.c:17710-17714`):

```c
(void)ds4_gpu_set_model_fd(e->model.fd);
if (!ds4_gpu_set_model_map_range(e->model.map,
                                   e->model.size,
                                   e->model.tensor_data_pos,
                                   e->model.size - e->model.tensor_data_pos))
{
    /* ... abort engine init ... */
}
```

`ds4_gpu_set_model_map_range` hands the backend the mmap base, total size, and the tensor data sub-region. The backend can then either wrap that range (Metal) or upload it to device memory (CUDA).

### 5.3 The CUDA path: staged uploads with optional zero-copy

CUDA hosts do not have unified memory in the Apple Silicon sense. The CUDA backend has to get the bytes to the GPU. `ds4_cuda.cu:228-294` (and surrounding code) implements a tiered strategy:

1. **Cached device pointer.** If the same offset+length has already been registered for the GPU, return the existing device pointer.
2. **`cudaHostRegister` for mapped pinned memory** (preferred when the host driver supports ATS/HMM). The mmap pages are marked pinned and host-accessible from the device. `cudaHostGetDevicePointer` returns a device pointer that aliases the same memory. The GPU access still walks PCIe (or NVLink/NVSwitch on DGX-class hardware), but no copy is made.
   ```c
   /* ds4_cuda.cu:242 */
   err = cudaHostRegister((void *)reg_addr,
                          ...,
                          cudaHostRegisterMapped | cudaHostRegisterReadOnly);
   ```
3. **`cudaMalloc` + `cudaMemcpy` fallback.** When mapped pinning is not available, the backend allocates device memory and streams the tensor bytes up. This is the explicit copy path.

On DGX Spark / GB10 (the primary CUDA target per `MODEL_CARD.md` and `Makefile:84`) the high-bandwidth coherent path is available, so most of the model stays in host memory and the GPU pages it in over the coherent interconnect.

There is also a `cudaMallocHost` path for staging buffers (`ds4_cuda.cu:857, 1118`) used when streaming chunks during initialization.

The CUDA path is much more complicated than Metal because the API surface is wider and the underlying memory model is more flexible. But from `ds4.c`'s perspective the difference is opaque: it calls `ds4_gpu_set_model_map_range` and gets back success or failure. The kernels later call `ds4_gpu_*` helpers that resolve the right device-side address.

### 5.4 Why this design avoids the alternative

The alternative is to read the GGUF into a malloc buffer at startup. The Metal path would then have to copy from the buffer to a device buffer. The CUDA path would have an extra copy from buffer to host pinned staging to device. Both paths would lose the page-cache sharing across processes and across runs.

By keeping the file mmap as the single source of truth, ds4:

- Pays one disk read at first access per page, amortized by `MADV_WILLNEED` and by the prompt's natural page-walk pattern.
- Lets the kernel page cache deduplicate across runs of the same model (a relaunch of ds4 on the same GGUF reuses warm pages).
- Avoids any user-space buffer for weight bytes.

The cost is the platform-specific complexity in the backend code; the benefit is that `ds4.c`'s view of the model never changes — it is always a base pointer plus per-tensor offsets.

---

## 6. Optional Warm-Up: Faulting Every Page Up Front

`model_warm_weights` (`ds4.c:1498-1523`) is an optional pass that touches every page of the tensor-data region to bring it into the page cache before timing starts:

```c
static void model_warm_weights(const ds4_model *m) {
    const uint64_t start = m->tensor_data_pos;
    const uint64_t end = m->size;
    if (start >= end) return;

    const uint64_t page = (uint64_t)sysconf(_SC_PAGESIZE);
    const uint8_t *p = m->map;
    volatile uint64_t checksum = 0;
    const double t0 = now_sec();

    fprintf(stderr, "ds4: warming mapped tensor pages: %.2f GiB\n",
            (double)(end - start) / (1024.0 * 1024.0 * 1024.0));

#if defined(POSIX_MADV_WILLNEED)
    (void)posix_madvise((void *)(p + start), (size_t)(end - start), POSIX_MADV_WILLNEED);
#endif

    for (uint64_t off = start; off < end; off += page) {
        checksum += p[off];
    }
    checksum += p[end - 1];

    const double t1 = now_sec();
    fprintf(stderr, "ds4: warmed tensor pages in %.3fs (checksum=%llu)\n",
            t1 - t0, (unsigned long long)checksum);
}
```

Notable details:

- It touches only `[tensor_data_pos, size)` — the tensor bytes, not the header or directory.
- `posix_madvise(MADV_WILLNEED)` advises the kernel to prefetch the range.
- The page-stride loop forces every page to be mapped to a physical frame (the read triggers a minor page fault and the kernel resolves it from the file).
- `volatile uint64_t checksum` prevents the compiler from optimising the loop away, since each read must be observable.

Whether to use it is a workload question. From `ds4.h:73`:

```c
bool warm_weights;
```

Set true from the bench binary by default (`ds4_bench.c:404`); the CLI exposes no flag for it. The reason is workload mismatch: benchmark wants a steady-state measurement, so the first-fault latency should not pollute the numbers. Interactive use does not benefit because conversation traffic naturally spreads page faults out over many tokens.

`model_warm_weights` is called only when `opt->warm_weights == true`, and that gating happens in `ds4_engine_open` at line 17665:

```c
if (opt->warm_weights) model_warm_weights(&e->model);
```

---

## 7. Validating the Loaded Model

Two layers of validation happen after the file is mapped. They run in a deliberate order: shape first (does this look like the right model?), then per-tensor layout (do the tensors match the binding contract?).

### 7.1 `config_validate_model`: metadata equality

`config_validate_model` (`ds4.c:2585-2667`) reads every architecture-relevant metadata key and compares it against a hard-coded constant. The body is a long sequence of:

```c
config_expect_u32("embedding_length",  n_embd,        DS4_N_EMBD);
config_expect_u32("attention.head_count", n_head,     DS4_N_HEAD);
config_expect_u32("attention.key_length", n_head_dim, DS4_N_HEAD_DIM);
config_expect_u32("expert_count",      n_expert,      DS4_N_EXPERT);
config_expect_u32("expert_used_count", n_expert_used, DS4_N_EXPERT_USED);
config_expect_u32("hash_layer_count",  n_hash_layer,  DS4_N_HASH_LAYER);
config_expect_u32("attention.sliding_window", n_swa,  DS4_N_SWA);
config_expect_u32("hyper_connection.count", n_hc,     DS4_N_HC);
config_expect_f32("rope.freq_base",    rope_freq_base, DS4_ROPE_FREQ_BASE);
config_expect_f32("rope.scaling.factor", rope_scale,  DS4_ROPE_SCALE_FACTOR);
config_expect_f32("expert_weights_scale", ew_scale,   DS4_EXPERT_WEIGHT_SCALE);
/* ... and more ... */
```

Where each `config_expect_u32` (`ds4.c:2557-2562`) is:

```c
static void config_expect_u32(const char *name, uint32_t got, uint32_t expected) {
    if (got == expected) return;
    fprintf(stderr, "ds4: expected %s=%u for DeepSeek4 Flash, got %u\n",
            name, expected, got);
    exit(1);
}
```

A single byte off in any of these keys is fatal. The point is to catch the "I tried to load a different model" scenario at the earliest possible time. Without this, a generic GGUF that happens to have the wrong number of layers might still load through `weights_bind` (it has `blk.0.attn_q_a.weight` and so on) and silently produce garbage tokens.

The function also calls two array validators:

- `validate_compress_ratio_metadata` (`ds4.c:2495-2527`) reads `deepseek4.attention.compress_ratios` and verifies that the per-layer values match `ds4_layer_compress_ratio(il)` (which returns 0 for layers 0-1, 4 for even layers from 2, 128 for odd layers from 3).
- `validate_swiglu_clamp_metadata` (`ds4.c:2531-2555`) reads `deepseek4.swiglu_clamp_exp` and verifies that every entry equals `DS4_SWIGLU_CLAMP_EXP = 10.0`.

Both treat any mismatch as fatal.

### 7.2 `weights_validate_layout`: type and shape check

After `weights_bind` resolves names to pointers (next section), `weights_validate_layout` (`ds4.c:2378-2447`) walks every bound tensor and checks the type and shape against the expected layout. The validator is a flat sequence of `tensor_expect_layout` calls:

```c
tensor_expect_layout(w->token_embd,      DS4_TENSOR_F16,  2, DS4_N_EMBD, DS4_N_VOCAB, 0);
tensor_expect_layout(w->output_hc_base,  DS4_TENSOR_F32,  1, DS4_N_HC, 0, 0);
tensor_expect_layout(w->output_hc_fn,    DS4_TENSOR_F16,  2, hc_dim, DS4_N_HC, 0);
tensor_expect_layout(w->output_hc_scale, DS4_TENSOR_F32,  1, 1, 0, 0);
tensor_expect_layout(w->output_norm,     DS4_TENSOR_F32,  1, DS4_N_EMBD, 0, 0);
tensor_expect_layout(w->output,          DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_VOCAB, 0);

for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
    const ds4_layer_weights *l = &w->layer[il];
    const uint32_t ratio = ds4_layer_compress_ratio(il);

    tensor_expect_layout(l->hc_attn_fn,     DS4_TENSOR_F16,  2, hc_dim, hc_mix_dim, 0);
    tensor_expect_layout(l->attn_norm,      DS4_TENSOR_F32,  1, DS4_N_EMBD, 0, 0);
    tensor_expect_layout(l->attn_q_a,       DS4_TENSOR_Q8_0, 2, DS4_N_EMBD, DS4_N_LORA_Q, 0);
    /* ... ~30 more per layer ... */
}
```

`tensor_expect_layout` (`ds4.c:2247-2286`) is straightforward:

```c
static void tensor_expect_layout(
        const ds4_tensor *t,
        uint32_t          type,
        uint32_t          ndim,
        uint64_t          d0,
        uint64_t          d1,
        uint64_t          d2) {
    if (!t) ds4_die("internal error: missing tensor while validating layout");
    if (t->type != type) {
        fprintf(stderr,
                "ds4: tensor %.*s has type %s, expected %s\n",
                (int)t->name.len, t->name.ptr,
                tensor_type_name(t->type), tensor_type_name(type));
        exit(1);
    }
    /* ndim check, dim[i] check, all fatal on mismatch */
}
```

Variants:

- `tensor_expect_optional` (`ds4.c:2288-2296`) — same as above, but accepts a NULL tensor (used for `ffn_exp_probs_b`).
- `tensor_expect_plain_layout` (`ds4.c:2298-2314`) — accepts either F16 or F32 for the type, then validates ndim and dims. Used for MTP HC head tensors that may be either precision.
- `tensor_expect_routed_expert` (`ds4.c:2337-2374`) — accepts any of IQ2_XXS / Q2_K / Q4_K, then validates ndim and dims. The validator additionally requires that `gate_exps` and `up_exps` share the same type (`ds4.c:2436-2439`):
  ```c
  if (l->ffn_gate_exps->type != l->ffn_up_exps->type) {
      fprintf(stderr, "ds4: routed gate/up experts use different quant types in layer %u\n", il);
      exit(1);
  }
  ```

This is where the asymmetric-quantization design from Chapter 02 gets enforced: gate and up must share a quant type so the kernel can dispatch them identically; down is independent.

### 7.3 What the layered validation catches

| Failure mode | Caught by |
|--------------|-----------|
| Magic bytes wrong | `model_open` (`ds4.c:1252`) |
| GGUF v2 file | `model_open` (`ds4.c:1257`) |
| File truncated mid-tensor | `parse_tensors` bounds check (`ds4.c:1205-1208`) |
| Wrong model architecture (different number of layers, heads, etc.) | `config_validate_model` |
| Wrong tensor type (e.g. Q4_0 routed expert when Q2_K was expected) | `weights_validate_layout` via `tensor_expect_routed_expert` |
| Wrong tensor shape (e.g. wrong vocab size) | `weights_validate_layout` |
| Missing required tensor (e.g. `blk.5.attn_q_b.weight` not in the file) | `weights_bind` via `required_tensor` |
| Missing required metadata key | `config_validate_model` via `required_u32` (`ds4.c:2150-2157`) |
| Mismatched gate/up quant types | `weights_validate_layout` (`ds4.c:2436-2439`) |

In all cases the failure is a printed error and `exit(1)`. There is no fallback, no warning-and-continue. `AGENT.md:14` is the policy: "Preserve correctness before speed. Do not keep a faster path with unexplained attention, KV cache, or logits drift." That extends to the loader. A model that does not match the expected layout is a different model, not a degraded one.

---

## 8. Binding Tensor Names to Per-Layer Pointers

### 8.1 Why bind at all

The GGUF tensor directory is a flat array of `(name, type, dims, offset)` tuples. The inference code wants to talk about `layer 17's attention KV projection`, not `the tensor with name "blk.17.attn_kv.weight"`. Doing a string lookup per kernel call would be both slow and ugly.

`weights_bind` (`ds4.c:2671-2729`) translates the GGUF directory into a `ds4_weights` struct whose fields are typed pointers to `ds4_tensor`s. After this point, the inference code says `layer->attn_kv` and gets back a pointer; the pointer was resolved once at engine-open.

### 8.2 The binding loop

```c
static void weights_bind(ds4_weights *w, const ds4_model *m) {
    memset(w, 0, sizeof(*w));
    w->token_embd       = required_tensor(m, "token_embd.weight");
    w->output_hc_base   = required_tensor(m, "output_hc_base.weight");
    w->output_hc_fn     = required_tensor(m, "output_hc_fn.weight");
    w->output_hc_scale  = required_tensor(m, "output_hc_scale.weight");
    w->output_norm      = required_tensor(m, "output_norm.weight");
    w->output           = required_tensor(m, "output.weight");

    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        ds4_layer_weights *l = &w->layer[il];
        const uint32_t compress_ratio = ds4_layer_compress_ratio(il);

        l->hc_attn_fn      = required_tensorf(m, "blk.%u.hc_attn_fn.weight", il);
        l->hc_attn_scale   = required_tensorf(m, "blk.%u.hc_attn_scale.weight", il);
        l->hc_attn_base    = required_tensorf(m, "blk.%u.hc_attn_base.weight", il);
        l->attn_norm       = required_tensorf(m, "blk.%u.attn_norm.weight", il);
        l->attn_q_a        = required_tensorf(m, "blk.%u.attn_q_a.weight", il);
        l->attn_q_a_norm   = required_tensorf(m, "blk.%u.attn_q_a_norm.weight", il);
        l->attn_q_b        = required_tensorf(m, "blk.%u.attn_q_b.weight", il);
        l->attn_kv         = required_tensorf(m, "blk.%u.attn_kv.weight", il);
        l->attn_kv_a_norm  = required_tensorf(m, "blk.%u.attn_kv_a_norm.weight", il);
        l->attn_sinks      = required_tensorf(m, "blk.%u.attn_sinks.weight", il);
        l->attn_output_a   = required_tensorf(m, "blk.%u.attn_output_a.weight", il);
        l->attn_output_b   = required_tensorf(m, "blk.%u.attn_output_b.weight", il);
        if (compress_ratio != 0) {
            l->attn_compressor_ape  = required_tensorf(m, "blk.%u.attn_compressor_ape.weight", il);
            l->attn_compressor_kv   = required_tensorf(m, "blk.%u.attn_compressor_kv.weight", il);
            l->attn_compressor_gate = required_tensorf(m, "blk.%u.attn_compressor_gate.weight", il);
            l->attn_compressor_norm = required_tensorf(m, "blk.%u.attn_compressor_norm.weight", il);
        }
        if (compress_ratio == 4) {
            l->indexer_attn_q_b = required_tensorf(m, "blk.%u.indexer.attn_q_b.weight", il);
            l->indexer_proj     = required_tensorf(m, "blk.%u.indexer.proj.weight", il);
            l->indexer_compressor_ape  = required_tensorf(m, "blk.%u.indexer_compressor_ape.weight", il);
            l->indexer_compressor_kv   = required_tensorf(m, "blk.%u.indexer_compressor_kv.weight", il);
            l->indexer_compressor_gate = required_tensorf(m, "blk.%u.indexer_compressor_gate.weight", il);
            l->indexer_compressor_norm = required_tensorf(m, "blk.%u.indexer_compressor_norm.weight", il);
        }
        l->hc_ffn_fn       = required_tensorf(m, "blk.%u.hc_ffn_fn.weight", il);
        l->hc_ffn_scale    = required_tensorf(m, "blk.%u.hc_ffn_scale.weight", il);
        l->hc_ffn_base     = required_tensorf(m, "blk.%u.hc_ffn_base.weight", il);
        l->ffn_norm        = required_tensorf(m, "blk.%u.ffn_norm.weight", il);
        l->ffn_gate_inp    = required_tensorf(m, "blk.%u.ffn_gate_inp.weight", il);
        l->ffn_exp_probs_b = tensor_by_namef(m, "blk.%u.exp_probs_b.bias", il);
        l->ffn_gate_exps   = required_tensorf(m, "blk.%u.ffn_gate_exps.weight", il);
        l->ffn_up_exps     = required_tensorf(m, "blk.%u.ffn_up_exps.weight", il);
        l->ffn_down_exps   = required_tensorf(m, "blk.%u.ffn_down_exps.weight", il);
        l->ffn_gate_shexp  = required_tensorf(m, "blk.%u.ffn_gate_shexp.weight", il);
        l->ffn_up_shexp    = required_tensorf(m, "blk.%u.ffn_up_shexp.weight", il);
        l->ffn_down_shexp  = required_tensorf(m, "blk.%u.ffn_down_shexp.weight", il);

        if (il < DS4_N_HASH_LAYER) {
            l->ffn_gate_tid2eid = required_tensorf(m, "blk.%u.ffn_gate_tid2eid.weight", il);
        }
    }

    weights_validate_layout(w);
}
```

Notice three things:

- **Two flavours of lookup.** `required_tensor` (`ds4.c:2224-2231`) and `required_tensorf` (`ds4.c:2240-2245`) both call `ds4_die` if the tensor is missing. `tensor_by_namef` (`ds4.c:2233-2238`) returns NULL on a miss and is used only for the optional `exp_probs_b.bias`.
- **Per-layer optionality is explicit.** The compressor tensors are bound only for layers with `compress_ratio != 0`. The indexer tensors are bound only for `compress_ratio == 4`. The hash-routing table is bound only for `il < DS4_N_HASH_LAYER`. The shape of the model is encoded in the binding, not in some other configuration file.
- **The last line calls `weights_validate_layout(w)`.** Binding without validation would be unsafe; the validator runs immediately so the layer pointers are guaranteed correct before any kernel sees them.

### 8.3 The lookup primitive

`model_find_tensor` (`ds4.c:1355-1364`) is a linear scan:

```c
static ds4_tensor *model_find_tensor(const ds4_model *m, const char *name) {
    const size_t len = strlen(name);
    for (uint64_t i = 0; i < m->n_tensors; i++) {
        if (m->tensors[i].name.len == len &&
            memcmp(m->tensors[i].name.ptr, name, len) == 0) {
            return &m->tensors[i];
        }
    }
    return NULL;
}
```

There is no hash table. The whole binding does about `(6 + 43 * 30) ≈ 1300` linear scans through a directory of about 1300 entries — a total of ~1.7 million `memcmp` calls. Each `memcmp` is ~20 bytes. The total cost is microseconds; the simplicity is worth more than the speedup a hash table would provide.

### 8.4 The bound `ds4_weights` struct

The struct definitions are at `ds4.c:2080-2126`:

```c
typedef struct {
    /* HC */
    ds4_tensor *hc_attn_fn;
    ds4_tensor *hc_attn_scale;
    ds4_tensor *hc_attn_base;
    /* attention */
    ds4_tensor *attn_norm;
    ds4_tensor *attn_q_a;
    ds4_tensor *attn_q_a_norm;
    ds4_tensor *attn_q_b;
    ds4_tensor *attn_kv;
    ds4_tensor *attn_kv_a_norm;
    ds4_tensor *attn_sinks;
    ds4_tensor *attn_output_a;
    ds4_tensor *attn_output_b;
    /* compressor (ratio != 0) */
    ds4_tensor *attn_compressor_ape;
    ds4_tensor *attn_compressor_kv;
    ds4_tensor *attn_compressor_gate;
    ds4_tensor *attn_compressor_norm;
    /* indexer (ratio == 4) */
    ds4_tensor *indexer_attn_q_b;
    ds4_tensor *indexer_proj;
    ds4_tensor *indexer_compressor_ape;
    ds4_tensor *indexer_compressor_kv;
    ds4_tensor *indexer_compressor_gate;
    ds4_tensor *indexer_compressor_norm;
    /* HC */
    ds4_tensor *hc_ffn_fn;
    ds4_tensor *hc_ffn_scale;
    ds4_tensor *hc_ffn_base;
    /* FFN */
    ds4_tensor *ffn_norm;
    ds4_tensor *ffn_gate_tid2eid;
    ds4_tensor *ffn_gate_inp;
    ds4_tensor *ffn_exp_probs_b;
    ds4_tensor *ffn_gate_exps;
    ds4_tensor *ffn_up_exps;
    ds4_tensor *ffn_down_exps;
    ds4_tensor *ffn_gate_shexp;
    ds4_tensor *ffn_up_shexp;
    ds4_tensor *ffn_down_shexp;
} ds4_layer_weights;

typedef struct {
    ds4_tensor *token_embd;
    ds4_tensor *output_hc_base;
    ds4_tensor *output_hc_fn;
    ds4_tensor *output_hc_scale;
    ds4_tensor *output_norm;
    ds4_tensor *output;
    ds4_layer_weights layer[DS4_N_LAYER];
} ds4_weights;
```

Every pointer is either NULL (legitimately, for optional / conditional tensors) or a stable pointer into the `ds4_model::tensors` array. The pointers are never reassigned after `weights_bind`.

### 8.5 MTP binding

If `--mtp <path>` is set, the engine repeats the load sequence for the MTP draft model. `mtp_weights_bind` (`ds4.c:2731+`) is a parallel binding routine that looks up names prefixed with `mtp.0.*`:

```c
w->hc_head_base  = required_tensor(m, "mtp.0.hc_head_base.weight");
w->hc_head_fn    = required_tensor(m, "mtp.0.hc_head_fn.weight");
w->hc_head_scale = required_tensor(m, "mtp.0.hc_head_scale.weight");
w->e_proj        = required_tensor(m, "mtp.0.e_proj.weight");
w->h_proj        = required_tensor(m, "mtp.0.h_proj.weight");
/* ... and a full ds4_layer_weights block with mtp.0. prefix ... */
```

The MTP model is its own `ds4_model` (with its own mmap'ed file), bound into its own `ds4_mtp_weights`. The main and MTP models share nothing in memory except the engine handle.

---

## 9. The Full Load Sequence

Putting all the pieces together, here is what happens when `ds4_engine_open` is called:

<svg viewBox="0 0 820 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine_open call sequence from instance lock through mmap, parse, validate, bind to GPU init">
<defs>
<marker id="ar32" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="410" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">ds4_engine_open() load sequence</text>
<rect x="270" y="36" width="280" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="410" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">ds4_engine_open</text>
<text x="410" y="68" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:17636 - option validation + lock + dispatch</text>
<line x1="410" y1="72" x2="410" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="40" y="88" width="240" height="48" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="160" y="108" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">ds4_acquire_instance_lock</text>
<text x="160" y="124" text-anchor="middle" font-size="10" fill="#64748b">flock /tmp/ds4.lock - ds4.c:16014</text>
<rect x="290" y="88" width="240" height="48" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="410" y="108" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">model_open</text>
<text x="410" y="124" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:1217 - open, fstat, mmap, parse</text>
<rect x="540" y="88" width="240" height="48" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="660" y="108" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">model_warm_weights (optional)</text>
<text x="660" y="124" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:1498 - page-walk if --warm</text>
<line x1="410" y1="136" x2="410" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="290" y="152" width="240" height="60" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="410" y="172" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">mmap MAP_SHARED or MAP_PRIVATE</text>
<text x="410" y="188" text-anchor="middle" font-size="10" fill="#64748b">graph backend gets MAP_SHARED</text>
<text x="410" y="202" text-anchor="middle" font-size="10" fill="#64748b">CPU backend gets MAP_PRIVATE (Darwin VM workaround)</text>
<line x1="410" y1="212" x2="410" y2="224" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="40" y="228" width="240" height="56" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="160" y="248" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">parse_metadata</text>
<text x="160" y="264" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:1134 - index n_kv (key, type, pos)</text>
<text x="160" y="278" text-anchor="middle" font-size="10" fill="#64748b">read general.alignment inline</text>
<rect x="290" y="228" width="240" height="56" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="6"/>
<text x="410" y="248" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">parse_tensors (two passes)</text>
<text x="410" y="264" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:1164 - name/ndim/dims/type</text>
<text x="410" y="278" text-anchor="middle" font-size="10" fill="#64748b">abs_offset = align_up + rel_offset</text>
<rect x="540" y="228" width="240" height="56" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="6"/>
<text x="660" y="248" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">model_prefetch_cpu_mapping</text>
<text x="660" y="264" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:1108 - posix_madvise WILLNEED</text>
<text x="660" y="278" text-anchor="middle" font-size="10" fill="#64748b">CPU backend only</text>
<line x1="410" y1="284" x2="410" y2="296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="290" y="300" width="240" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="410" y="320" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">vocab_load</text>
<text x="410" y="332" text-anchor="middle" font-size="10" fill="#64748b">decode tokenizer.ggml.tokens + merges</text>
<line x1="410" y1="336" x2="410" y2="348" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="290" y="352" width="240" height="60" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="410" y="372" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">config_validate_model</text>
<text x="410" y="388" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:2585 - every metadata key</text>
<text x="410" y="402" text-anchor="middle" font-size="10" fill="#64748b">vs DS4_N_* constants (mismatch -&gt; exit)</text>
<line x1="410" y1="412" x2="410" y2="424" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="290" y="428" width="240" height="60" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="410" y="448" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">weights_bind</text>
<text x="410" y="464" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:2671 - name -&gt; ds4_tensor*</text>
<text x="410" y="478" text-anchor="middle" font-size="10" fill="#64748b">weights_validate_layout (ds4.c:2378)</text>
<line x1="410" y1="488" x2="410" y2="500" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar32)"/>
<rect x="290" y="504" width="240" height="44" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="410" y="524" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">ds4_gpu_set_model_map_range</text>
<text x="410" y="538" text-anchor="middle" font-size="10" fill="#64748b">graph backends register buffer views</text>
<line x1="540" y1="466" x2="600" y2="466" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar32)"/>
<rect x="600" y="448" width="180" height="40" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2" rx="6"/>
<text x="690" y="466" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">if --mtp</text>
<text x="690" y="480" text-anchor="middle" font-size="10" fill="#64748b">repeat for draft model</text>
</svg>
<span class="figure-caption">Figure R3.2 | ds4_engine_open call sequence: instance lock, mmap-and-parse, optional warm-up, vocab load, metadata validation, tensor binding, then GPU backend registration.</span>

<details>
<summary>ASCII fallback</summary>

```
ds4_engine_open()                              ds4.c:17636
    |
    |-- option validation, defaults, steering
    |-- ds4_acquire_instance_lock()            ds4.c:16014
    |       flock /tmp/ds4.lock; refuse if another ds4 is running
    |
    |-- model_open(&e->model, ...)             ds4.c:1217
    |       |-- open(O_RDONLY) + fstat
    |       |-- mmap(MAP_SHARED | MAP_PRIVATE) decided by backend
    |       |-- header: magic, version (must be 3), n_tensors, n_kv
    |       |-- parse_metadata()               ds4.c:1134
    |       |       walk n_kv entries, record (key, type, value_pos)
    |       |       special-case "general.alignment"
    |       |-- parse_tensors()                ds4.c:1164
    |       |       walk n_tensors, fill name/ndim/dims/type/rel_offset
    |       |       compute tensor_data_pos = align_up(cursor, alignment)
    |       |       second pass: abs_offset = tensor_data_pos + rel_offset
    |       |       bounds-check each tensor against mmap size
    |       |-- model_prefetch_cpu_mapping()   ds4.c:1108 (CPU only)
    |               posix_madvise(MADV_WILLNEED) over the whole map
    |
    |-- model_warm_weights()                   ds4.c:1498 (if warm_weights)
    |       walk every page of the tensor data region
    |
    |-- vocab_load()
    |       read tokenizer entries (small)
    |
    |-- config_validate_model()                ds4.c:2585
    |       check every architectural metadata key against DS4_N_* constants
    |       validate_compress_ratio_metadata() ds4.c:2495
    |       validate_swiglu_clamp_metadata()   ds4.c:2531
    |       (any mismatch -> exit(1))
    |
    |-- weights_bind()                         ds4.c:2671
    |       resolve every tensor name to a ds4_tensor pointer
    |       (with per-layer conditionals for compressor / indexer / hash)
    |       weights_validate_layout()          ds4.c:2378
    |               type and shape check every bound tensor
    |
    |-- if (--mtp): model_open + mtp_weights_bind + mtp_weights_validate_layout
    |
    `-- ds4_gpu_init() + ds4_gpu_set_model_map_range()  (graph backends)
            backend-specific buffer-view registration
```

</details>

Time budget on a typical M3 Max 128GB with a warm page cache:

| Stage | Time |
|-------|------|
| `open`, `fstat`, `mmap` | < 1 ms |
| Header + metadata parse (lazy, no value decode) | ~0.5 ms |
| Tensor directory parse (two passes) | ~10 ms |
| `model_warm_weights` (if enabled) | ~5 s for 85 GB cold; ~0.5 s warm |
| `vocab_load` | ~5 ms |
| `config_validate_model` (decodes ~30 metadata keys) | ~1 ms |
| `weights_bind` (linear scans for ~1300 names) | ~50 ms |
| `weights_validate_layout` (~30 calls per layer x 43 layers) | ~2 ms |
| Metal backend init + buffer views | ~500 ms |

Total: ~600 ms cold (no warm-up), or ~5.5 s with warm-up of an 85 GB GGUF on cold disk. The bulk of opt-in delay is page faults; the unavoidable work is in the millisecond range.

---

## 10. Lifetime: When mmap Goes Away

The mmap is established once in `model_open` and remains live for the full lifetime of the `ds4_engine`. The kernel page cache holds whatever subset of the file the process has touched; under memory pressure pages are evicted (file-backed clean pages are the cheapest thing to evict, so they go first).

`ds4_engine_close` calls `model_close` (`ds4.c:1098`), which `munmap`s the region and closes the file descriptor. Any `MTLBuffer` views (Metal) or device pointers (CUDA) created against the mapping must be released before this; the backend handles that as part of its shutdown.

The instance lock (held since `ds4_acquire_instance_lock`) is released by an `atexit` handler installed at `ds4.c:16055`. This handler runs whether the process exits normally or abnormally, so a crash still releases the lock.

Across calls: each call to `ds4_engine_open` creates a fresh `ds4_engine` with its own `ds4_model` (and thus its own mmap). The OS-level page cache, however, is shared: if the same GGUF was open in a previous process, the pages are still in cache and the new process finds them warm without any cooperation from ds4. This is how a "restart and resume" workflow does not pay the cold-mmap tax.

---

## 11. Common Failure Modes

If `ds4_engine_open` does not return 0, one of a small set of things went wrong. The error messages are precise enough to diagnose from stderr alone:

| Message | Meaning | Likely fix |
|---------|---------|-----------|
| `cannot open model 'X': ...` | `open(2)` failed | path wrong, file deleted, permission issue |
| `model file is too small to be GGUF` | < 32 bytes | wrong file, truncated download |
| `model is not a GGUF file` | magic bytes wrong | file corrupted or wrong format |
| `only GGUF v3 is supported` | version != 3 | re-download or convert |
| `tensor points outside GGUF file` | abs_offset + bytes > file size | truncated download |
| `expected X=Y for DeepSeek4 Flash, got Z` | metadata mismatch | not a DS4 Flash GGUF |
| `tensor T has type X, expected Y` | quant type wrong | not a DS4-shape quant |
| `required tensor is missing: NAME` | weight not in GGUF | wrong model file |
| `another ds4 process is already running (pid N)` | lock held | kill the other ds4, or set `DS4_LOCK_FILE` |

The reason these messages can be specific is the strict validation. Every error is detected at a known stage, with the context to print exactly what was wrong.

---

## 12. Summary

What you should remember about the loader:

- **Single mmap.** The entire GGUF — 80+ GB on a 2-bit quant — is `mmap`'d once. Metal backends get `MAP_SHARED` for zero-copy GPU views; CPU backends get `MAP_PRIVATE` to dodge a Darwin VM bug.
- **Two-stage parsing.** `parse_metadata` indexes KV pairs by offset (no value decode); `parse_tensors` builds a `ds4_tensor` table with absolute offsets.
- **Three-stage validation.** `config_validate_model` enforces architectural metadata against `DS4_N_*` constants. `weights_bind` resolves every expected tensor name; missing names fail. `weights_validate_layout` checks type and shape against the binding contract.
- **Tensor access is one pointer add.** `tensor_data(model, t)` returns `m->map + t->abs_offset`. Kernels read directly from the file-backed memory.
- **Per-layer conditional binding.** The compressor and indexer tensors are bound only for the layers that have them. The hash-routing table is bound only for the first 3 layers.
- **Warm-up is optional.** `model_warm_weights` page-walks the tensor region to amortise faults; useful for benchmarks, wasteful for interactive use.
- **The mmap lives as long as the engine.** `ds4_engine_close` is what tears it down; until then every kernel reads weights directly from kernel page cache.

Chapter 04 picks up here and explains the quantization formats themselves — IQ2_XXS, Q2_K, Q4_K, Q8_0 — and the imatrix-tuned quants that ship with ds4.
