# Tour Step 17: From token ids to bytes on the terminal, then teardown

> Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The `while` loop in `run_sampled_generation` has exited cleanly. For our `-n 3` trace the exit reason is `generated == max_tokens`. Inside the loop body, three things have already happened for each of the three generated tokens:

```c
char *piece = ds4_token_text(engine, toks[j], &piece_len);   // ds4_cli.c:562
token_printer_write_text(&printer, piece, piece_len);        // ds4_cli.c:563
fflush(stdout);                                              // ds4_cli.c:564
free(piece);                                                 // ds4_cli.c:565
```

So three text pieces have already been written to stdout (possibly via the thinking-tag aware path). What is still pending:

- Any partial `<` byte sitting in `printer.pending[]` that was set aside in case the next token completed `<think>` / `</think>`.
- The active ANSI color escape, if `format_thinking` is on and we are still inside a think block.
- A possibly missing trailing newline.
- The `ds4_session` (KV cache, Metal graph state, logits buffer).
- The `ds4_engine` (weights, vocab, thread pool, GGUF mmap, GPU device state, instance lock).

This step's job is to turn that pending state into "process exited cleanly with code 0".

## 2. The problem

> Stream-print each generated token to stdout so the user sees one piece appear at a time, **without corrupting multi-byte UTF-8 sequences split across tokens**, then release every resource ds4 acquired during boot in the exact reverse order of acquisition, terminating with the `munmap` of the GGUF file.

## 3. Naive approach

For printing: for each token id, look up the vocab string, `fputs` it. For teardown: do nothing — `exit(0)`, let the OS reclaim memory and unmap the file.

Two lines of code for both tasks.

## 4. Why the naive approach breaks

**On printing:**

- **The vocab strings are not raw UTF-8.** DS4 uses the GPT-2 byte-to-Unicode encoding for the BPE vocabulary, where every byte value is mapped to a *printable* code point (space becomes `Ġ`, byte `0x00` becomes a specific private-use code point, etc.). Writing the vocab string directly emits those decorative code points, not the original bytes.
- **Multi-byte sequences split across tokens.** Chinese characters are 3 bytes in UTF-8; the BPE tokenizer may split them across two token ids, so writing each piece independently is fine *byte-stream-wise* but only if the per-token "text" we write is the raw byte fragment, not a re-encoded representation. If we did any per-piece UTF-8 validation, we'd reject perfectly valid byte fragments.
- **`<think>` tags cross token boundaries.** With `format_thinking` enabled, the CLI wants to colorize prose inside `<think>...</think>` differently from outside. The `<` character may arrive at the end of one token's text, with `think>` arriving from the next — so a per-piece scanner with no buffering would never recognize the tag.

**On teardown:**

- **GPU resources do not survive `exit(0)` cleanly in all cases.** Metal command queues holding references to weight buffers should be released explicitly; otherwise repeated open-close (test harnesses, embedded use) accumulates driver warnings and may delay GPU memory reclamation.
- **The instance lock.** `ds4_engine_open` acquires a single-instance lock; without explicit release the next invocation refuses to start until the lock ages out.
- **Worker threads.** `ds4_threads_shutdown` joins the worker pool; skipping it on `exit()` can leave threads racing against atexit handlers on a half-deallocated heap.
- **The mmap is not "free" memory.** The GGUF file is `mmap`ed (tour-02) at potentially tens of GiB virtual mapping; the OS reclaims on exit, but explicit unwind matters for RSS/fd profiling and for embedded reuse.

## 5. ds4's approach

ds4's approach is to **decode each token through a GPT-2 byte-reverse function, buffer up to 16 pending bytes in the printer for cross-token tag matching, then unwind session-then-engine in strict reverse order of acquisition, ending with `munmap` of the GGUF file**.

### Token id → raw UTF-8 bytes

`ds4_token_text` at [`ds4.c:15382`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15382) is the per-token decoder. It has two paths:

1. **Literal-special tokens** — those whose vocab string contains the fullwidth vertical bar U+FF5C (e.g. role markers `<|user|>` / `<|assistant|>`). `vocab_token_is_literal_special` ([`ds4.c:15373`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15373)) returns true and the bytes are copied verbatim.
2. **Ordinary tokens** — the vocab string is a sequence of GPT-2-encoded code points. The function iterates each code point with `utf8_decode_one` ([`ds4.c:15327`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15327)), then reverses with `gpt2_codepoint_to_byte` ([`ds4.c:15357`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15357)) to recover the original byte value in 0..255. Bytes are written contiguously into an `xmalloc`'d buffer; the caller must `free`.

