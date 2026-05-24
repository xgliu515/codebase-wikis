# Tour Step 01: CLI parsing & backend selection

Code version locked to `antirez/ds4@f91c12b` (main, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## 1. Current situation

There is no ds4 inference state. There is a shell, a user, and a `./ds4` binary built from this checkout. The user types:

```
./ds4 -m DS4.gguf -p "hello" -n 3
```

and presses Enter. The kernel `execve`s the binary, libc walks through its startup machinery, and control reaches the C entry point at `ds4_cli.c:1571`:

```c
int main(int argc, char **argv) {
    cli_config cfg = parse_options(argc, argv);
    ...
}
```

`argv` is a flat array of seven C strings:

```
argv[0] = "./ds4"
argv[1] = "-m"
argv[2] = "DS4.gguf"
argv[3] = "-p"
argv[4] = "hello"
argv[5] = "-n"
argv[6] = "3"
```

The process owns absolutely nothing inference-related yet: no model is mmap'd, no tokenizer is loaded, no Metal device handle exists. The total in-memory footprint is whatever libc startup pulled in. Our job in this step is to walk from "`int main` has begun" to "a fully populated `cli_config` is sitting on `main`'s stack, the next line about to execute is `ds4_engine_open`". The transition consists of exactly one function: `parse_options`.

## 2. The problem

A CLI argument vector is a sequence of opaque strings. The next stage of the program (`ds4_engine_open` and everything below it) wants a structured C `struct` whose every field is typed, validated, and has a meaningful default — including fields the user did not mention. Concretely the parser must solve four problems at once:

> **Missing fields need sensible defaults.** The user passed three flags; the engine needs to know the context window size, the sampling temperature, the backend, the system prompt, and a dozen more things. A null or zero value for any of these is a bug, not a default.
>
> **String → typed value conversion must happen at parse time.** `"3"` becomes `int 3` for `n_predict`; `"hello"` stays a `const char *`. Conversion failures must be reported in plain language now, not crash deep inside an attention kernel later.
>
> **The backend is platform-conditional.** The user did not write `--metal` or `--cuda`. On Apple Silicon the only choice that will actually work is Metal; on a Linux DGX it is CUDA; on a build configured with `DS4_NO_GPU` it must be CPU.
>
> **Cross-flag invariants need checking.** `--imatrix-out` requires `--imatrix-dataset`; `--perplexity-file` is incompatible with `-p`. These are caught **after** the parse loop and **before** the engine opens.

By the end of this step every one of those is resolved or the program has exited with a clear stderr message and exit code 2.

## 3. Naive approach

The textbook answer is `getopt` (or its `getopt_long` cousin). Define a `cli_config` struct, zero-initialize it, hand `argv` to `getopt`, switch on the returned short option character, and `atoi` the integer arguments. If a field was not set, it stays zero. For "what is the default backend?" simply pick one constant and document it.

There is nothing wrong with `getopt`. It exists exactly to solve "parse this argv". For many programs it is the right answer.

## 4. Why the naive approach breaks

For an inference engine, however, the naive approach has four concrete failure modes:

- **Zero is almost never a valid default for an inference parameter.** `ctx_size = 0` allocates a zero-byte KV cache; the first prompt token immediately overflows. `temperature = 0.0f` is a legal value (greedy), so leaving it as zero is indistinguishable from "user wanted greedy", which silently changes behavior. `n_predict = 0` means generate nothing — the binary runs to completion in milliseconds and emits no output. `backend = DS4_BACKEND_METAL` happens to be `enum` value 0 (`ds4.h:18`), so on a Linux build a zero-initialized config silently asks for the Metal framework that does not exist. The structural property "zero is a valid C initializer" collides with the semantic property "zero is meaningless for this field" on nearly every parameter.
- **`getopt`'s string→value conversion is `atoi`, which silently returns 0 on garbage.** `atoi("abc")` is `0`, with no error. `atoi("3.5")` is `3`, dropping the fractional part. Both are landmines: a typo'd `--temp 0.q` produces a config that runs without complaint and gives surprising output.
- **A single hardcoded default backend cannot work across all builds.** This project ships one source tree to macOS users (Metal), to Linux GPU users (CUDA), and as a `DS4_NO_GPU=1` CPU-only build for benchmarks. Picking any single default at compile time of the parse code would force two-thirds of users to always type the flag.
- **Cross-flag invariants are not what `getopt` is for.** `getopt` knows about short options and their argument arity; it has no concept of "`--imatrix-out` is meaningless without `--imatrix-dataset`". Those checks must happen somewhere; deferring them inside `ds4_engine_open` means the engine spends 30 seconds mmaping a 24 GiB GGUF before discovering that you forgot a flag.

The root tension: a CLI parser for an inference engine is not just a string-to-struct mapper, it is the **place where every operational invariant must be sealed before any expensive resource is touched**. The naive approach defers all four problems to "later", and "later" is always inside something expensive.

## 5. ds4's approach

ds4's approach is to write the parser by hand — a single 160-line function called `parse_options` (`ds4_cli.c:1409`) — and to solve each of the four problems explicitly:

**Problem 1, defaults: start from a literal struct, not from zero.** The very first statement inside `parse_options` is a designated initializer that writes every default value (`ds4_cli.c:1410-1428`):

```c
cli_config c = {
    .engine = {
        .model_path = "ds4flash.gguf",
        .backend = default_backend(),
        .mtp_draft_tokens = 1,
        .mtp_margin = 3.0f,
    },
    .gen = {
        .prompt = NULL,
        .system = "You are a helpful assistant",
        .n_predict = 50000,
        .ctx_size = 32768,
        .temperature = DS4_DEFAULT_TEMPERATURE,   /* 1.0f */
        .top_p = DS4_DEFAULT_TOP_P,               /* 1.0f */
        .min_p = DS4_DEFAULT_MIN_P,               /* 0.05f */
        .dump_logprobs_top_k = 20,
        .think_mode = DS4_THINK_HIGH,
    },
};
```

Every field has an operational meaning before any argv has been read. `prompt = NULL` is the one deliberate exception — a null prompt is the signal that the user wants the interactive REPL rather than one-shot mode (`ds4_cli.c:1606`).

**Problem 2, conversion with validation, at parse time.** The hand-rolled converters `parse_int`, `parse_u64`, and `parse_float_range` (`ds4_cli.c:207`, `217`, `227`) use `strtol`/`strtoull`/`strtof` (not `atoi`), check `*end == '\0'` so trailing garbage fails, enforce positive-and-bounded ranges, and on any failure print `ds4: invalid value for %s: %s` then `exit(2)`. Type errors die at parse time with a sentence the user can act on.

**Problem 3, backend selected at compile time, applied at parse time.** `default_backend` (`ds4_cli.c:246`) is a three-line `#if` ladder:

```c
static ds4_backend default_backend(void) {
#ifdef DS4_NO_GPU
    return DS4_BACKEND_CPU;
#elif defined(__APPLE__)
    return DS4_BACKEND_METAL;
#else
    return DS4_BACKEND_CUDA;
#endif
}
```

The macOS build of `./ds4` baked Metal in at compile time; the Linux build baked CUDA in; both at the same source line. The user never has to think about it. A user who wants a different backend can override with `--metal`, `--cuda`, `--cpu`, or `--backend NAME`, and `parse_backend` (`ds4_cli.c:237`) validates the string against the three legal values.

**Problem 4, override loop then invariant check.** After defaults, the for-loop at `ds4_cli.c:1431` walks argv linearly. Each branch uses `strcmp` against the long and short form. `need_arg` (`ds4_cli.c:1354`) advances `i` and exits if a flag is missing its value. Unrecognized flags fall through to `else` at `ds4_cli.c:1545` which prints the usage text and `exit(2)`. After the loop, three explicit cross-flag checks at `ds4_cli.c:1552-1566`:

```c
if (c.gen.imatrix_output_path && !c.gen.imatrix_dataset_path) {
    fprintf(stderr, "ds4: --imatrix-out requires --imatrix-dataset\n");
    exit(2);
}
```

For our specific command `./ds4 -m DS4.gguf -p "hello" -n 3`, the loop produces (on an Apple build):

```
c.engine.model_path     = "DS4.gguf"
c.engine.backend        = DS4_BACKEND_METAL  /* via default_backend() */
c.gen.prompt            = "hello"
c.gen.n_predict         = 3
c.gen.ctx_size          = 32768               /* default kept */
c.gen.temperature       = 1.0f                /* default kept */
c.gen.system            = "You are a helpful assistant"
c.gen.think_mode        = DS4_THINK_HIGH
/* every other field at its struct-literal default */
```

`temperature == 1.0f > 0` matters: it determines which generation branch fires in `run_generation` (`ds4_cli.c:951`). Greedy generation requires explicitly setting `--temp 0`. The default path is **sampled** generation.

Control then returns to `main` at `ds4_cli.c:1572`. Two non-engine actions happen before `ds4_engine_open`: a memory-budget log line is printed (`log_context_memory`, `ds4_cli.c:1586`) so the user sees the predicted KV cache size before paying for it, and a thinking-mode downgrade warning fires if `--think-max` was requested at a too-small context (not our case). Then `ds4_engine_open(&engine, &cfg.engine)` at `ds4_cli.c:1590` — that is the next step.

The whole sequence is one long argument against the naive approach: every check above — explicit defaults instead of zero, validated converters, compile-time platform-conditional backend, post-loop invariants — corresponds to one of the failure modes in section 4.

## 6. Code locations

- `ds4_cli.c:26-50` — `cli_generation_options` struct definition. Every field this parser writes lives here or in `cli_config` below it.
- `ds4_cli.c:52-57` — `cli_config` struct: an `engine` sub-struct (passed to `ds4_engine_open`), a `gen` sub-struct (read by `run_generation`), and a `prompt_owned` ownership pointer for `--prompt-file`.
- `ds4_cli.c:207-235` — `parse_int`, `parse_u64`, `parse_float_range`: validated string→number converters.
- `ds4_cli.c:237-244` — `parse_backend`: validates `--backend NAME` against `metal`/`cuda`/`cpu`.
- `ds4_cli.c:246-254` — `default_backend`: compile-time platform fork (`__APPLE__` → Metal, `DS4_NO_GPU` → CPU, else CUDA).
- `ds4_cli.c:256-266` — `log_context_memory`: predicted KV cache memory printed before `ds4_engine_open` so users see the bill before paying.
- `ds4_cli.c:1354-1360` — `need_arg`: helper that exits if a flag's value is missing.
- `ds4_cli.c:1409-1428` — `parse_options` defaults struct.
- `ds4_cli.c:1431-1550` — the parse loop body. Every flag the CLI accepts is here.
- `ds4_cli.c:1552-1566` — post-loop cross-flag invariants.
- `ds4_cli.c:1571-1614` — `main`: calls `parse_options`, optionally short-circuits for `--dump-tokens`, then `ds4_engine_open`, then dispatches to `run_repl` / `run_generation` / `ds4_engine_collect_imatrix` / `run_perplexity_file`.
- `ds4.h:53-55` — the three `DS4_DEFAULT_*` constants that anchor the sampling defaults.

## 7. Branches and extensions

We followed only the bare `-m -p -n` invocation. The branches we deliberately did not walk:

- **HTTP server entry.** A separate binary `ds4-server` (built from `ds4_server.c`) takes configuration from request JSON instead of `argv`. The `cli_config` analog there comes from `chat/completions` body parsing, not a parse loop. See [13-http-server-api.md](./13-http-server-api.md) for that entry point.
- **MTP / speculative decoding.** `--mtp PATH`, `--mtp-draft N`, `--mtp-margin F` enable a second model load and a draft-then-verify decode loop. Tour steps 15-16 mention how decode would differ; for the design see [12-speculative-mtp.md](./12-speculative-mtp.md).
- **Thinking-mode prompt rendering.** `--think`, `--think-max`, `--nothink` (`ds4_cli.c:1516-1521`) change which assistant prefix the chat encoder emits. The `--think-max` flag also has a context-size precondition (`ds4_think_mode_for_context` in `ds4.h:107`) that downgrades to normal thinking on short contexts. See [05-tokenizer-chat.md](./05-tokenizer-chat.md) for the chat template machinery.
- **Diagnostic commands.** `--dump-tokens`, `--dump-logits`, `--dump-logprobs`, `--head-test`, `--first-token-test`, `--metal-graph-test`, `--metal-graph-full-test`, `--metal-graph-prompt-test`, `--inspect`, `--perplexity-file`, `--imatrix-*` — these are diagnostic shortcuts that skip the normal generation path. See [01-architecture-overview.md](./01-architecture-overview.md) for the diagnostic command zoo and [04-quantization.md](./04-quantization.md) for `--imatrix-*`.
- **Directional steering.** `--dir-steering-file`, `--dir-steering-attn`, `--dir-steering-ffn` (`ds4_cli.c:1479-1486`) inject a steering vector during forward pass. This is a CPU-only path; the engine opener rejects the combination on Metal/CUDA at `ds4.c:17669`.
- **Power throttling.** `--power N%` (`ds4_cli.c:1473`) caps wall-clock GPU utilization to a percentage. The mechanism uses sleeps in the decode loop; see [10-metal-backend.md](./10-metal-backend.md) for how the cap is applied.

## 8. What you should now have in your head

- `cli_config` has **explicit operational defaults** written via a designated initializer at `ds4_cli.c:1410`, not C99 zero-init. Every field has a usable value before any flag is parsed.
- The default backend is decided at **compile time** by `default_backend` (`ds4_cli.c:246`): Apple → Metal, `DS4_NO_GPU` → CPU, else CUDA. The same source binary serves all three target environments.
- Type conversions happen **at parse time** through `parse_int` / `parse_float_range` / `parse_u64`, which use `strtol`-family functions with full validation. Garbage flags die in section 2 of the file with a one-line stderr message, never inside the engine.
- `temperature = 1.0f` is the default, so the trace command silently selects **sampled** generation, not greedy. To trace greedy you would need `--temp 0`. This is the first execution-path fork in the whole program.
- `log_context_memory` (`ds4_cli.c:1586`) prints the predicted KV cache memory **before** `ds4_engine_open` is called, so users see the cost before ds4 spends 30 seconds mmapping a 24 GiB model.
