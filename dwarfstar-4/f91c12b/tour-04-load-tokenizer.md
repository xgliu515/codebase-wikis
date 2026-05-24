# Tour Step 04: Loading the tokenizer from the same GGUF

> Code version locked to `ds4@f91c12b50a1448527c435c028bfc70d1b00f6c33` (2026). All `file:line` refs are repo-root-relative paths at this commit. Trace target: `./ds4 -m DS4.gguf -p "hello" -n 3`.

## 1. Current situation

Tour-03 left `ds4_engine_open` partway through its initialization sequence: `model_open` has mmap'd the GGUF, the tensor directory has been parsed, the `ds4_engine` struct (`ds4.c:14707-14724`) has its `model` and `backend` fields set. But `weights_bind` has not yet run (the per-layer `ds4_weights` pointers are still zero), and `config_validate_model` has not yet accepted the hyperparameters either. Execution is parked at `ds4.c:17666`, the line `vocab_load(&e->vocab, &e->model)` — three statements before weight binding.

Reading order inside `ds4_engine_open` (`ds4.c:17636-17760`): `model_open` (mmap + tensor directory) at 17664 → optional `model_warm_weights` at 17665 → `vocab_load` at 17666 → `config_validate_model` at 17667 → `weights_bind` at 17668 → GPU init (`ds4_gpu_init`, `ds4_gpu_set_model_map_range`, `accelerator_cache_model_tensors`) at 17700-17745. The tokenizer is loaded **before** weights are bound and **before** config is validated — a deliberate ordering because the tokenizer load is logically independent of the tensor directory and is the cheapest way to fail fast on a wrong-family GGUF (see Phase 4 below).

What the engine cannot do yet: turn `"hello"` into token ids, look up `<｜User｜>` / `<｜Assistant｜>` / `<think>`, or recognize the BOS token. Every later step (build_prompt, encode_chat_prompt, the prefill loop) needs the tokenizer wired up. By the end of this step the `ds4_vocab` struct (`ds4.c:14693-14705`) holds the 129 280 token string table, the BPE merge-rank hash table, and the seven special token ids that DS4's chat template requires.

## 2. The problem

A tokenizer for a 600 B-parameter DeepSeek-V4-class model has three logically separate pieces of state, all of which must arrive correctly aligned with the weights:

> (a) The token string table — one UTF-8 byte sequence per id, 129 280 entries; (b) the BPE merge ranks — hundreds of thousands of `"A B"` → rank entries that determine how raw text is greedily merged into tokens; (c) seven special token ids (`<｜begin▁of▁sentence｜>`, `<｜end▁of▁sentence｜>`, `<｜User｜>`, `<｜Assistant｜>`, `<think>`, `</think>`, `｜DSML｜`) that are inserted directly by id, bypassing BPE.

These three pieces have to come from somewhere, in a form the engine can use in O(1) per lookup, with the strict guarantee that token id `i` in the vocabulary corresponds to row `i` of `token_embd`. Get the row alignment wrong by one and every embedding lookup returns the wrong vector.

## 3. Naive approach

Ship two files: `DS4.gguf` for the weights and `tokenizer.json` (Hugging Face format) or `vocab.txt` + `merges.txt` (legacy) for the tokenizer. At startup, mmap the GGUF for weights and `fopen` + parse JSON for the tokenizer. This is what `transformers` does, what early llama.cpp did, and what tiktoken-based servers do. The CLI exposes a `--tokenizer` flag; users are expected to download the matching tokenizer file alongside the GGUF.

An alternative naive design: load the tokenizer as a SentencePiece trie. SentencePiece represents the vocabulary as a prefix tree and does greedy longest-match tokenization. This works for many multilingual models (LLaMA-2, Mistral). But DeepSeek V4 is byte-level BPE with explicit merge ranks (the same family as GPT-2 / GPT-4 / LLaMA-3). The merge rules are not encodable as a longest-match trie because the order in which adjacent pairs are merged depends on rank, not local prefix matching. Forcing SentencePiece on a BPE model produces visibly different tokenization on edge cases (CJK punctuation runs, numbers, leading whitespace), which means different logits and different generations.

## 4. Why the naive approach breaks

The two-file design has five real, observed failure modes:

