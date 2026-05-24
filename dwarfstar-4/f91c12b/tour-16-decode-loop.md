# Tour Step 16: The decode loop — sample, decode, repeat until 3 (or EOS)

> Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

We have walked through one full iteration of the loop: tour-14 sampled `t1`, tour-15 fed it back, the KV cache absorbed one new row, `session->logits` was overwritten with the logits for position `prompt.len + 1`. Now control returns to the top of the `while` block in `run_sampled_generation` ([`ds4_cli.c:523`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L523)):

```
generated   = 1            // we have printed one piece in tour-15 → tour-16's inner loop
max_tokens  = 3            // -n 3 from CLI, possibly clamped to room - 1 by line 517
rng         = <advanced one xorshift step from tour-14>
session     = <KV cache holds prompt + t1; logits ready for position after t1>
```

The job of this step is to repeat the sample→decode pair until one of four stop conditions fires, then run the post-loop cleanup. For our trace, the natural stop condition will be `generated >= max_tokens` after the loop body has run three times. We will also describe the three other stop conditions because the loop is identical for many real prompts that hit them.

## 2. The problem

> The decode loop must produce exactly `n_predict` tokens — but it also must stop early on EOS, on Ctrl-C, when the context window would overflow, and (for the agent path) on certain in-think tool-call malformations. It must not silently overrun any of those boundaries, and the four conditions must compose without one masking another.

## 3. Naive approach

```c
for (int i = 0; i < n_predict; i++) {
    int token = sample(session);
    if (token == EOS) break;
    print(token);
    eval(session, token);
}
```

Three lines, one obvious break. This is essentially what `llama.cpp` examples used to ship with, and for short generations against a never-EOS prompt it works.

## 4. Why the naive approach breaks

Each of the missing conditions has a concrete failure:

- **Context-window overflow.** `n_predict` is a user request; `ctx_size` is the physical KV cache capacity. With `-n 500000 --ctx 32768` the naive loop will start writing past the end of the raw SWA ring buffer's logical size, or — worse, depending on backend — silently overwrite live rows and produce garbage logits with no error. The loop has no view of "rows left in cache".
- **Ctrl-C is ignored mid-step.** The SIGINT handler at [`ds4_cli.c:61-64`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L61) sets a `volatile sig_atomic_t` flag. If the loop body never polls it, the user must wait until **all `n_predict` tokens** have been generated before the CLI returns to the shell — perceived as "hung".
- **EOS inside a speculative batch.** The greedy path may run `ds4_session_eval_speculative_argmax` and accept several tokens in one call (`toks[0..ntok-1]`). If EOS is in the middle of that batch, a naive `if (token == EOS) break` placed before the decode call misses it entirely, because the EOS token id only appears in `toks[]`, not as the outer `token`.
- **In-think tool calls (recent change).** Commit `b63d77a` ("Stop generation on in-think tool calls") added an extra stop condition specifically for the agent path: if the model emits a tool call inside a `<think>` block, generation must halt — that is malformed protocol. This is a logical stop that the four-condition list above does not cover, so the agent layer above the engine adds its own check on top.

The core issue is that "stop conditions" are not a single boolean: they are a small fixed set whose order matters, and each must be checked at the right point in the loop body.

## 5. ds4's approach

ds4's approach is to **fold three of the four conditions into the `while` predicate or pre-loop arithmetic, check EOS twice (once on the sampled token, once on every token in a speculative batch), and let the agent layer add its in-think check on top of the same engine API**.

The `while` predicate at [`ds4_cli.c:523`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L523):

```c
while (generated < max_tokens && !cli_interrupt_requested()) {
```

- `generated < max_tokens` covers both the `-n` cap **and** the context-window overflow. Overflow is handled **before** the loop, at [`ds4_cli.c:514-517`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L514):
  ```c
  int max_tokens = cfg->gen.n_predict;
  int room = ds4_session_ctx(session) - ds4_session_pos(session);
  if (room <= 1) max_tokens = 0;
  else if (max_tokens > room - 1) max_tokens = room - 1;
  ```
  `max_tokens` is clamped to `room - 1` so the loop body's single decode never tries to write a row that does not exist. No per-iteration branch required.
- `!cli_interrupt_requested()` reads the volatile SIGINT flag every iteration. Polling cost is one memory read; on Ctrl-C the loop exits between decode steps with a latency of at most one decode call.