Each `ds4_token_text(token)` returns a possibly-incomplete UTF-8 byte fragment, but it is byte-stream-correct: concatenating all per-token outputs in order gives the exact original text the tokenizer encoded. The terminal's own UTF-8 decoder handles cross-token boundary completion — no per-piece validation is performed or needed.

### Stream printing with cross-token tag buffering

`token_printer` ([`ds4_cli.c:342-352`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L342)) keeps a 16-byte `pending[]` buffer. `token_printer_process` ([`ds4_cli.c:384-428`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L384)) is the scanner: when the tail of the current piece looks like the *start of* `<think>` or `</think>`, it is stashed into `pending` and prepended to the next call. On a future call, when enough bytes have arrived to match the full tag, the scanner toggles `p->in_think` and flips the ANSI color via `token_printer_set_grey` / `token_printer_reset_color` ([`ds4_cli.c:364-376`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L364)).

For our `-n 3` trace, `pending` likely stays empty (three tokens are unlikely to land on a `<` byte at their tail). The path runs anyway — `format_thinking` is enabled because the assistant prefix is configured to think.

### Post-loop cleanup: `generation_done`

After the loop, [`ds4_cli.c:572`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L572) calls `generation_done` ([`ds4_cli.c:438`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L438)):

```c
static void generation_done(void *ud) {
    token_printer *p = ud;
    token_printer_finish(p);                  // flush pending with finish=true
    if (!p->last_output_newline) {            // ensure trailing newline
        fputc('\n', p->fp);
        p->last_output_newline = true;
    }
    fflush(p->fp);
}
```

`token_printer_finish` ([`ds4_cli.c:430-436`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L430)) runs `token_printer_process` one last time with `finish=true`, which causes any buffered `<` partial to be written out as literal text (since no further token will arrive to complete the tag). It also calls `token_printer_reset_color` to emit `\x1b[0m` so the user's shell prompt does not stay grey.

### Session teardown

Immediately after the timing log, [`ds4_cli.c:583`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L583) calls `ds4_session_free` ([`ds4.c:17845`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L17845)). It frees backend-specific buffers first — CPU path runs `kv_cache_free` / `cpu_decode_scratch_free`, Metal/CUDA path runs `metal_graph_free` to release GPU buffers and command-queue references — then `token_vec_free(&s->checkpoint)`, `free(s->logits)`, `free(s->mtp_logits)`, and finally `free(s)`.

### Engine teardown

Control returns from `run_sampled_generation` to `run_generation` to `main`. At [`ds4_cli.c:1611`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L1611):

```c
ds4_engine_close(engine);
free(cfg.prompt_owned);
return rc;
```

`ds4_engine_close` ([`ds4.c:17780`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L17780)):

```c
void ds4_engine_close(ds4_engine *e) {
    if (!e) return;
    weights_free(&e->weights);
    vocab_free(&e->vocab);
    ds4_threads_shutdown();
    if (e->mtp_ready) model_close(&e->mtp_model);
    model_close(&e->model);                   // munmap + close(fd)
#ifndef DS4_NO_GPU
    ds4_gpu_cleanup();
#endif
    ds4_release_instance_lock();
    free(e->directional_steering_dirs);
    free(e->directional_steering_file);
    free(e);
}
```

The ordering is the deliberate inverse of `ds4_engine_open`: weights and vocab metadata first (they reference but do not own the mmap), then the thread pool join, then both models (MTP first since it depends on the main model), then GPU cleanup, then the instance lock.

`model_close` ([`ds4.c:1098`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L1098)) is the symmetric counterpart of tour-02's `mmap`:

```c
static void model_close(ds4_model *m) {
    if (!m) return;
    free(m->kv);
    free(m->tensors);
    if (m->map) munmap((void *)m->map, (size_t)m->size);
    if (m->fd >= 0) close(m->fd);
    memset(m, 0, sizeof(*m));
    m->fd = -1;
}
```

The single `munmap` here returns the GGUF virtual mapping to the kernel. The mapping does not technically need to be torn down before `exit` — the kernel reclaims on process death — but doing it explicitly makes ds4 embeddable (tests can `open` / `close` many times in one process) and unambiguous on RSS/fd profiling.

After `main` returns `rc == 0`, the C runtime walks atexit handlers, flushes any remaining stdio buffers, and the process exits.

## 6. Code locations