- **Version drift.** A user downloads `DS4-Q4.gguf` from one repository snapshot and `tokenizer.json` from another. A single PR that adds a new special token (say `<tool_call>` for tool use) leaves the two files mutually inconsistent, but both load without errors. The model then emits ids the new tokenizer cannot decode, or the new tokenizer encodes inputs to ids the old weights do not embed. The bug surface is "occasional garbage tokens", which is undebuggable.
- **Row-alignment is contractual, not structural.** The promise that `token_embd[i]` corresponds to vocabulary entry `i` is enforced only by convention when the two files come from different sources. Reorder the JSON file's vocab by one and embeddings silently shift; nothing in the loader can detect it.
- **Format proliferation.** Hugging Face tokenizers, SentencePiece, tiktoken, and DeepSeek's own JoyAI variant all have different parsers. A C-only inference binary that wants to ship as a single executable now needs three parsers, plus a way to detect which one applies.
- **Distribution and packaging.** "Two files that must match" is a user-experience disaster on download mirrors, in CI artifacts, and in container images. Half the GitHub issues on early inference projects are "I downloaded the model but got `KeyError: '<|im_end|>'`".
- **No structural model-family check.** A LLaMA GGUF and a DeepSeek GGUF have very similar tensor layouts; the inference binary only realizes "this is the wrong family" when prefill produces garbage logits, dozens of steps after load. The two-file design has no natural place to fail loudly at startup.

The deeper issue is that the vocabulary, the merge ranks, and the embedding rows are one logically inseparable object — they were trained together, they must be deployed together. The naive design treats them as separate concerns and pays the price every time a release pipeline forgets it.

## 5. ds4's approach

ds4's approach is to **embed the tokenizer (token strings, merge ranks, special token ids) into the GGUF file's KV metadata region, load it zero-copy directly from the mmap, and validate the embedded tokenizer's identity by looking up DS4-specific special tokens that fail loudly if absent**. The function is `vocab_load` at `ds4.c:15124`, called from `ds4_engine_open` at `ds4.c:17666`.

The procedure has four phases.

**Phase 1: read the metadata array references.** GGUF stores its KV pairs in a header region that is already mapped into memory; `model_get_array` returns a `ds4_array_ref` carrying the array element type and a byte offset into the mmap where the string array begins. `vocab_load` at `ds4.c:15127-15137` reads two arrays:

```c
model_get_array(model, "tokenizer.ggml.tokens",  &tokens);   // 129 280 strings
model_get_array(model, "tokenizer.ggml.merges",  &merges);   // ~250 000 "A B" strings
```

If either is missing or has the wrong element type (`GGUF_VALUE_STRING`), `ds4_die` terminates startup with a clear message. Token count must fit in `INT32_MAX` (`ds4.c:15131`). At this point the function has read approximately 32 bytes from the metadata region; the data offsets it now holds point at the actual string content further down in the same mmap'd page range.

**Phase 2: build the token string table and the text→id hash.** Lines 15139-15147 allocate the `vocab->token[]` array (`ds4_str` = pointer + length, ~16 bytes each, ~2 MB total) and a `str_i32_table` hash table sized to `tokens.len`. The cursor at `ds4.c:15143` walks the GGUF string array; for each of the 129 280 entries, `cursor_string` reads a length prefix and writes a `ds4_str` whose `ptr` points directly back into the mmap region — **no string is ever copied**. Each token's bytes are then registered into `token_to_id` via `table_put` so encoding (text → id) is O(1) per lookup. The hash table internally stores the `(ptr, len, id)` triple; the key bytes live in the mmap.

After this phase, decoding (id → text) is also O(1): `vocab->token[id]` directly yields a `ds4_str`. The decoder uses this in `ds4_token_text` (`ds4.h:150`) to materialize the bytes for the user-visible output stream. Note that GPT-2-style byte-level BPE means many token strings contain Unicode "surrogate" bytes (`Ġ` is the printable proxy for U+0020, `Ċ` is the proxy for U+000A); decoding to raw output requires inverting the byte-encode map. That happens later, in tour-13 (logits/sampling), not here.

**Phase 3: build the merge-rank hash.** Lines 15149-15155 walk the merges array; each entry is a `"A B"`-formatted string (two BPE symbols joined by a single space). The insertion index becomes the rank — entry 0 has rank 0 (the highest BPE priority). The merge-rank table is the structurally largest heap allocation in `vocab_load`: ~250 000 entries × ~40 bytes each ≈ 30-50 MB depending on load factor. `bpe_rank` at `ds4.c:14852` later queries this table by concatenating two adjacent symbols with a single space and probing on a 512-byte stack buffer (`ds4.c:14854-14865`) — that buffer size covers all real merge-pair lookups without touching the heap on the hot encoder path. The stack-vs-heap fallback at `ds4.c:14855` is the kind of micro-optimization that matters because `bpe_rank` is called in an O(n²) inner loop inside `bpe_emit_piece` (tour-06).

Why store ranks as insertion order rather than as an explicit `int` next to each merge string? Because the standard BPE algorithm uses ranks only to compare priorities ("which pair has the lowest rank?"). The actual integer value is irrelevant; only the relative ordering matters. Storing ranks as positions cuts the disk footprint of the merge table by ~25% and makes the GGUF metadata region smaller and more cache-friendly. `vocab_load` materializes the integer rank only at load time, into the in-memory hash, where it lives next to the merge bytes.