Inside the body, [`ds4_cli.c:524-526`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L524) does the first EOS check:

```c
int token = ds4_session_sample(session, cfg->gen.temperature, 0,
                               cfg->gen.top_p, cfg->gen.min_p, &rng);
if (token == ds4_token_eos(engine)) break;
```

Then the speculative-or-ordinary fork at [`ds4_cli.c:530-553`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L530):

```c
if (cfg->gen.temperature <= 0.0f &&
    ds4_engine_mtp_draft_tokens(engine) > 1 &&
    getenv("DS4_MTP_SPEC_DISABLE") == NULL) {
    ntok = ds4_session_eval_speculative_argmax(session, token, max_tokens - generated,
                                               ds4_token_eos(engine), toks, 17,
                                               err, sizeof(err));
    ...
} else {
    if (ds4_session_eval(session, token, ...) != 0) { ... }
    toks[0] = token;
    ntok = 1;
}
```

For our trace `temperature = 1.0 > 0`, so the speculative branch is never taken; `ntok` is always `1` and `toks[0]` is the just-sampled token. (If speculative had run, the engine itself stops accumulating at EOS — see the `eos_token` parameter passed in.)

The inner `for j` loop at [`ds4_cli.c:555-568`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L555) is the second EOS check and the printer dispatch:

```c
bool stop = false;
for (int j = 0; j < ntok; j++) {
    if (toks[j] == ds4_token_eos(engine)) {
        stop = true;
        break;                                       // EOS inside a batch
    }
    char *piece = ds4_token_text(engine, toks[j], &piece_len);
    token_printer_write_text(&printer, piece, piece_len);   // see tour-17
    fflush(stdout);
    free(piece);
    generated++;
    if (generated >= max_tokens) break;
}
if (stop) break;
```

For our trace this fires three times: each iteration sets `ntok = 1`, prints one piece, increments `generated`, the outer `while` then re-checks and on iteration four sees `generated == 3` and exits cleanly.

Post-loop ([`ds4_cli.c:571-584`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L571)):

```c
const double t_decode1 = cli_now_sec();
generation_done(&printer);                           // flush any pending bytes (tour-17)
if (cli_interrupt_requested()) cli_interrupt_clear();
ds4_log(stderr, DS4_LOG_TIMING,
        "ds4: prefill: %.2f t/s, generation: %.2f t/s\n", ...);
ds4_session_free(session);                           // see tour-17
return 0;
```

Four stop conditions, four code locations, all in this 60-line block:

| Stop reason | Where it fires |
|---|---|
| `generated >= max_tokens` (incl. context-window clamp) | [`ds4_cli.c:523`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L523) `while` predicate + [`:567`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L567) inner-loop break |
| EOS on a freshly sampled token | [`ds4_cli.c:526`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L526) |
| EOS inside a speculative batch | [`ds4_cli.c:557-560`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L557) |
| Ctrl-C (SIGINT) | [`ds4_cli.c:523`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L523) `!cli_interrupt_requested()` |