- [`ds4.h:150`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L150) — `ds4_token_text` public signature.
- [`ds4.c:15382`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15382) — `ds4_token_text` body.
- [`ds4.c:15327`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15327) — `utf8_decode_one`: iterate one code point from the vocab string.
- [`ds4.c:15357`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15357) — `gpt2_codepoint_to_byte`: reverse the GPT-2 byte map back to a raw byte.
- [`ds4.c:15373`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15373) — `vocab_token_is_literal_special`: detect the U+FF5C marker on role-token strings.
- [`ds4_cli.c:342-352`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L342) — `token_printer` struct with the 16-byte `pending[]`.
- [`ds4_cli.c:364-376`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L364) — `token_printer_set_grey` / `token_printer_reset_color`: ANSI escape emit.
- [`ds4_cli.c:384-428`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L384) — `token_printer_process`: stream scanner with cross-token tag buffering.
- [`ds4_cli.c:430-436`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L430) — `token_printer_finish`: flush pending with `finish=true`, reset color.
- [`ds4_cli.c:438-446`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L438) — `generation_done`: finish, trailing newline, fflush.
- [`ds4_cli.c:448-455`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L448) — `token_printer_write_text`: dispatch to thinking-aware path or direct `fwrite`.
- [`ds4_cli.c:572-583`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L572) — post-loop sequence: `generation_done`, interrupt clear, timing log, `ds4_session_free`.
- [`ds4_cli.c:1611`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L1611) — `ds4_engine_close(engine)` in `main`.
- [`ds4_cli.c:1612`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L1612) — `free(cfg.prompt_owned)`.
- [`ds4.c:17845`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L17845) — `ds4_session_free` body.
- [`ds4.c:17780`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L17780) — `ds4_engine_close` body, reverse-order resource release.
- [`ds4.c:1098`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L1098) — `model_close`: the `munmap` + `close(fd)` pair.
- [`ds4.h:156`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L156) — `ds4_session_free` declaration.
- [`ds4.h:97`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L97) — `ds4_engine_close` declaration.

## 7. Branches and extensions

- **REPL teardown.** In `run_repl` the session is reused across turns and only freed when the user enters `/quit` or sends EOF. The lifetime layering — engine outlives session, session outlives one turn — is the same; only the trigger differs. See [Chapter 06 (Engine and session)](06-engine-session.md).
- **Server / agent teardown.** `ds4_server.c` keeps the engine alive across HTTP requests and assigns a session per connection. Disk KV checkpoints persist session state to disk before `ds4_session_free`, then re-load on the next request — see [Chapter 14 (Disk KV cache)](14-disk-kv-cache.md). HTTP and agent specifics are in [Chapter 13 (HTTP server and Agent API)](13-http-server-api.md).
- **The GPT-2 byte map** is the same encoding used at tokenization time (tour-04 / tour-06). The forward map is in the tokenizer chapter; this teardown step is its inverse. See [Chapter 05 (Tokenizer and chat template)](05-tokenizer-chat.md).
- **MTP teardown.** When MTP is loaded, both `mtp_model` and the main `model` are mmapped; `ds4_engine_close` calls `model_close` on both in the right order. See [Chapter 12 (Speculative decoding and MTP)](12-speculative-mtp.md).
- **The instance lock.** Released at the very end of `ds4_engine_close` via `ds4_release_instance_lock` — covered in [Chapter 01 (Architecture overview)](01-architecture-overview.md). Skipping this release is a common bug in test harnesses that `kill -9` ds4 mid-run.

## 8. What you should now have in your head

- **`ds4_token_text` is a byte decoder, not a string fetch.** It walks the vocab string code-point by code-point and reverses the GPT-2 byte map. The output is raw bytes; concatenation of per-token outputs equals the original tokenized text.
- **The printer buffers up to 16 bytes in `pending[]`** for cross-token `<think>` / `</think>` matching. Without that buffer, a token boundary that splits the tag would defeat thinking-mode coloring.
- **`generation_done` is responsible for three closing acts**: flush any pending partial-tag bytes, reset the ANSI color, and emit a trailing newline if the last output character was not one. All three are required for the shell prompt to redraw cleanly.
- **Teardown is strict reverse of boot.** Session before engine; weights/vocab before models; MTP model before main model; GPU cleanup before instance-lock release; `munmap` is the symmetric counterpart of tour-02's `mmap`.
- **The trace ends here.** From tour-01 (CLI parse) through tour-13 (logits head) to tour-14/15/16 (sample/decode loop) and now tour-17 — `./ds4 -m DS4.gguf -p "hello" -n 3` has produced 3 tokens, flushed them to stdout, freed every byte ds4 allocated, unmapped the GGUF, released the instance lock, and returned `0`. The next shell prompt is one newline below the last generated token.

*That concludes the narrative trace. To deepen any subsystem you saw flash past — sampling chains, the streaming compressor, the Metal decode graph, the chat template, the disk KV format — return to the reference chapters via the sidebar; each one takes its thread further than a single trace can.*
