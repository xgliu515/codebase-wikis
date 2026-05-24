# Chapter 14: Disk KV Cache and Replay

> Code version locked to `antirez/ds4@f91c12b50a1448527c435c028bfc70d1b00f6c33` (HEAD on `main`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

Related chapters: [Chapter 13: HTTP Server and OpenAI / Anthropic API](13-http-server-api.md) - [Chapter 6: Engine Session](06-engine-session.md).

The HTTP server in Chapter 13 is shaped by one constraint: one live KV session, one worker thread. That live session is precious. It captures the model's hidden reasoning, the exact bytes the model sampled for previous tool calls, and tens of seconds of prefill compute. Lose it, and the next request has to start from zero.

This chapter is about the system that prevents that loss. The disk KV cache turns the KV state into a first-class on-disk artifact: when the live session is about to be replaced, it is saved; when a request's prompt prefix matches a saved checkpoint, it is loaded. The README's framing is exact: "the KV cache is actually a first-class disk citizen." That is not a metaphor - it is the design statement that makes long agent sessions practical on a single GPU.

## 1. Why disk is the right answer here

The naive intuition is "KV state should fit in RAM, disks are too slow." Two facts make that wrong for DS4 specifically:

**MLA compression.** DeepSeek V4 Flash uses Multi-head Latent Attention. Most layers store a small compressed latent for each token instead of the full per-head K/V tensors of standard MHA. The result is that 100k tokens of KV state is roughly 1-3 GiB instead of the 30-80 GiB it would be on a comparable MHA model. A few seconds of SSD writes - well within the bandwidth of a modern NVMe drive - is all it takes to capture an entire long context.

**Local-agent workloads resend the same prefix every turn.** A Claude Code session or Codex CLI session looks the same on every turn: a system message of a few KB, then growing conversation history. The bytes at the front of the prompt do not change between turns. A token-prefix match against the live KV would catch the in-process common case, but a process restart loses everything. A disk cache that survives restarts turns "restart the server" from "cold prefill 30k tokens" into "load 100 MB from SSD, prefill the new suffix."

The comment that ties this together is at `ds4_server.c:8203-8212`:

```c
/* The server has one live Metal session.  We persist reusable DS4 session
 * snapshots when a cold prompt reaches a useful prefix, when a long continued
 * conversation has grown far enough, and when a request evicts the live session.
 * The cache key is the SHA1 of the rendered byte prefix.  The payload still
 * stores exact token IDs and graph state; the filename only selects a checkpoint
 * whose decoded transcript bytes are a prefix of the next rendered request.
 *
 * Files are loaded with plain read/write I/O into the existing graph tensors;
 * mmap is deliberately avoided here so cache restore cannot add more VM
 * mappings to a process that already maps a very large GGUF. */
```

Two design facts in that comment:

- **Key is bytes, payload is tokens.** The lookup question is "do these *bytes* form a prefix of the next request's rendered text?" The graph state being restored is the exact token IDs that produced those bytes. The distinction matters when BPE tokenization is unstable across boundaries (more on this in section 5).
- **No mmap.** A 100 MB checkpoint loaded via `mmap` would add a new VM mapping. With a 30+ GiB GGUF model already mmap'd, adding more mappings makes the OS's page-cache scheduling unpredictable. Plain `read()` into the existing graph tensors is more deterministic and arguably faster for one-shot reads of this size.

## 2. The responsibility split

The disk cache spans three files: `ds4_server.c` (policy), `ds4_kvstore.c` (file format and helpers), and `ds4.c` (payload serialization).

```
   ds4_server.c              ds4_kvstore.c              ds4.c (engine)
   ============              =============              =============
   when to save              file format and             how to serialize
   when to load              header layout               the graph tensors
   tool-id trailer           SHA1 of byte prefix         payload size
   eviction policy           eviction scoring            mmap-free I/O
   ladder integration        store / load primitives     ds4_session_save_payload
   visible-key checkpoints   trailer hooks               ds4_session_load_payload
```

The split was extracted into `ds4_kvstore.c` (1278 lines, see `wc -l`) so that `ds4-agent` (the agentic CLI in `ds4_agent.c`) could reuse the same on-disk file format with its own save policy. The server's tool-id verbatim-replay trailer (section 7) is a *protocol-specific extra*: it stays in `ds4_server.c` and is attached via the trailer-hooks struct rather than baked into the kvstore module.

Both sides talk through the same public interface:

```c
uint64_t ds4_session_payload_bytes(const ds4_session *s);
int ds4_session_save_payload(ds4_session *s, FILE *fp, char *err, size_t errlen);
int ds4_session_load_payload(ds4_session *s, FILE *fp,
                             uint64_t payload_bytes, char *err, size_t errlen);
```

The kvstore code calls `ds4_session_save_payload(session, fp, ...)` to write the engine's bytes directly into the open file (`ds4_kvstore.c:1013`), and `ds4_session_load_payload(session, fp, hdr.payload_bytes, ...)` to read them back (`ds4_kvstore.c:1196`). It never inspects the bytes.

## 3. The on-disk file format

A single checkpoint file looks like this:

```
filename: <sha1_hex_40_chars>.kv

byte offset
0       3   magic bytes 'K' 'V' 'C'
3       1   version (currently 1)
4       1   quant_bits (2 or 4, picked at load to detect cross-quant)
5       1   reason (cold / continued / evict / shutdown / agent-system / agent-session)
6       1   ext_flags (bitfield: tool-map, responses-visible, thinking-visible, ...)
7       1   reserved (zero)
8       4   token_count (LE uint32) - number of tokens captured
12      4   hit_count (LE uint32) - times this file was loaded
16      4   ctx_size (LE uint32) - context capacity at save time
20      4   reserved (zero)
24      8   creation_time (LE uint64) - Unix seconds
32      8   last_used_time (LE uint64) - Unix seconds
40      8   payload_bytes (LE uint64) - size of the engine payload

48      4   text_bytes (LE uint32) - length of the cache-text key
52      *   rendered_text or visible transcript (text_bytes bytes, no NUL)

52+text_bytes
        *   engine payload (payload_bytes bytes, produced by ds4_session_save_payload)

(optional, only if ext_flags has bit 0)
        3   'K' 'T' 'M'         tool-id map magic
        1   version
        4   count (LE uint32) - number of id->dsml entries
        *   each entry: 4 id_len, 4 dsml_len, id bytes, dsml bytes
```

The constants live in the kvstore header:

```c
#define DS4_KVSTORE_FIXED_HEADER 48u
#define DS4_KVSTORE_DEFAULT_MB   4096
#define DS4_KVSTORE_HIT_HALF_LIFE_SECONDS (6ull * 60ull * 60ull)

#define DS4_KVSTORE_EXT_TOOL_MAP          (1u << 0)
#define DS4_KVSTORE_EXT_RESPONSES_VISIBLE (1u << 1)
#define DS4_KVSTORE_EXT_THINKING_VISIBLE  (1u << 2)
#define DS4_KVSTORE_EXT_SESSION_TITLE     (1u << 3)
```
(`ds4_kvstore.h:11-18`)

The fixed-header writer is `ds4_kvstore_fill_header` (`ds4_kvstore.c:379-399`):

```c
void ds4_kvstore_fill_header(uint8_t h[DS4_KVSTORE_FIXED_HEADER],
                             uint8_t quant_bits, uint8_t reason,
                             uint8_t ext_flags, uint32_t tokens,
                             uint32_t hits, uint32_t ctx_size,
                             uint64_t created_at, uint64_t last_used,
                             uint64_t payload_bytes) {
    memset(h, 0, DS4_KVSTORE_FIXED_HEADER);
    h[0] = KV_CACHE_MAGIC0;  // 'K'
    h[1] = KV_CACHE_MAGIC1;  // 'V'
    h[2] = KV_CACHE_MAGIC2;  // 'C'
    h[3] = KV_CACHE_VERSION; // 1
    h[4] = quant_bits;
    h[5] = reason;
    h[6] = ext_flags;
    ds4_kvstore_le_put32(h + 8, tokens);
    ds4_kvstore_le_put32(h + 12, hits);
    ds4_kvstore_le_put32(h + 16, ctx_size);
    kv_le_put64(h + 24, created_at);
    kv_le_put64(h + 32, last_used);
    kv_le_put64(h + 40, payload_bytes);
}
```

The reader is `ds4_kvstore_read_header` (`ds4_kvstore.c:401-422`), with a one-shot validity check that `tokens != 0` and `quant_bits in {2, 4}` - any other value means the file is corrupt or written by a different model and should be skipped.

The file extension is `.kv` (not `.kvc`). The filename validator at `ds4_kvstore.c:316-323` accepts any 43-character name matching `<40 hex chars>.kv`; anything else is silently ignored during directory scans, so unrelated files in the cache dir do not break the cache.

### 3.1 Why text and tokens are both stored

A naive design would store *either* the rendered text *or* the token IDs - they are derivable from each other given the tokenizer. Both are stored because they answer different questions:

- The **rendered text** is the lookup key. The filename's SHA1 hash is of these bytes, and validating that the incoming prompt starts with these bytes is the cheap up-front check.
- The **token IDs** (inside the payload) are the source of truth for the graph state. BPE tokenization is not always stable: the same byte string tokenized standalone may produce different IDs than the same string tokenized as part of a larger context, because BPE merges can cross boundaries.

The implication is at `ds4_kvstore.c:639-652`:

```c
void ds4_kvstore_build_prompt_from_exact_prefix_and_text_suffix(
        ds4_engine *engine,
        const ds4_tokens *exact_prefix,
        const char *suffix_text,
        ds4_tokens *out);
```

When the server hits a text-prefix match, it does *not* slice the next request's pre-tokenized `prompt`. Instead it builds a fresh `effective_prompt` from:
1. the exact token IDs the cache restored (from the payload), plus
2. the text *after* the matched prefix, tokenized in isolation.

This produces a token sequence that exactly extends the restored graph state. The original request's `prompt` tokens may differ near the boundary; that is fine because they were never used.

## 4. The payload (engine side)

The kvstore reads/writes the engine payload as opaque bytes. The engine knows what is inside. The payload is produced by `ds4_session_save_payload` in `ds4.c` and consumed by `ds4_session_load_payload`. Its size is exactly `ds4_session_payload_bytes(session)`.

For the DS4 V4 Flash model, the payload is laid out roughly as:

```
header: DS4_SESSION_PAYLOAD_U32_FIELDS x uint32
  MAGIC, VERSION, ctx_size, prefill_cap, raw_cap, comp_cap,
  checkpoint_len, N_LAYER, N_HEAD_DIM, N_INDEXER_HEAD_DIM, N_VOCAB, raw_live

checkpoint token IDs: checkpoint_len x uint32

logits: N_VOCAB x float32   // last token's logits

per-layer counts:
  n_comp[N_LAYER]:        uint32 x 43      // compressed KV row counts
  n_index_comp[N_LAYER]:  uint32 x 43      // ratio-4 indexer row counts

for each layer (N_LAYER = 43 iterations):
  raw KV:                 raw_live x N_HEAD_DIM x float32
  if compressed_layer:
    compressed KV:        n_comp x N_HEAD_DIM x float32
    attn_state K:         layer_attn_state_bytes(ratio) bytes
    attn_state V:         layer_attn_state_bytes(ratio) bytes
    if ratio == 4:
      index_comp:         n_index_comp x N_INDEXER_HEAD_DIM x float32
      index_state K:      layer_index_state_bytes(4) bytes
      index_state V:      layer_index_state_bytes(4) bytes
```

The exact-bytes function on the engine side computes only what is live, not what is allocated:

```c
/* Return the exact engine-owned payload size, excluding the server's KVC file
 * header and observability text.  This is deliberately based on live row counts
 * rather than capacities so the disk cache scales with saved tokens, not with
 * the maximum context size used to allocate the graph. */
```
(comment in `ds4.c` near `session_payload_live_tensor_bytes`)

In particular, the raw window cache (the SWA - sliding-window-attention - rows) is bounded to the last `DS4_N_SWA = 128` rows even when the checkpoint contains 10000 tokens. Tokens older than the SWA window do not contribute to future generation because the next attention step cannot see them; they exist only as compressed latents in the compressed KV cache, which is fully stored.

For practical numbers: a 30000-token checkpoint of DS4 V4 Flash with 2-bit quantization weighs roughly 200 MiB on disk. A 100000-token checkpoint is roughly 600 MiB. With the default 4 GiB budget (`DS4_KVSTORE_DEFAULT_MB = 4096`), the cache holds 10-20 distinct sessions.

## 5. Save policy: when checkpoints are made

A file is written only when the live KV state is at the checkpoint we want to persist. The kvstore enforces this with a runtime assertion (`ds4_kvstore.c:902-915`):

```c
const ds4_tokens *live_tokens = ds4_session_tokens(session);
if (!live_tokens ||
    live_tokens->len != store_tokens.len ||
    !ds4_tokens_starts_with(live_tokens, &store_tokens))
{
    kv_logf(kc, ..., "kv cache skipped tokens=%d because live checkpoint is at %d",
            store_tokens.len, live_tokens ? live_tokens->len : -1);
    return false;
}
```

The session is never rolled backward to build a cache entry. This is a deliberate constraint: rolling back would mean re-prefilling on the next request to get back to where we already were, which would turn cache population into a second hidden prefill. Instead, the policy chooses cache write points that the session is *about to be at* during normal generation, and writes the file once the session arrives.

There are five named reasons a write happens (`ds4_kvstore.h:20-28`):

```c
typedef enum {
    DS4_KVSTORE_REASON_UNKNOWN   = 0,
    DS4_KVSTORE_REASON_COLD      = 1,  // cold prefill reached the stable prefix
    DS4_KVSTORE_REASON_CONTINUED = 2,  // periodic aligned-boundary save
    DS4_KVSTORE_REASON_EVICT     = 3,  // about to replace live session
    DS4_KVSTORE_REASON_SHUTDOWN  = 4,  // server is shutting down cleanly
    DS4_KVSTORE_REASON_AGENT_SYSTEM  = 5,  // ds4-agent system prefix
    DS4_KVSTORE_REASON_AGENT_SESSION = 6,  // ds4-agent named session
} ds4_kvstore_reason;
```

### 5.1 Cold

Cold writes happen when a cold prefill reaches a useful prefix and the rest of the prompt would extend past it. The relevant code in `generate_job` (`ds4_server.c:10076-10127`):

```c
int cold_store_len = 0;
if (cached == 0 &&
    s->kv.enabled &&
    prompt_for_sync->len >= s->kv.opt.min_tokens &&
    s->kv.opt.cold_max_tokens > 0 &&
    prompt_for_sync->len <= s->kv.opt.cold_max_tokens)
{
    const int anchor = kv_cache_chat_anchor_pos(&s->kv, prompt_for_sync, ...);
    cold_store_len = anchor >= s->kv.opt.min_tokens ?
                     anchor : kv_cache_store_len(&s->kv, prompt_for_sync->len);
}
```

`kv_cache_chat_anchor_pos` (`ds4_kvstore.c:665-682`) finds the *last user-marker token before the first assistant-marker token*. The intent is to checkpoint the stable chat prefix - system prompt plus the conversation up to (but not including) the user's specific task. That prefix is the part most likely to be reused across independent agent sessions.

If no usable anchor exists, the fallback is `kv_cache_store_len` (`ds4_kvstore.c:654-663`):

```c
int ds4_kvstore_store_len(const ds4_kvstore *kc, int tokens) {
    const int trim = kc->opt.boundary_trim_tokens;
    const int align = kc->opt.boundary_align_tokens;
    if (tokens > kc->opt.min_tokens + trim) {
        int stable = tokens - trim;
        if (align > 0) stable -= stable % align;
        if (stable >= kc->opt.min_tokens) return stable;
    }
    return tokens;
}
```

`boundary_trim_tokens = 32`, `boundary_align_tokens = 2048`. The trim removes the tail because tokenizers can merge across the prompt boundary - if the prompt ends mid-merge, the saved tokens would diverge from what a future request renders. The 2048 align matches the engine's prefill chunk schedule (`ds4_kvstore.c:32-38`):

```c
/* Tokenizers may merge text across the prompt boundary. Trimming a small tail
 * still improves the cheap token-prefix path, while text-prefix lookup handles
 * cases where canonical prompt tokenization spells the same bytes differently.
 * The 2048 alignment also matches the backend prefill chunk schedule, which
 * keeps compressor row finalization identical to a cold full prompt. */
```

Without alignment, a saved checkpoint at position 9876 might leave the compressor in a different mid-chunk state than a cold prefill that runs straight through to position 9876. With alignment, the saved state at 10240 (= 5 * 2048) is bit-identical to the state of a cold prefill at 10240.

The full cold-save sequence inside `generate_job` is then (`ds4_server.c:10101-10127`):

1. Prefill to `cold_store_len` first (a partial sync into the live session).
2. Call `kv_cache_store_live_prefix(s, prompt_for_sync, cold_store_len, "cold")`.
3. Continue with the regular sync to the full prompt.

Step 1's existence is the "never roll backward" invariant in action: the live session is moved forward to the checkpoint position, the file is written, then the session continues forward. There is no "go back, save, come forward" pattern.

There is also a small dance with `kv_cache_suppress_continued_store` (`ds4_server.c:10090-10099`). If the cold-store frontier happens to land exactly on a continued-checkpoint boundary, the periodic continued save would also fire. The suppress call marks that frontier as already handled before the sync gets there; if the cold save then fails, the suppression is reverted so a future continued save can retry (`ds4_server.c:10122-10125`).

### 5.2 Continued

Continued saves happen during long generations on absolute-aligned token frontiers. The relevant logic is `ds4_kvstore_continued_store_target` (`ds4_kvstore.c:695-702`):

```c
int ds4_kvstore_continued_store_target(const ds4_kvstore *kc, int live_tokens) {
    const int step = kv_cache_continued_step(kc);
    if (step <= 0) return 0;
    if (live_tokens < kc->opt.min_tokens) return 0;
    if (live_tokens % step != 0) return 0;
    if (live_tokens <= kc->continued_last_store_tokens) return 0;
    return live_tokens;
}
```

`step` defaults to `continued_interval_tokens = 10000` rounded up to the next multiple of `boundary_align_tokens = 2048` -> 10240. So continued saves happen at positions 10240, 20480, 30720, etc.

The "absolute aligned" point is important and worth quoting:

```c
/* The schedule is anchored to absolute aligned frontiers, not relative to the
 * last cold/evict file. Otherwise an early cold checkpoint can shift the whole
 * schedule and leave long generations with no recent durable restart point. */
```
(comment around the continued schedule logic)

If continued saves were relative ("every 10k tokens from the last cold save"), an unlucky 5000-token cold checkpoint would push every subsequent continued save 5000 tokens past where it should be, and a server crash at position 15000 would have its latest restart point all the way back at position 5000. Anchored saves at 10240, 20480, 30720 guarantee that the latest restart point is never more than 10240 tokens behind the live frontier.

The hook that fires continued saves is `kv_cache_maybe_store_continued` (`ds4_server.c:8746`):

```c
static void kv_cache_maybe_store_continued(server *s) {
    kv_disk_cache *kc = &s->kv;
    const ds4_tokens *tokens = ds4_session_tokens(s->session);
    if (!tokens) return;
    const int target = kv_cache_continued_store_target(kc, tokens->len);
    if (target == 0) return;
    if (kv_cache_store_live_prefix(s, tokens, target, "continued")) {
        kv_cache_note_store(kc, target);
    }
}
```

It is called from two places: inside the decode loop (`ds4_server.c:10267`, only when *not* generating a tool call), and from the prefill progress callback (`ds4_server.c:9579-9580`) so long cold prefills also produce continued saves before they complete. The callback fires every prefill chunk, so a 30000-token cold prefill that crosses 10240, 20480 will have produced both intermediate checkpoints by the time the request completes.

### 5.3 Evict

When a cache miss is about to be processed, the server first writes the existing live state to disk:

```c
if (s->kv.enabled && cached == 0 && old_pos >= s->kv.opt.min_tokens) {
    /* Loading a disk snapshot replaces the live Metal session.  Persist the
     * current checkpoint first, otherwise a cache hit for an older prefix
     * would silently discard the newer conversation state. */
    kv_cache_store_current(s, "evict");
}
```
(`ds4_server.c:9976-9981`)

This is what keeps multi-client / cross-session usage working. Two simultaneous Claude Code projects could share one server: project A is in the live KV; project B sends a request that does not match A's prefix; before B's disk lookup runs, A is saved to disk as an "evict" checkpoint. When the user later returns to project A, the disk text-prefix match finds A's file and restores it.

### 5.4 Shutdown

On clean shutdown, `kv_cache_store_current(&s, "shutdown")` (`ds4_server.c:11655`) writes the current live state. This makes "Ctrl-C, restart the server" a no-cost operation for the active conversation.

### 5.5 The store call

All five reasons funnel into `ds4_kvstore_store_live_prefix_text` (`ds4_kvstore.c:876-1079`). Its job is to:

1. Validate the live session is at the requested store_len (`:902-915`).
2. Render the cache text (or use a visible-text override - section 8).
3. Estimate file size + trailer size; reject if the file would exceed budget (`:941-965`).
4. SHA1 the cache text -> filename.
5. If a same-sha file already exists *and* its quant/ctx are compatible, refresh the trailer in place (`:971-978`) - this is a tiny rewrite, not a re-save.
6. Otherwise, write the new file under a `.tmp.<pid>` path, then atomically `rename` (`:980-1034`).
7. After successful rename, run eviction (`:1072`) so the new file's size is reflected in the budget.

The tmp+rename atomicity matters because a crash mid-write would leave a corrupt file with a valid filename but invalid contents. The kvstore directory scanner at startup (`ds4_kvstore.c:450-465`) reads each file's header to validate it; any file that fails validation is simply ignored, but the safest path is to never produce one.

The "refresh trailer in place" optimization at step 5 is important for the tool-id map. The tool memory grows as the conversation goes; on every cold/continued save the trailer is rewritten with the current map, but the engine payload below it is identical to last time. Rewriting only the trailer (and the file header's `ext_flags` byte) is cheaper than rewriting the whole 600 MiB file. `kv_cache_existing_compatible` and `kv_cache_rewrite_trailer` handle this.

## 6. Load policy: the cache lookup

Loading is initiated from `generate_job` at `ds4_server.c:9982-9991`:

```c
if (cached == 0) {
    disk_cached = kv_cache_try_load(s, &j->req, &effective_prompt,
                                    &disk_cache_path,
                                    &disk_cache_ext_flags);
    if (disk_cached > 0) {
        cached = disk_cached;
        cache_source = "disk-text";
        prompt_for_sync = &effective_prompt;
    }
}
```

This is step 9 in the cache decision ladder from Chapter 13 (section 7). It runs only after the live continuations, the exact token-prefix check, and the live text-prefix check have all failed.

`kv_cache_try_load` is a thin server-side wrapper (`ds4_server.c:8784-8793`) around `ds4_kvstore_try_load_text` (`ds4_kvstore.c:1138-1272`). The wrapper passes the server-specific trailer hooks so the tool-id trailer is loaded as part of the file open.

`ds4_kvstore_try_load_text` is the function to read carefully. Its steps:

1. `ds4_kvstore_find_text_prefix` (`ds4_kvstore.c:1114-1136`) refreshes the directory listing and finds the file whose `text_bytes <= prompt_bytes`, `tokens >= min_tokens`, `ctx_size <= our_ctx_size`, and whose SHA1 of `prompt_text[:text_bytes]` matches the filename SHA1. Ties are broken by longer `text_bytes`, then more tokens.
2. Open the chosen file, re-read the header.
3. Verify `text_bytes <= prompt_bytes` (`:1170-1172`).
4. Read the cached text from the file (`:1174-1177`).
5. Re-hash the cached text and verify it matches the filename SHA1 (`:1180-1184`) - belt-and-braces defense against truncated or tampered files.
6. Verify the prompt actually starts with the cached text bytes (`:1185-1188`).
7. Call `ds4_session_load_payload(session, fp, hdr.payload_bytes, ...)`.
8. After load, get `loaded_tokens = ds4_session_tokens(session)`. Validate `loaded_tokens->len == hdr.tokens` (`:1199`) - if the file claims 10000 tokens but the engine loaded 8500, the file is corrupt and gets `unlink`-ed (`:1213-1222`).
9. Build the effective prompt by appending the new suffix text to the loaded exact-token history (`:1201-1209`).
10. If trailer hooks are present and the file's `ext_flags` says a trailer exists, call `hooks->load(...)` to read the trailer (`:1210-1212`).

There is one cleanup: if the loaded checkpoint is larger than `cold_max_tokens`, the file is `unlink`-ed after load (`:1241-1249`). The rationale is in the log line - `consumed`. Cold-max is the threshold for *creating* cold files; loading something past it means this is an unusually large checkpoint that should not stay on disk competing with smaller, more reusable files. The live session keeps the loaded state; the disk slot is freed up.

### 6.1 Find by hash, validate by bytes

The function above goes through two distinct verification steps that look redundant but are not:

- Step 1's filename-SHA1 check answers "is there a file whose name claims to be the SHA1 of these first N bytes of the prompt?"
- Step 5's content-SHA1 check answers "does the data inside that file actually match its filename's claim?"

Both are needed because the on-disk SHA1 ist a *name*, not a *checksum*. A file moved or renamed by accident, a partial write that survived a crash, or an externally-generated file with a hex-looking name would all be caught by step 5. Without step 5, the loader would happily decode invalid bytes into the live session.

### 6.2 Same-text-prefix but larger context

The check `ctx_size <= our_ctx_size` is subtle. The kvstore module comments:

```c
/* A same-text-prefix file can be reused by a larger context, but not by a
 * smaller one: the payload was validated against the context capacity recorded
 * in the file.  If the existing file cannot be used by this server, replace it
 * so this context can still populate its own cache. */
```
(`ds4_server.c:8622-8625`)

The DS4 graph allocates raw/compressed row capacity at session creation. A checkpoint saved by a server with ctx_size=100000 has a `raw_cap` and `comp_cap` baked into its payload that exceed what a ctx_size=32768 server's session has allocated. Loading it would scribble past the smaller graph's tensors. Going the other way is fine - the larger graph has enough room.

This means cache directories can be shared across multiple servers running the same model with different `--ctx` settings, but each server only sees the files it can use.

## 7. The tool-id map trailer

The kvstore module is generic; the tool-id verbatim-replay map is a server-only addition. It is attached via the `ds4_kvstore_trailer_hooks` struct (`ds4_kvstore.h:79-86`):

```c
typedef struct {
    void *ud;
    uint8_t ext_flag;
    bool (*serialized_size)(void *ud, const char *text, uint64_t *bytes_out);
    bool (*write)(void *ud, FILE *fp, const char *text, uint64_t *written_bytes);
    int (*load)(void *ud, FILE *fp, const void *wanted);
    const void *load_wanted;
} ds4_kvstore_trailer_hooks;
```

The server's hook implementation is `kv_cache_tool_map_hooks` (`ds4_server.c:8658-8668`):

```c
static ds4_kvstore_trailer_hooks kv_cache_tool_map_hooks(server *s,
                                                         const stop_list *wanted) {
    return (ds4_kvstore_trailer_hooks){
        .ud = s,
        .ext_flag = KV_EXT_TOOL_MAP,
        .serialized_size = kv_cache_tool_map_size_cb,
        .write = kv_cache_tool_map_write_cb,
        .load = kv_cache_tool_map_load_cb,
        .load_wanted = wanted,
    };
}
```

The three callbacks are thin shims that lock `s->tool_mu` and call `kv_tool_map_measure_locked` / `kv_tool_map_write` / `kv_tool_map_load_from_pos`.

### 7.1 Writing only the relevant entries

The clever part: the trailer does not save the entire tool memory. It saves only the entries whose DSML block appears *in this file's cache text*. The measurement loop is `kv_tool_map_measure_locked` (`ds4_server.c:8354-8388`):

```c
const char *p = text;
for (;;) {
    const char *end = NULL;
    const char *start = find_next_dsml_tool_block(p, &end);
    if (!start || !end) break;
    tool_memory_block *b = tool_memory_find_block_locked(&s->tool_mem, start,
                                                         (size_t)(end - start));
    if (b && b->seen != scan) {
        b->seen = scan;
        for (tool_memory_entry *e = b->entries; e; e = e->block_next) {
            /* account size for this id -> dsml entry */
            count++;
            bytes += 8u + id_len + dsml_len;
        }
    }
    p = end;
}
```

The loop finds every `<|DSML|tool_calls>...</|DSML|tool_calls>` block in the rendered text. For each block, it looks up the block in the by-block radix tree to find all the call ids that point to it. Only those ids get written.

This keeps the trailer small (proportional to the number of tool calls in the checkpoint, not the global memory size) and self-contained (a file's trailer references only ids that show up in its text). When the file is loaded, only the entries the *current* request needs are restored - `wanted` (an `id_list` of call ids appearing in the incoming request) filters the load (`ds4_server.c:8457-8506`).

### 7.2 The trailer wire format

```
header (8 bytes):
  3   'K' 'T' 'M'   magic
  1   version (1)
  4   count (LE uint32)

per entry (variable):
  4   id_len (LE uint32)
  4   dsml_len (LE uint32)
  *   id bytes (id_len)
  *   dsml bytes (dsml_len)
```

(`ds4_server.c:8419-8451`)

There is no end marker - the trailer's size is bounded by the file's overall size. If a trailer is corrupt or truncated, `kv_tool_map_load_from_pos` (`ds4_server.c:8457-8506`) returns the number of entries it successfully loaded before the failure and the rest are silently ignored. A corrupt trailer never poisons the engine payload.

### 7.3 The boot-time scan

`kv_cache_restore_tool_memory_for_messages` (`ds4_server.c:8511-8546`) is called at every request's parse time. Its job is more subtle than it looks:

```c
static void kv_cache_restore_tool_memory_for_messages(server *s, const chat_msgs *msgs) {
    if (!s || s->disable_exact_dsml_tool_replay || !s->kv.enabled || !msgs) return;
    stop_list wanted = {0};
    collect_tool_call_ids(msgs, &wanted);
    if (wanted.len == 0) return;

    DIR *d = opendir(s->kv.dir);
    /* ... */
    while ((de = readdir(d)) != NULL) {
        char sha[41];
        if (!sha_hex_name(de->d_name, sha)) continue;
        char *path = path_join(s->kv.dir, de->d_name);
        FILE *fp = fopen(path, "rb");
        free(path);
        if (!fp) continue;
        kv_entry hdr = {0};
        uint32_t text_bytes = 0;
        bool ok = kv_read_header(fp, &hdr, &text_bytes);
        uint64_t skip = (uint64_t)text_bytes + hdr.payload_bytes;
        if (ok && (hdr.ext_flags & KV_EXT_TOOL_MAP) &&
            skip <= (uint64_t)INT64_MAX &&
            fseeko(fp, (off_t)skip, SEEK_CUR) == 0)
        {
            kv_tool_map_load_from_pos(s, fp, &wanted);
        }
        fclose(fp);
    }
    closedir(d);
    id_list_free(&wanted);
}
```

For every conversation message that arrives, the server scans *every* disk file in the cache dir, reads only the header + trailer (skipping past the payload via `fseeko`), and pulls into RAM any tool-id entries that match ids the current request mentions.

This means a Claude Code session can be restarted, a new request can come in mentioning `toolu_abc...` from three hours ago, and the server can re-render that tool call into the prompt with verbatim bytes - even though the live KV is empty and the tool memory was fresh. The disk trailer is the durable index. The verbatim replay does not require that *this* checkpoint be loaded; it only requires that *some* checkpoint trailer mentioned the id.

Without this scan, the verbatim-replay map would be process-local: each fresh server boot would lose the verbatim bytes for past calls. With the scan, the verbatim replay is durable as long as the file is on disk.

## 8. Visible-key checkpoints

So far the cache key has been "the rendered token prefix." That works for normal text, but breaks for two specific situations where the *visible transcript* is a strict subset of the *bytes that produced the live KV*:

- **Responses with reasoning**: the model's hidden `<think>...</think>` reasoning is in the KV, but a stateless Responses replay does not include those bytes. The client only sends the visible content.
- **Tool-less thinking**: chat/completions answers can contain `<think>` blocks that the client does not replay on the next turn.

If we keyed the disk file by the full rendered text, future requests would never find these checkpoints because the rendered text would not include the hidden content. Conversely, if we keyed by the visible text but stored the full engine state, a future request whose visible text matches can restore the *hidden* state that goes with it.

`ext_flags` carries the discriminator (`ds4_kvstore.h:15-18`):

```c
#define DS4_KVSTORE_EXT_TOOL_MAP          (1u << 0)
#define DS4_KVSTORE_EXT_RESPONSES_VISIBLE (1u << 1)
#define DS4_KVSTORE_EXT_THINKING_VISIBLE  (1u << 2)
```

The save-time decision happens in `kv_cache_store_current` (`ds4_server.c:8691-8730`):

```c
char *visible_text = NULL;
uint8_t visible_ext = 0;
const char *visible_key = NULL;
pthread_mutex_lock(&s->tool_mu);
if (s->responses_live.valid &&
    s->responses_live.live_tokens == tokens->len &&
    s->responses_live.visible_text &&
    s->responses_live.visible_text[0])
{
    visible_text = xstrdup(s->responses_live.visible_text);
    visible_ext = KV_EXT_RESPONSES_VISIBLE;
    visible_key = "responses-visible";
} else if (s->thinking_live.valid && ...) {
    visible_text = xstrdup(s->thinking_live.visible_text);
    visible_ext = KV_EXT_THINKING_VISIBLE;
    visible_key = "thinking-visible";
}
pthread_mutex_unlock(&s->tool_mu);

if (visible_text) {
    kv_cache_store_live_prefix_text(s, tokens, tokens->len, reason,
                                    visible_text, visible_ext, visible_key);
    free(visible_text);
} else {
    kv_cache_store_live_prefix(s, tokens, tokens->len, reason);
}
```

When the live state has an associated visible transcript different from the rendered tokens, the file is keyed by the visible transcript and tagged with `KV_EXT_RESPONSES_VISIBLE` or `KV_EXT_THINKING_VISIBLE`. The payload still contains the full engine state including the hidden tokens.

The corresponding load-time machinery is `ds4_kvstore_key_kind` (`ds4_kvstore.c:171-175`):

```c
const char *ds4_kvstore_key_kind(uint8_t ext_flags) {
    if (ext_flags & DS4_KVSTORE_EXT_RESPONSES_VISIBLE) return "responses-visible";
    if (ext_flags & DS4_KVSTORE_EXT_THINKING_VISIBLE) return "thinking-visible";
    return "token-text";
}
```

The key kind is logged on every load so an operator reading the trace can see whether a hit came from the visible-key path.

In the cache decision ladder (Chapter 13 section 7), the load result's `ext_flags & KV_EXT_RESPONSES_VISIBLE` is what tells `generate_job` that the disk-restored state preserves Responses reasoning state. This in turn suppresses the warning that would otherwise fire for a reasoning-mode visible replay missing its reasoning items.

## 9. Eviction

The budget is set by `--kv-disk-space-mb` (default 4096). When the total size of files in the cache directory exceeds the budget, `ds4_kvstore_evict` (`ds4_kvstore.c:510-561`) runs. Its scoring function is at `ds4_kvstore.c:486-508`:

```c
double ds4_kvstore_entry_eviction_score(const ds4_kvstore_entry *e,
                                        const ds4_tokens *live,
                                        const char *protected_sha,
                                        uint64_t now) {
    if (!e || e->file_size == 0) return 0.0;
    if (protected_sha && !strcmp(e->sha, protected_sha)) {
        /* Just-saved checkpoint: never the first to be evicted in this pass. */
        return DBL_MAX;
    }
    double effective_hits = (double)e->hits;
    uint64_t used_at = e->last_used ? e->last_used : e->created_at;
    if (used_at == 0) {
        effective_hits = 0.0;
    } else if (now > used_at) {
        double elapsed = (double)(now - used_at);
        effective_hits *= exp2(-elapsed / (double)DS4_KVSTORE_HIT_HALF_LIFE_SECONDS);
        if (effective_hits < KV_CACHE_MIN_EFFECTIVE_HITS) effective_hits = 0.0;
    }
    return (effective_hits + 1.0) * (double)e->tokens / (double)e->file_size;
}
```

The score is `(effective_hits + 1) * tokens / file_size`. Lower scores get evicted first. The factors:

- **`effective_hits`** decays with a 6-hour half-life. A file that was hot last week has its old popularity discounted; the +1 baseline ensures even unhit files have a non-zero score.
- **`tokens`** rewards larger checkpoints - more cached prefill is worth more.
- **`file_size`** in the denominator means we evict cheap, low-value files first. A 600 MiB file with the same token count and hit pattern as a 200 MiB file is more likely to be evicted (poor compression ratio - probably a less-compressible early checkpoint).
- **`protected_sha`** is the file we just wrote in this `store` call. The eviction pass runs right after rename, and we do not want it to evict the file we just wrote (`ds4_kvstore.c:492-497`).

The half-life formula matters for the policy. The comment is at `ds4_server.c:8209` (originally) and is reproduced in spirit at `ds4_kvstore.c:40-42`:

> Disk-hit counts are evidence that a checkpoint was useful, but only while the workload still resembles the one that produced those hits.

If the user changes their system prompt, every old checkpoint's hit count becomes stale. Without decay, those old hit counts would protect files that will never be useful again. With decay, the baseline `tokens / file_size` value remains intact - old files are not punished for age, they just stop carrying stale popularity forever.

Eviction continues until `total <= budget_bytes` or the cache is empty. Each evicted file is `unlink`-ed; failures are logged but do not stop the loop (`ds4_kvstore.c:543-555`).

## 10. The first-class disk citizen

It is worth pulling back and asking: what does it actually mean to call the KV cache "a first-class disk citizen"?

For most LLM serving stacks, the KV cache is RAM-only and ephemeral. The serving engine maintains a pool of GPU-resident KV blocks, allocates from the pool on demand, and discards on session end. A restart loses everything. Engineering effort goes into batching, paged-attention block management, and dynamic prefix sharing inside the live process.

For DS4, the design statement is the opposite. The live KV is *one* of two equally important places state lives. The other is the disk cache directory. The system makes both into stable, persistent artifacts:

- **A live KV is a session that happens to be in memory.** When a request arrives that does not match, the live session is *saved before being replaced*. There is no "lost work" mode.
- **A disk file is a session that happens not to be in memory right now.** It can be loaded with one read into the same engine session.
- **The lookup key (rendered byte prefix) survives all sources.** A live token-prefix match, a live text-prefix match, and a disk text-prefix match are three implementations of the same question: "does the next request's text start with bytes I have already processed?"

The MLA-based compression that makes 100k-token contexts fit in 600 MiB on disk is what makes this practical. Without it, even a single session would not fit in a reasonable disk budget. With it, dozens of distinct agent sessions can coexist in a single 4 GiB cache directory.

## 11. A long agent session, end to end

Putting Chapters 13 and 14 together, here is what 100k-token Claude Code session looks like over its lifetime:

```
turn 1 (cold start):
  client POSTs /v1/messages with ~30000-token prompt
  cache ladder: all live paths miss, disk miss
  kv_cache_chat_anchor_pos finds anchor at ~20000 tokens
  prefill to anchor, save cold checkpoint (~150 MB)
  prefill suffix to 30000, generate
  during decode, no continued save (under 10240 next multiple)
  on tool call, save no continued (in-tool guard at ds4_server.c:10266)

turn 2 (model tool call):
  client POSTs /v1/messages with tool_use in last assistant message
  parser sees no new tool_result; this is a normal request
  cache ladder: live token-prefix match
  prefill the new (small) suffix, generate

turn 3 (tool result):
  client POSTs /v1/messages with tool_result for toolu_abc...
  parser detects pure tool-result follow-up
  anthropic_prepare_live_continuation stashes suffix_text + call_ids
  cache ladder: anthropic-tool-output hit; live KV used directly
  prefill ~30 tokens (EOS + tool_result + Assistant prefix), generate

turn 4-50 (more agent steps, ~70000 more tokens):
  mostly tool-output continuations
  decode loop fires kv_cache_maybe_store_continued every chunk
  at frontier 20480, save continued checkpoint
  at frontier 40960, save continued checkpoint
  at frontier 61440, save continued checkpoint
  at frontier 81920, save continued checkpoint

server restart (Ctrl-C, restart):
  on Ctrl-C, kv_cache_store_current(s, "shutdown") saves frontier ~95000
  server restarts
  first new request resends 95000-token history
  cache ladder: live miss, disk text-prefix hit on shutdown checkpoint
  ds4_session_load_payload restores the 95000-token KV
  prefill 95000 -> 100000 (the new ~5000-token suffix), generate

turn N+1 (new user task in the same session):
  client adds new user message
  cache ladder: live token-prefix hit (the just-loaded state is intact)
  prefill the new suffix, generate
```

Across this 50-turn session, the total real prefill work the server has done is roughly:

- 30000 tokens (turn 1, cold)
- 50 small tool-tail prefills (~10-30 tokens each)
- 5000 tokens after server restart
- the new user-message suffix per turn

This adds up to maybe 40000 tokens of real prefill across 100000 tokens of generation - a 2-3x reduction. Without the cache, every restart would replay 100000 tokens of prefill on the next request and every tool-result turn would have to text-prefix-match the live session.

## 12. Operator-visible configuration

The defaults are tuned for a single-user MacBook deployment with the V4 Flash 2-bit checkpoint:

```
--kv-disk-dir DIR                          enable disk cache; created if missing
--kv-disk-space-mb 4096                    budget (4 GiB)
--kv-cache-min-tokens 512                  ignore short checkpoints
--kv-cache-cold-max-tokens 30000           threshold for auto-cold-save
--kv-cache-continued-interval-tokens 10000 approximate continued spacing
--kv-cache-boundary-trim-tokens 32         trim cold tail to avoid BPE merges
--kv-cache-boundary-align-tokens 2048      align cold boundary to engine chunk
--kv-cache-reject-different-quant          opt-in: refuse cross-quant files
--disable-exact-dsml-tool-replay           opt-in: skip the tool-id trailer
--tool-memory-max-ids 100000               in-RAM tool-id cap
```

The default `min_tokens=512` keeps tiny "hello world" requests from polluting the cache. `cold_max_tokens=30000` matches the default `--ctx 32768` minus headroom for generation - cold-saving a checkpoint that the same server cannot then continue from would be wasted disk.

Cross-quant rejection is opt-in (`--kv-cache-reject-different-quant`) because the 2-bit and 4-bit checkpoints of the same model produce nearly-but-not-exactly identical KV state. The default behavior accepts files written by either quant; the strict mode requires a match. The strict mode is the safer default for downstream evaluation work where slight numerical drift matters; for chat workloads the loose default is fine.

`--disable-exact-dsml-tool-replay` is the escape hatch for the whole tool-id trailer machinery. With this flag, the server falls back to canonical JSON-to-DSML rendering on every tool replay. It is useful for testing that prompts still tokenize correctly without the verbatim path; in production it is almost never needed.

## 13. Concurrency and the I/O fences

One subtle property of the disk cache is that it lives entirely on the worker thread. There are no background flusher threads, no async writers, no pthread coordination beyond the existing `s->mu` (queue) and `s->tool_mu` (tool memory). All disk I/O happens synchronously inside `generate_job`.

This is deliberate, and it interlocks with the live-session ownership rule from Chapter 13. Disk loads call `ds4_session_load_payload` which writes into the same Metal tensors the engine reads from during prefill and decode. If a background thread were doing that load while the worker was sampling, the result would be undefined - mid-tensor corruption from concurrent writers, or a torn read.

The serial design has a visible cost: a 95000-token disk load can take 500 ms or more on an internal SSD. During that 500 ms, the worker is unavailable. Any client whose request is already in the queue waits. The keepalive callback from Chapter 13 section 9 fires during the load (the engine emits `prefill_display` events even during pure I/O), so the queued client's connection stays open, but their inference is paused.

There is no obvious win from making this concurrent. The bottleneck disk read fills the worker's tensors directly; doing it on another thread would require either double-buffering (which doubles the VM footprint of an already-huge process) or a copy step (which negates the win). The current single-thread model trades a bit of latency under load for predictable performance and simpler reasoning.

The `tool_mu` lock around the tool memory radix tree is the one piece of cross-thread coordination. The parser (client thread) writes into `tool_mem` via `tool_memory_attach_to_messages` when restoring DSML for past tool calls. The worker reads and writes `tool_mem` during decode (when remembering newly-generated calls). The lock is taken around every API surface (`tool_memory_put_source`, `tool_memory_lookup_locked`, `kv_tool_map_measure_locked`, etc.) so the radix tree is consistent across both sides.

The locking pattern is short critical sections - never holding `tool_mu` while doing I/O or while holding `s->mu`. The disk-scan loop in `kv_cache_restore_tool_memory_for_messages` (`ds4_server.c:8511-8546`) reads files outside the lock, then locks `tool_mu` only briefly inside `kv_tool_map_load_from_pos` to insert entries.

## 14. Failure modes and what stays consistent

A real local-server deployment will hit at least four failure modes; the design holds up under each:

**SSD ran out of space mid-write.** `kv_cache_store_live_prefix_text` checks budget before writing (`ds4_kvstore.c:950-965`), but the budget is a soft estimate. If `fflush(fp) == 0` fails or `fwrite` returns short, the function logs the error, unlinks the `.tmp.<pid>` file (`ds4_kvstore.c:1061`), and returns false. The caller (server) sees this and skips the save. The live session is unchanged; the next continued boundary will retry.

**Crash mid-write.** The `.tmp.<pid>` file is never renamed if the write was incomplete (the `rename` call at `ds4_kvstore.c:1031-1034` only happens if all writes succeeded). On next boot, the cache scanner (`kv_cache_refresh`, `ds4_kvstore.c:450-465`) only looks at files matching `*.kv`, so the leftover `.tmp.<pid>` is invisible. It will be cleaned up next time the disk fills enough that someone notices, or by an external job. The cache itself is unaffected.

**Crash mid-load.** If the server crashes during `ds4_session_load_payload`, the live session is in an undefined state, but the process is dead anyway. On restart, the engine creates a fresh session and the disk file is intact (load is read-only on the file).

**Corrupt file on disk.** The triple-validation - header magic + filename SHA1 + content SHA1 - means a corrupt file is detected at load time, logged, and skipped. `ds4_session_load_payload` itself returns nonzero on invalid bytes (`ds4_server.c` propagates this as a load failure); the file is `unlink`-ed (`ds4_kvstore.c:1213-1222`) so it does not waste budget. The request proceeds as a cold prefill.

**Process killed during a "shutdown" save.** The clean-shutdown save at `main()` exit (`ds4_server.c:11651-11656`) is best-effort. If the process is `kill -9`-ed mid-save, the `.tmp.<pid>` file remains and is ignored on next boot, but the previous continued checkpoint is still there. The worst case is losing the conversation from the last continued boundary to the kill point.

The pattern across all these is: **the disk cache is a hint, not a source of truth.** The source of truth is the live session and the model weights. The cache shortens prefill; missing or corrupt cache files only slow down requests, they never produce wrong outputs.

This is why there is no fsync. The store path calls `fflush(fp)` and `fclose(fp)` (`ds4_kvstore.c:1015-1020`) but does not call `fsync`. If a power cut happens after `rename` but before the OS has flushed metadata, the file may not be visible on next boot - that is fine, it just means a cache miss instead of a cache hit. Forcing fsync would slow saves significantly for a benefit that does not materialize.

## 15. A worked example: fresh request hits the disk cache

To pin down the moving parts, walk one specific path end-to-end. The setup: the server has been running, served a 30000-token Claude Code session, then evicted it when a different client connected. The session's checkpoint is on disk at `<cache_dir>/<sha>.kv`. The original client now returns and resends their full 30000-token conversation history.

1. `accept()` returns. The client thread reads the HTTP body and calls `parse_anthropic_request`.

2. The parser walks the JSON, building `chat_msgs`. It calls `kv_cache_restore_tool_memory_for_messages` (`ds4_server.c:8511`), which:
   - Collects all tool call ids in the conversation into a `wanted` list.
   - Opens the cache directory, iterates files matching `<40hex>.kv`.
   - For each file: reads the 52-byte fixed header, seeks past `text_bytes + payload_bytes`, and if the file's `ext_flags & KV_EXT_TOOL_MAP` is set, calls `kv_tool_map_load_from_pos` to load any matching ids.
   - At the end, the in-RAM `tool_mem` radix tree has entries for every wanted id that any disk file knew about.
   The result: even though this is a fresh request and the live tool memory was empty, the previously-sampled DSML bytes for each tool call are now in RAM.

3. The parser then calls `tool_memory_attach_to_messages` (`ds4_server.c:8098`). For each assistant message with tool calls, all ids are looked up in `tool_mem`; if they all map to one block, `calls->raw_dsml` is set to that block's text.

4. The parser calls `render_chat_prompt_text(&msgs, ...)`. For each assistant tool-call message, the renderer splices `calls->raw_dsml` directly into the prompt - exactly the bytes the model originally sampled. For messages without a raw_dsml (because the trailer scan failed or those ids predate the trailer feature), the renderer falls back to canonical JSON-to-DSML rendering.

5. The parser tokenizes the rendered prompt. The result is `req->prompt` and `req->prompt_text` (both about 30000 tokens / ~80 KB of text).

6. The client thread enqueues a `job` on the worker.

7. The worker dequeues. `generate_job` runs the cache decision ladder:
   - Responses visible-prefix: not a Responses request, skip.
   - Responses tool-output: same, skip.
   - Anthropic tool-output: this is a fresh request with no preset `anthropic_live_suffix_text`, skip.
   - Exact token-prefix: `common = 0` because `old_pos = 0` (fresh server state or evicted live), skip.
   - Thinking-visible: `thinking_live.valid = false`, skip.
   - Live text-prefix: `live_tokens` is empty, skip.
   - Disk text-prefix: `kv_cache_try_load` is called.

8. Inside `kv_cache_try_load` -> `ds4_kvstore_try_load_text`:
   - `ds4_kvstore_find_text_prefix` scans the cache directory. For each entry, it checks `text_bytes <= prompt_bytes`, `tokens >= 512`, `ctx_size <= 32768`, and finally `SHA1(prompt_text[:text_bytes]) == filename_sha`. There may be multiple matching files (cold + several continued saves of the same session); pick the longest by `text_bytes`.
   - Open the chosen file. Re-read the header. Read the cached text. Re-hash and verify. Verify byte-prefix.
   - Call `ds4_session_load_payload(session, fp, hdr.payload_bytes, ...)`. This `read()`s ~150 MiB of tensor data into the live Metal session. 500 ms or so on an internal NVMe.
   - Verify `loaded_tokens->len == hdr.tokens`.
   - Build `effective_prompt` from `loaded_tokens + tokenize(prompt_text + text_bytes)`. If the disk file covered text up to byte 75000 of the 80000-byte prompt, only the last ~5000 bytes (about 1500 tokens) need to be tokenized fresh.
   - The trailer-load hook fires: `kv_tool_map_load_from_pos` reads any tool-id entries the file knows about into `tool_mem`. (Redundant with the parser-time scan in step 2, but cheap.)
   - Increment the hit count via `ds4_kvstore_touch_file` (`ds4_kvstore.c:467`) - re-writes only the fixed header.
   - Return loaded = 30000 (or whatever the file's `tokens` was).

9. Back in `generate_job`: `cached = 30000`, `cache_source = "disk-text"`, `prompt_for_sync = &effective_prompt` (which has length ~31500: 30000 from the file + 1500 from the new tail).

10. `ds4_session_sync(s->session, prompt_for_sync, ...)` is called. The engine sees that the first 30000 tokens of `prompt_for_sync` match the live session (they came from the load), so it only prefills the 1500-token tail.

11. The decode loop runs. Streaming SSE frames are emitted as the model samples. New tool calls get stored in `tool_mem`. New continued checkpoints may be saved at frontier multiples of 10240.

12. The response finishes. The worker signals the client thread; the client thread closes the fd and exits.

Compare against the cold path: turn 1 had 30000 tokens of prefill, which takes 30+ seconds on a MacBook. The restart path with disk cache has 500 ms of I/O + 1500 tokens of prefill (~2 seconds). The user perceives the second-visit case as substantially faster than the first cold visit, and that is the whole point of the system.

## 16. Inter-client / cross-process sharing

The cache directory is just a directory on disk. Two servers running the same model with similar `--ctx` settings can share it without coordination. The relevant guarantees:

- **Atomic writes via tmp+rename.** A reader that opens a file with a valid name is guaranteed to see either the old or new full file, never a torn intermediate.
- **SHA1-keyed names.** Two servers writing checkpoints for *the same* prompt produce *the same* filename. They will not collide; the second writer's tmp file is renamed over the first's, or detected as already-present and only the trailer is refreshed.
- **Independent eviction.** Each server runs its own eviction pass with its own budget. If server A evicts a file that server B has loaded, the file is gone from disk but the in-memory state is unaffected (the file was already in B's session payload).
- **Quant tagging.** If `--kv-cache-reject-different-quant` is set, a checkpoint written by a 2-bit-quant server is invisible to a 4-bit-quant server. Without the flag, the load tolerates cross-quant payloads.
- **Ctx-size tagging.** A checkpoint saved by a `--ctx 100000` server is invisible to a `--ctx 32768` server (because of the `ctx_size <= our_ctx_size` check at `ds4_kvstore.c:1124`).

What is *not* coordinated:

- There is no inter-process lock on the cache directory. Two simultaneous writers to the same SHA file race on the rename; the loser's file is simply overwritten. This is fine because the contents would be identical.
- There is no read-lock on a loaded file. If server A is mid-`read()` of a file when server B `unlink`s it, the read continues on Unix systems (the inode stays alive while open). On other filesystems behavior may vary, but for the intended Linux/macOS deployment this is safe.
- There is no signal that the cache directory has new files. Each server's `kv_cache_refresh` rescans the directory on each lookup, so newly-arrived files become visible on the next request.

This means a small fleet of ds4-server processes can share a network-attached cache directory if the model is the same, and any session saved by one server is loadable by any other. The bandwidth cost is the file size on read; for a few-MB checkpoint this is negligible.

## 17. ASCII diagram: the lifecycle of a checkpoint

```
+---------------------------------------------------------------------------+
| live Metal session  (one and only one)                                     |
|   ds4_session_tokens, ds4_session_pos                                      |
+---------------------------------------------------------------------------+
         ^      |                       ^       |
         |      | sync()                |       | sample()
         |      v                       |       v
   load_payload                  save_payload                      decode loop
         ^                               ^
         |                               |
         |                               |
   +-----+------+                  +-----+--------+
   |  disk file |  <-- rename ---  | .tmp.<pid>   |
   |  <sha>.kv  |                  | (atomic)     |
   +-----+------+                  +--------------+
         ^                               ^
         |                               |
         | open(rb)                      | open(wb)
         |                               |
+--------+-------------------------------+--------------------------+
| kv_cache_try_load   (ds4_server.c:8784, ds4_kvstore.c:1138)        |
| kv_cache_store_live_prefix_text (ds4_kvstore.c:876)                |
|                                                                    |
| read_header -> validate -> read text -> rehash -> validate prefix  |
| write_header -> write text -> save_payload -> write trailer        |
+--------------------------------------------------------------------+
         ^                               |
         | request matches               | save reason:
         | a saved text prefix           |   cold       (cold prefill anchor)
         |                               |   continued  (decode-loop boundary)
         |                               |   evict      (about to replace live)
         |                               |   shutdown   (clean exit)
         |
+--------+----------+
| cache_decision    |
| ladder            |
| (Chapter 13, S7)  |
+-------------------+
```

The lifecycle is symmetric: each disk file is born from a `save_payload` call into a `.tmp` then renamed; each disk file dies either by eviction (`unlink` after low score) or by being loaded with `cold_max_tokens < tokens` (which `unlink`s after a single use as the live session "absorbs" it).

In between, files accumulate hits via `ds4_kvstore_touch_file`, get their trailers refreshed in place by subsequent saves of the same SHA, and are scanned at every request's parse time to keep the tool-id map durable across restarts.

## 18. Why the design is the way it is

Reading 1278 lines of `ds4_kvstore.c` plus ~700 lines of `ds4_server.c` cache code is a lot. It is worth restating the key constraints that shape every piece:

- **One live session, one worker.** The disk cache is the only way to preserve state across the live-session boundary. Saves only happen when the live session is *already at* the checkpoint we want, never by rolling backward.

- **MLA compression makes the math work.** A KV cache that was 80x larger in tradition MHA would need different physical infrastructure - tiered storage, async writes, lossy compression. MLA keeps it boring.

- **The key is bytes, the payload is tokens.** This split absorbs tokenizer instability. Any future change that breaks BPE consistency across boundaries can be handled at the suffix-tokenization layer without invalidating saved files.

- **Filenames are SHA1 of the byte prefix, not the token sequence.** Files do not embed in their filename which model or quantization wrote them; they encode the content. Cross-quant or different-context-size files are kept apart by the header fields, not by filename namespacing. The benefit is that two compatible servers naturally share a cache directory.

- **No metadata daemon, no global index.** All cache state is in the files themselves. Server boot scans the directory once (per option-fetch); each request that needs a tool-memory restore scans again. The scans are cheap because the headers are small and seekable. The absence of an index means there is also no index to corrupt or rebuild.

- **The trailer is protocol-specific extras.** The kvstore code is generic; the verbatim DSML-replay map is wired in via trailer hooks. The agent code uses the same on-disk format with different trailers. A future "MCP tool-call cache trailer" or "embeddings trailer" could be added without touching the existing format.

- **The cache is a hint.** Cache miss -> slow request, not wrong request. Corrupt file -> ignored, retried as cold. This is the property that lets the design omit fsync, omit cross-process locks, and tolerate concurrent saves to the same SHA from multiple processes.

The combination of all these choices is what makes "a CLI tool that does V4 Flash inference" into "a CLI tool that does V4 Flash inference *with hour-long stateful agent sessions* on a laptop." The mechanism is simple: turn the bottleneck (KV state) into a file. The discipline is what makes it stay simple.

## 19. Reading the kvcache log

Running `ds4-server --trace foo.log --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192` and watching the stderr stream is the fastest way to build intuition. The relevant log lines (all prefixed `ds4-server: kv cache ...` and routed through `DS4_LOG_KVCACHE`):

```
ds4-server: KV disk cache /tmp/ds4-kv (budget=8192 MiB, cross-quant=accept, ...)
```
Emitted by `ds4_kvstore_open` at startup. Confirms the directory is opened and shows the resolved options.

```
ds4-server: kv cache stored tokens=20480 trimmed=15 reason=cold key=token-text size=147.32 MiB save=420.1 ms
```
A cold save succeeded. `trimmed` is the number of tail tokens removed by `boundary_trim_tokens`. `size` is the entire file (header + text + payload + trailer). `save` is wall time for the write. `key=token-text` means the standard rendered-token-text key; `responses-visible` or `thinking-visible` would appear here for the visible-key files.

```
ds4-server: kv cache hit text tokens=20480 text=78421 quant=2 key=token-text load=512.4 ms file=/tmp/ds4-kv/abc...kv
```
A disk load. `text=78421` is the matched cache-text byte count; `load` is wall time for the read.

```
ds4-server: kv cache hit text RESPPROTO tokens=10240 text=...
```
A Responses-protocol disk load. The `RESPPROTO` marker mirrors the prefill logs.

```
ds4-server: kv cache evicted reason=disk-cache-full tokens=20480 hits=3 size=147.32 MiB file=/tmp/ds4-kv/abc...kv
```
Eviction unlinked a file because the budget was exceeded. `hits` is the file's hit counter at eviction time.

```
ds4-server: kv cache skipped tokens=10240 reason=cold because estimated file size 147.32 MiB exceeds budget
```
A save was rejected because the new file would not fit. The live session is unchanged.

```
ds4-server: kv cache load failed /tmp/ds4-kv/abc...kv: cached text hash mismatch load=42.1 ms
```
A corrupt file was detected at load time and skipped. The next request gets a cold prefill.

The `--trace` file (different from the log) captures per-request decisions including the full cache-source string from the ladder, plus the cache_diag struct that recorded why each ladder step was rejected. For cache-miss debugging, the trace is the single best source.

## 20. Pointers into ds4_kvstore.c

The kvstore module is small enough to fit a function-by-function table:

| Function | File:line | Purpose |
|----------|-----------|---------|
| `ds4_kvstore_default_options` | `ds4_kvstore.c:150` | Defaults for the policy options |
| `ds4_kvstore_reason_code` | `ds4_kvstore.c:160` | String -> reason enum |
| `ds4_kvstore_key_kind` | `ds4_kvstore.c:171` | Map ext_flags to log key name |
| `ds4_kvstore_le_put32` / `ds4_kvstore_le_get32` | `ds4_kvstore.c:177`, `:188` | Endian helpers |
| `sha1_init` / `sha1_update` / `sha1_final` | `ds4_kvstore.c:254`, `:264`, `:281` | SHA1 implementation |
| `ds4_kvstore_sha1_bytes_hex` | `ds4_kvstore.c:307` | Convenience wrapper |
| `ds4_kvstore_sha_hex_name` | `ds4_kvstore.c:316` | Validate `<40hex>.kv` filename |
| `ds4_kvstore_entry_free` | `ds4_kvstore.c:358` | Free an entry's path string |
| `ds4_kvstore_clear` | `ds4_kvstore.c:363` | Free the entire entry list |
| `ds4_kvstore_fill_header` | `ds4_kvstore.c:379` | Build the 48-byte fixed header |
| `ds4_kvstore_read_header` | `ds4_kvstore.c:401` | Parse the fixed header |
| `ds4_kvstore_read_entry_file` | `ds4_kvstore.c:424` | Read header + stat file size |
| `kv_cache_refresh` | `ds4_kvstore.c:450` | Rescan directory into entry list |
| `ds4_kvstore_touch_file` | `ds4_kvstore.c:467` | Bump hit count + last_used time |
| `ds4_kvstore_entry_eviction_score` | `ds4_kvstore.c:486` | Score for eviction tie-break |
| `ds4_kvstore_evict` | `ds4_kvstore.c:510` | Drop low-score files to fit budget |
| `ds4_kvstore_open` | `ds4_kvstore.c:563` | Public entry point: open cache dir |
| `ds4_kvstore_close` | `ds4_kvstore.c:601` | Public entry point: close cache |
| `ds4_kvstore_render_tokens_text` | `ds4_kvstore.c:607` | Token sequence -> rendered text |
| `ds4_kvstore_byte_prefix_match` | `ds4_kvstore.c:621` | memcmp helper for byte-prefix |
| `ds4_kvstore_tokens_copy_prefix` | `ds4_kvstore.c:627` | First N tokens of a tokens struct |
| `ds4_kvstore_build_prompt_from_exact_prefix_and_text_suffix` | `ds4_kvstore.c:639` | The "tokens + suffix text" join |
| `ds4_kvstore_store_len` | `ds4_kvstore.c:654` | Trim + align for cold/continued save |
| `ds4_kvstore_chat_anchor_pos` | `ds4_kvstore.c:665` | Last user marker before first assistant |
| `kv_cache_continued_step` | `ds4_kvstore.c:684` | Align continued interval to chunks |
| `ds4_kvstore_continued_store_target` | `ds4_kvstore.c:695` | Should we save continued at this pos |
| `ds4_kvstore_note_store` | `ds4_kvstore.c:704` | Record successful continued save |
| `ds4_kvstore_suppress_continued_store` | `ds4_kvstore.c:710` | Skip a continued boundary handled by cold |
| `ds4_kvstore_restore_suppressed_continued` | `ds4_kvstore.c:717` | Reverse the above on failure |
| `ds4_kvstore_file_size_fits` | `ds4_kvstore.c:750` | Budget gate before write |
| `kv_cache_file_text_matches` | `ds4_kvstore.c:768` | Header validation during reuse check |
| `ds4_kvstore_store_live_prefix_text` | `ds4_kvstore.c:876` | The full save path |
| `ds4_kvstore_store_live_prefix` | `ds4_kvstore.c:1081` | Convenience without visible-text override |
| `ds4_kvstore_maybe_store_continued` | `ds4_kvstore.c:1095` | Engine-side continued save helper |
| `ds4_kvstore_find_text_prefix` | `ds4_kvstore.c:1114` | Pick the best file matching a prompt |
| `ds4_kvstore_try_load_text` | `ds4_kvstore.c:1138` | The full load path |
| `ds4_kvstore_load_result_free` | `ds4_kvstore.c:1274` | Free the optional path string |

The mid-level helpers in `ds4_server.c` (`kv_cache_*`) are thin wrappers that bind a `ds4_kvstore` to a `server` plus the trailer-hooks for the tool-id map; they exist so that `ds4_server.c` does not have to thread `engine`, `session`, and hooks through every call site.

## 21. What this chapter glossed over

A few details worth pointing at but not unpacking here:

- The kvstore options (`ds4_kvstore_options`, `ds4_kvstore.h:56-62`) and how they thread from server config to kvstore.
- `kv_cache_existing_compatible` and the in-place trailer rewrite path that avoids re-writing the engine payload when only the tool-id map changed.
- The agent-side reasons (`DS4_KVSTORE_REASON_AGENT_SYSTEM`, `_AGENT_SESSION`) and how `ds4_agent.c` uses the same on-disk format with a different save policy and a `KV_EXT_SESSION_TITLE` trailer for named sessions.
- `ds4_session_save_snapshot` / `ds4_session_load_snapshot` (memory-to-memory wrappers around the same payload format used by `ds4-bench` for round-trip tests).
- The exact composition of the engine payload header (the `DS4_SESSION_PAYLOAD_U32_FIELDS` array) and the layered tensor serialization in `ds4.c`.
- `ds4_kvstore_touch_file` (`ds4_kvstore.c:467-484`) which increments the hit counter and updates `last_used_time` in place without rewriting the payload.

For Chapter 13's view of how all of this feeds back into HTTP request handling, see the cache decision ladder in section 7 of that chapter. The disk path is just one rung on that ladder, but it is the rung that turns a small inference server into a system that can support hour-long agent sessions across restarts.