**Phase 4: bind and validate special token ids.** Lines 15157-15163:

```c
vocab->bos_id         = vocab_lookup(vocab, "<｜begin▁of▁sentence｜>");
vocab->eos_id         = vocab_lookup(vocab, "<｜end▁of▁sentence｜>");
vocab->user_id        = vocab_lookup(vocab, "<｜User｜>");
vocab->assistant_id   = vocab_lookup(vocab, "<｜Assistant｜>");
vocab->think_start_id = vocab_lookup(vocab, "<think>");
vocab->think_end_id   = vocab_lookup(vocab, "</think>");
vocab->dsml_id        = vocab_lookup(vocab, "｜DSML｜");
```

Note the use of the unusual full-width vertical bar character `｜` (U+FF5C) rather than the ASCII `|` — this is DeepSeek's actual marker, intentionally chosen to avoid colliding with arbitrary user text that contains pipe characters. The encoder will only emit these ids through `special_token_at` (`ds4.c:15203`) or direct `token_vec_push` of `vocab->user_id` etc.; ordinary BPE encoding of text containing `｜User｜` would tokenize each character separately.

`vocab_lookup` (`ds4.c:15114`) probes `token_to_id`; if the token is not present it prints `ds4: required tokenizer token is missing: <name>` and `exit(1)`. This is intentional. A LLaMA-3 GGUF has none of these special tokens; a Mistral GGUF has neither `<｜User｜>` nor `｜DSML｜`; loading either through `vocab_load` aborts here, **before** the engine returns and **before** any GPU memory is allocated. The lookups serve double duty: they bind ids for later use by the chat builder (tour-06) and the prefill loop, **and** they verify the GGUF is in fact a DS4-class model. No separate "model family check" is needed — the structural invariant ("DS4 chat template requires these seven tokens") is enforced by the tokenizer load.

For our `./ds4 -m DS4.gguf -p "hello" -n 3` trace, all seven lookups succeed, returning ids like `bos_id ≈ 0`, `user_id` and `assistant_id` in the high range reserved for special tokens, and `think_start_id` / `think_end_id` for the `<think>` / `</think>` markers tour-06 will insert. The `ds4_vocab` struct is now fully populated. `vocab_load` returns; `ds4_engine_open` moves to the next line at `ds4.c:17667` (`config_validate_model`).

The whole sequence is short: about 40 lines of C, no parsing of an external file format, no JSON / YAML / regex. The only "logic" is the merge-rank insertion-order convention and the seven hardcoded special-token names. That brevity is what makes `vocab_load` reliably fast (sub-100 ms even on a cold cache for ~30 MB of metadata) and makes the encoder a thin layer on top.

Memory cost summary: the per-token `ds4_str` array (~2 MB), the `token_to_id` hash (~4 MB), and the `merge_rank` hash (~30-50 MB) live on the heap. The actual token byte sequences and merge-pair byte sequences remain in the mmap'd GGUF — zero-copy. The 25 GiB of model weight tensor data is not touched by `vocab_load`; the kernel will page those in only when prefill reads them (tours 8-9). The page cache for the metadata region — a few MB at the start of the file — is now hot.

The `vocab_load` function does not return a status code; failures call `ds4_die` and exit. This is intentional: there is no recoverable error here. If the GGUF lacks `tokenizer.ggml.tokens`, the model is unusable; if `vocab_lookup` cannot find `<｜User｜>`, the model is the wrong family. In both cases the user wants the process to terminate with a clear message, not to receive a generic error code from `ds4_engine_open` after wasting cycles on `weights_bind` and `ds4_gpu_init`.

## 6. Code locations

In reading order:

- `ds4.c:17666` — the call site inside `ds4_engine_open` where `vocab_load(&e->vocab, &e->model)` runs.
- `ds4.c:14693-14705` — `struct ds4_vocab`: 129 280-entry `token[]` array, seven special-token id slots, two hash tables.
- `ds4.c:15123-15164` — `vocab_load`, the function this step traces.
- `ds4.c:15129-15137` — array-reference extraction (`tokenizer.ggml.tokens`, `tokenizer.ggml.merges`) and element-type validation.
- `ds4.c:15139-15147` — token string table + `token_to_id` hash population, zero-copy strings (each `ds4_str.ptr` points into mmap).
- `ds4.c:15149-15155` — merge-rank table population, insertion order = rank.
- `ds4.c:15157-15163` — special token binding (`bos_id` through `dsml_id`); doubles as DS4-model identity check.
- `ds4.c:15114-15121` — `vocab_lookup`, the lookup-or-die helper used for special tokens.
- `ds4.c:14852-14866` — `bpe_rank`, the hot-path merge lookup with a 512-byte stack buffer to avoid `malloc` per pair query.
- `ds4.c:14818-14828` — `byte_encode`, the GPT-2 byte→codepoint mapping used by `bpe_emit_piece` later.
- `ds4.c:15166-15171` — `vocab_free`, mirror image: frees the heap allocations but never touches the mmap.

