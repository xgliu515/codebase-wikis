# Tour Step 14: From logits to a token id

> Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

The logits head has just fired. `session->logits` is a freshly-written `float[DS4_N_VOCAB]` (129 280 entries) sitting in CPU memory, copied back from the GPU at the end of tour-13. Each entry is an unnormalized score for "the next token is token `i`". No probability has been computed yet; no token id has been chosen.

We are now inside the first iteration of the decode loop in `run_sampled_generation` (`ds4_cli.c:475`). The CLI defaults flowed in from tour-01 are:

- `cfg->gen.temperature` = `DS4_DEFAULT_TEMPERATURE` = `1.0f` (`ds4.h:53`, `ds4_cli.c:1422`)
- `cfg->gen.top_p` = `DS4_DEFAULT_TOP_P` = `1.0f` (`ds4.h:54`, `ds4_cli.c:1423`)
- `cfg->gen.min_p` = `DS4_DEFAULT_MIN_P` = `0.05f` (`ds4.h:55`, `ds4_cli.c:1424`)

The next line of code about to execute is `ds4_cli.c:524`:

```c
int token = ds4_session_sample(session, cfg->gen.temperature, 0,
                               cfg->gen.top_p, cfg->gen.min_p, &rng);
```

By the end of this step `token` holds one integer in `[0, 129 280)` and the rng state has been advanced one xorshift step. The KV cache has not changed; `session->checkpoint` still has length `prompt.len`. Printing and decoding happen in later steps.

## 2. The problem

> Given a vector of 129 280 unnormalized logits, choose **one** token id. Different choices produce wildly different output quality; a bad rule turns a competent language model into a degenerate loop, a noisy babbler, or a deterministic parrot. The strategy also has to honor a temperature parameter whose `0` value is supposed to mean "be greedy".

## 3. Naive approach

Two obvious choices, each maximally simple:

- **Pure argmax** — scan the array, return the index of the maximum value. Deterministic, O(vocab), one line.
- **Full softmax sampling** — softmax over all 129 280 entries, draw one token by weighted random sampling. Maximum diversity, also O(vocab).

Either of these can be written in ten lines and will technically "work" — the model will emit a token id and decoding will proceed.

## 4. Why the naive approach breaks

Each of the two naive rules has a well-documented failure mode in real LLM serving:

- **Pure argmax degenerates.** Greedy decoding aggressively re-emits whatever token has the locally highest logit. In practice this produces loops ("the the the" / "是是是") because the model's logit landscape, fed back its own argmax, settles into a fixed point. The output is reproducible but useless for any creative task.
- **Full softmax sampling is noisy.** The 129 280-token vocab has a long tail of completions that are syntactically valid but semantically absurd in the current context. A pure-softmax draw assigns each tail token a tiny but **nonzero** probability; over a few hundred decoded tokens you will hit one and the output goes off the rails.
- **Fixed top-k is brittle.** Truncating to the top 40 (or 50, or 100) tokens is the classical fix, but the right `k` is context-dependent: in confident contexts the model concentrates almost all mass on 2-3 tokens (so k=40 still leaks junk); in genuinely ambiguous contexts there may be 200+ reasonable continuations (so k=40 over-truncates).
- **Fixed top-p has the same problem.** Cumulative-probability cutoff `p=0.9` adapts somewhat, but on a peaked distribution (one near-1.0 token) the long tail past the peak still fits inside `1 - 0.9 = 0.1` and contributes garbage.
- **Temperature=0 must take a different branch.** The semantics of `temperature=0` is "no randomness at all". A random-sampling pipeline applied at `T → 0` blows up numerically (`exp(x / 0)` is undefined). The branch has to be explicit.

The tension: a single fixed strategy cannot adapt to both confident and ambiguous contexts, and the temperature dial requires the path itself to fork.

## 5. ds4's approach

ds4's approach is to **default to min-p relative filtering combined with full-vocab softmax sampling**, fork at `temperature <= 0` straight into argmax, and short-circuit when `top_p == 1` so the common CLI path never sorts the vocabulary.

The public entry point is `ds4_session_sample` at [`ds4.h:183`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L183) and [`ds4.c:18159`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18159):

```c
int ds4_session_sample(ds4_session *s, float temperature, int top_k,
                       float top_p, float min_p, uint64_t *rng) {
    return sample_top_p_min_p(s->logits, DS4_N_VOCAB,
                              temperature, top_k, top_p, min_p, rng);
}
```