The recent `b63d77a` commit adds a fifth condition that lives **outside** the CLI loop, in the agent worker at [`ds4_agent.c:7275-7278`](https://github.com/antirez/ds4/blob/f91c12b/ds4_agent.c#L7275):

```c
if (stream.dsml_in_think) {
    malformed_tool = true;
    break;
}
```

The agent re-implements its own loop around the same engine API, and treats a partial DSML tool-call landing inside `<think>` as a hard stop — because the tool would never actually execute, and continuing would burn tokens producing more invalid text. The engine itself does not know about think tags or tool-call grammar; that knowledge lives one layer up.

## 6. Code locations

- [`ds4_cli.c:475`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L475) — `run_sampled_generation`, the function that owns this loop.
- [`ds4_cli.c:514-517`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L514) — pre-loop `room` arithmetic that converts context-window-overflow into a `max_tokens` clamp.
- [`ds4_cli.c:519-520`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L519) — RNG seed mix: `time ^ (pid << 32) ^ clock`, or `--seed` if given.
- [`ds4_cli.c:523`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L523) — `while` predicate combining `max_tokens` cap and SIGINT poll.
- [`ds4_cli.c:524-525`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L524) — `ds4_session_sample` call (tour-14).
- [`ds4_cli.c:526`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L526) — first EOS check on the sampled token.
- [`ds4_cli.c:530-544`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L530) — speculative branch (`temperature <= 0 && mtp_draft_tokens > 1 && !DS4_MTP_SPEC_DISABLE`).
- [`ds4_cli.c:545-553`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L545) — ordinary `ds4_session_eval` branch (tour-15); this is the branch our trace takes.
- [`ds4_cli.c:555-569`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L555) — inner per-token loop with second EOS check and printer call.
- [`ds4_cli.c:571-584`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L571) — post-loop timing, generation_done, interrupt clear, session free.
- [`ds4_cli.c:59-71`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L59) — `cli_interrupted` flag, `cli_sigint_handler`, `cli_interrupt_requested`, `cli_interrupt_clear`.
- [`ds4.c:18924`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18924) — `ds4_session_pos`: returns `checkpoint.len`.
- [`ds4.c:18928`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18928) — `ds4_session_ctx`: returns `ctx_size`.
- [`ds4.c:15412`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15412) — `ds4_token_eos`: reads `vocab.eos_id`.
- [`ds4_agent.c:7275-7278`](https://github.com/antirez/ds4/blob/f91c12b/ds4_agent.c#L7275) — the `b63d77a` in-think tool-call stop in the agent's own loop.
- [`ds4_agent.c:7283-7289`](https://github.com/antirez/ds4/blob/f91c12b/ds4_agent.c#L7283) — the post-loop in-think error message: "tool calling is not allowed inside `<think></think>`" (same `b63d77a` commit).

## 7. Branches and extensions

- **`temperature == 0` + MTP** route to the speculative branch and pull several tokens per Metal command buffer. Same outer `while`, same EOS-batch check, different `ntok` distribution. The verifier ensures `toks[0..ntok-1]` matches the target greedy stream up to and including any EOS, then stops. See [Chapter 12 (Speculative decoding and MTP)](12-speculative-mtp.md).
- **REPL loop** (`run_repl` at [`ds4_cli.c:1167`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L1167) onward) re-uses an identical loop structure but keeps the session across turns; the session re-prefills only what changed (`ds4_session_sync`). The session lifecycle and prefix reuse are in [Chapter 06 (Engine and session)](06-engine-session.md).
- **HTTP server** (`ds4_server.c`) does *not* call `run_sampled_generation`; it has its own loop that injects a per-request stop callback (client disconnected, request `max_tokens` cap, custom stop strings) on top of the same `ds4_session_sample` / `ds4_session_eval` pair. See [Chapter 13 (HTTP server and Agent API)](13-http-server-api.md).
- **Agent worker loop** ([`ds4_agent.c`](https://github.com/antirez/ds4/blob/f91c12b/ds4_agent.c)) is the deepest re-implementation: it parses streaming DSML tool calls, fires tools when the closing tag arrives, and is the layer that owns the in-think check from `b63d77a`. The agent's relationship to the engine — and where its loop diverges from the CLI's — is in [Chapter 13 (HTTP server and Agent API)](13-http-server-api.md).
- **Argmax-only fast path.** When `temperature == 0` *and* MTP is not available, `run_generation` at [`ds4_cli.c:967`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L967) chooses `ds4_engine_generate_argmax` instead of `run_sampled_generation`. That alternative function ([`ds4.h:111`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L111)) has its own loop with a tighter, callback-based API; same stop conditions, different orchestration.

## 8. What you should now have in your head

- **Context-window overflow is handled pre-loop** by clamping `max_tokens` to `room - 1`. No branch inside the body has to check "is the cache full?".
- **EOS is checked twice**: once on the freshly sampled token before the decode call, and once per element of the speculative batch after it. Both are required because speculative decode can have EOS in the interior.
- **Ctrl-C polling is one volatile read per outer iteration**, giving sub-decode-step latency on cancel. The flag is cleared *after* the loop, so a single interrupt cleanly exits and leaves the shell handler in a normal state.
- **The agent worker has its own stop condition** for in-think tool calls (`b63d77a`); that knowledge belongs above the engine, not inside it. The engine API stays neutral about prompt grammar.
- For our trace (`-n 3`, no EOS, no interrupt), the loop body runs **three** times, `generated` walks `0 → 1 → 2 → 3`, the `while` predicate flips false, and control falls through to `generation_done` / `ds4_session_free` (tour-17). No early branch was ever taken.