## 7. Branches and extensions

This step traced only the load phase. The encoding side of the tokenizer (used by tour-06) and the model-side validation it enables are covered elsewhere:

- **BPE encoder mechanics.** `bpe_emit_piece` (`ds4.c:14869`), `byte_encode` (`ds4.c:14818`), `bpe_tokenize_text` (`ds4.c:15044`) with its JoyAI/DeepSeek pre-tokenization (CJK runs, ASCII digits, leading-space-attaches-to-word) make up the actual encode loop. The full walkthrough is in [Chapter 5: Tokenizer and Chat Template](./05-tokenizer-chat.md).
- **`special_token_at` (`ds4.c:15203`)** scans raw text for literal special-token strings and emits the id directly so users can render their own chat templates without BPE corruption. Used by `ds4_tokenize_rendered_chat`. See [Chapter 5 §rendered chat](./05-tokenizer-chat.md).
- **GGUF array iteration mechanics.** `ds4_array_ref`, `cursor_at`, `cursor_string` — how cursor positions inside the mmap track type-prefixed length-prefixed strings without copying — belong to the file-loading layer. See [Chapter 3: GGUF Loading](./03-gguf-loading.md).
- **Tokenizer / embedding row alignment.** The promise that `token_embd[i]` is the embedding of token id `i` is what makes the embedded tokenizer structurally sound, not just version-locked. Step 09 (tour-09 layer-major prefill) shows the lookup; the embedding table is bound in tour-03. See [Chapter 3 §weight binding](./03-gguf-loading.md) and [Chapter 2: Model Architecture](./02-model-architecture.md).
- **Quantization is orthogonal to tokenizer.** The token table is stored as plain UTF-8 strings in the GGUF metadata region; only tensor data is quantized. See [Chapter 4: Quantization](./04-quantization.md).
- **The `｜DSML｜` marker.** This token is used for DeepSeek Multi-Step Language (the tool-call / structured-output protocol). It is bound here but not used in this `-p "hello"` trace. See [Chapter 13: HTTP Server API](./13-http-server-api.md) for where DSML enters the request pipeline.

## 8. What you should now have in your head

1. **The tokenizer is inside the GGUF file**, not a separate `tokenizer.json`. The token strings and merge ranks live in the metadata KV region, and `vocab_load` reads them zero-copy through the same mmap that holds the weights. That is the version-lock guarantee — you cannot load weights and tokenizer from different commits because there is only one file.
2. **Token strings are zero-copy `ds4_str` pointers into mmap.** Only the two hash tables (`token_to_id`, `merge_rank`, total ~35-55 MB) and the `ds4_str` array (~2 MB) are heap allocations. The actual bytes of "Ġhello", "<｜User｜>", and the 129 278 other tokens are read directly from the page cache.
3. **BPE merge rank is encoded as array insertion order.** Entry 0 in the `tokenizer.ggml.merges` array is the highest-priority merge (rank 0). `bpe_rank` later queries by concatenating two symbols with a space — `"A B"` — and looking up the rank in the hash; the lookup string is built on a 512-byte stack buffer because this is the hottest function in the encoder.
4. **Looking up special tokens by name is also the model-family check.** If `vocab_lookup` fails to find `<｜User｜>` (or any other DS4-specific marker), the process exits before `ds4_engine_open` returns. A LLaMA-3 GGUF cannot reach the engine; the failure is loud and immediate. No separate `--model-type=ds4` flag is needed.
5. **Encoding and decoding are both O(1) per token after `vocab_load`.** `vocab->token[id]` is direct array indexing for decode; `token_to_id` hash lookup is O(1) average for encode of a single token. Only `bpe_emit_piece` is O(n²) in the symbol count for a single pre-tokenized piece — but pieces are short (1-20 symbols), so this is in practice constant per text byte.
6. **After this step the engine has a tokenizer but not bound weights or GPU state.** `vocab_load` returns; `ds4_engine_open` is still inside the same function. The next statement is `config_validate_model` (hyperparameter check), then `weights_bind` (the per-layer pointer wiring tour-03 described conceptually but is actually populated here), then GPU init (tour-05). Nothing has been allocated on the GPU yet; nothing in the weight tensor data region has been read. The hot subsystems for the rest of startup are `ds4_gpu_init` and `accelerator_cache_model_tensors`, both consumers of the same mmap that `vocab_load` just walked.