It is a pure logits-in, token-id-out function — no session mutation. Forwarding goes to `sample_top_p_min_p` at [`ds4.c:15573`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15573), which is the dispatch hub:

```c
static int sample_top_p_min_p(const float *logits, uint32_t n_vocab,
                              float temperature, int top_k, float top_p,
                              float min_p, uint64_t *rng) {
    if (temperature <= 0.0f) return sample_argmax(logits, n_vocab);   // greedy
    if (top_p <= 0.0f || top_p > 1.0f) top_p = 1.0f;
    if (min_p < 0.0f) min_p = 0.0f;
    if (top_k <= 0)
        return sample_full_vocab(logits, n_vocab, temperature, top_p, min_p, rng);
    ...
}
```

The CLI passes `top_k = 0` (see [`ds4_cli.c:524`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L524)), so for our trace control enters `sample_full_vocab`. Because `top_p` is also exactly `1.0`, we hit the fast path at [`ds4.c:15505`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15505):

```c
if (top_p >= 1.0f) {
    float sum = 0.0f;
    const float min_rel = min_p > 0.0f ? min_p : 0.0f;
    for (uint32_t i = 0; i < n_vocab; i++) {
        const float v = logits[i];
        if (!isfinite(v)) continue;
        const float p = expf((v - max_logit) / temperature);
        if (p < min_rel) continue;                      // min-p filter
        sum += p;
    }
    if (sum <= 0.0f || !isfinite(sum)) return best;
    float r = sample_rng_f32(rng) * sum;
    for (uint32_t i = 0; i < n_vocab; i++) {
        const float v = logits[i];
        if (!isfinite(v)) continue;
        const float p = expf((v - max_logit) / temperature);
        if (p < min_rel) continue;
        r -= p;
        if (r <= 0.0f) return (int)i;
    }
    return best;
}
```

Two key properties of this code worth flagging:

1. **`min_rel` is compared against `exp((v - max_logit)/T)`, which is the **un-normalized** softmax weight relative to the top token.** Algebraically this is identical to `p_i / p_max >= min_p` (since both sides share the same normalizer). The point: min-p uses a **relative** cutoff — keep any token whose probability is at least 5% of the top token's probability. This adapts automatically: on a peaked distribution the candidate set shrinks to 1-3 tokens; on a flat distribution it expands to dozens. No fixed `k` to tune.
2. **Two linear passes, no sort.** First pass computes `sum` of surviving weights; second pass picks the random offset and returns. O(vocab) time, zero heap allocation. This is the hot path that fires every decoded token.

The slow branch — when the caller actually sets `top_p < 1.0` — is the code below `15528` in `sample_full_vocab`: it allocates a candidate array, sorts descending, applies min-p **and** cumulative top-p, then samples. This trace never enters it because the CLI default keeps `top_p = 1.0`.

The other branch worth knowing is `temperature <= 0.0f` at [`ds4.c:15581`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15581): control immediately returns `sample_argmax` (defined at [`ds4.c:15424`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15424); the public wrapper `ds4_session_argmax` is at [`ds4.c:18140`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18140)). This branch is what `run_generation` at [`ds4_cli.c:951`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L951) keys off: if `temperature == 0` **and** MTP is not present, the code at [`ds4_cli.c:967`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L967) calls `ds4_engine_generate_argmax` instead of `run_sampled_generation` — argmax has its own dedicated entry point because greedy decoding unlocks MTP speculative decoding (see tour-16).

For our trace (`temperature = 1.0`, `top_p = 1.0`, `min_p = 0.05`), one call returns an integer token id. The RNG is an `uint64_t` state seeded at [`ds4_cli.c:519`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L519) from `time(NULL) ^ (pid << 32) ^ clock()` (or a user-supplied `--seed`). `sample_rng_f32` advances it by one xorshift64 step and returns a uniform float in `[0, 1)`.

## 6. Code locations

- [`ds4.h:53-55`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L53) — `DS4_DEFAULT_TEMPERATURE`, `DS4_DEFAULT_TOP_P`, `DS4_DEFAULT_MIN_P` constants.
- [`ds4.h:183`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L183) — `ds4_session_sample` public signature.
- [`ds4.c:18159`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18159) — `ds4_session_sample` impl: pure delegation to `sample_top_p_min_p`.
- [`ds4.c:15573`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15573) — `sample_top_p_min_p` dispatcher: `temperature <= 0` → argmax; `top_k <= 0` → full-vocab; otherwise top-k truncation.
- [`ds4.c:15581`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15581) — the `temperature <= 0.0f` early return.
- [`ds4.c:15505`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15505) — the `top_p >= 1.0f` fast path: two linear scans, no sort.
- [`ds4.c:15528`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15528) — the slow path: allocate, sort descending, apply min-p + top-p, then sample.
- [`ds4.c:15511-15512`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15511) — the actual min-p filter line (`if (p < min_rel) continue;`).
- [`ds4.c:18140`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18140) — `ds4_session_argmax`: the greedy alternative invoked when `temperature == 0`.
- [`ds4.c:15424`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15424) — `sample_argmax`: the internal scan helper.
- [`ds4_cli.c:519`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L519) — RNG seed mix: `time ^ (pid << 32) ^ clock`.
- [`ds4_cli.c:524`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L524) — the call site we are tracing: `ds4_session_sample(..., temperature, 0, top_p, min_p, &rng)`.
- [`ds4_cli.c:951`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L951) — `run_generation` fork: `temperature > 0 || mtp_draft_tokens > 1` → `run_sampled_generation`; else `ds4_engine_generate_argmax`.
- [`ds4_cli.c:1422-1424`](https://github.com/antirez/ds4/blob/f91c12b/ds4_cli.c#L1422) — CLI defaults applied during `parse_options`.

## 7. Branches and extensions

Branches deliberately skipped on this trace:

- **`temperature == 0` + MTP available** routes to `ds4_engine_generate_argmax` and inside the loop to `ds4_session_eval_speculative_argmax`. Speculative decoding only fires under greedy because correctness verification needs a deterministic target. See [Chapter 12 (Speculative decoding & MTP)](12-speculative-mtp.md) for the verifier state machine and acceptance accounting.
- **`top_p < 1.0` slow path** allocates, sorts, then applies both filters together. This is what classical Nucleus + min-p combinations exercise. The arithmetic interaction (top-p is computed from already-min-p-survivors' renormalized sum) is in [`ds4.c:15528`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15528)-15571. The reference for sampling-chain design lives in [Chapter 06 (Engine and session)](06-engine-session.md).
- **`top_k > 0` branch** of `sample_top_p_min_p` uses a 1024-entry insertion-sort heap to keep candidate budget bounded (see [`ds4.c:15585-15633`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L15585)). The HTTP server passes whatever `top_k` the JSON request body specified — see [Chapter 13 (HTTP server and Agent API)](13-http-server-api.md) for the request → sampling-param mapping.
- **Token logprob inspection** (`ds4_session_top_logprobs` at [`ds4.c:18163`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18163), `ds4_session_token_logprob` at [`ds4.c:18200`](https://github.com/antirez/ds4/blob/f91c12b/ds4.c#L18200)) is the introspection side-channel used by `--dump-logprobs`. It does the full softmax explicitly (with max-shift for numerical stability), unlike the fast path which never normalizes.
- **Bench / eval / agent paths** call `ds4_session_sample` with their own parameter sets; the engine boundary at [`ds4.h:183`](https://github.com/antirez/ds4/blob/f91c12b/ds4.h#L183) is intentionally just `(logits, T, k, p, min_p, rng) -> id`. See [Chapter 06 (Engine and session)](06-engine-session.md) for why the session never stores the sampling config.

## 8. What you should now have in your head

- **Temperature forks execution**: `<= 0` returns argmax immediately; `> 0` runs the random-sampling pipeline. The CLI default is `1.0`, so our trace samples.
- **min-p is a relative cutoff**, not absolute: keep tokens whose probability is at least `min_p` (5% by default) of the top token's probability. The candidate set self-adapts to context — peaked distributions yield 1-3 candidates, flat ones yield dozens, no `k` to tune.
- **The `top_p == 1.0` fast path is two linear scans of the 129 280-entry logits array, no sort, no heap allocation.** This is the per-token sampling cost on the default CLI run.
- **`ds4_session_sample` is purely logits-in, id-out** — it does not touch `session->checkpoint`, the KV cache, or the rng caller's state beyond advancing one xorshift step. The KV mutation happens in tour-15 when `ds4_session_eval` feeds the sampled token back.
- The arithmetic identity `p_i / p_max = exp((logit_i - max_logit) / T)` is why the fast path can compare against `min_p` directly on the **unnormalized** weight without ever computing the sum first.
