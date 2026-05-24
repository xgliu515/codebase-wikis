# Tour Step 06: Turning `"hello"` into a token-id array

> Code version locked to `ds4@f91c12b50a1448527c435c028bfc70d1b00f6c33` (2026). All `file:line` refs are repo-root-relative paths at this commit. Trace target: `./ds4 -m DS4.gguf -p "hello" -n 3`.

## 1. Current situation

`ds4_engine_open` returned 0. Control is back in `main` at `ds4_cli.c:1590`. The CLI dispatcher at `ds4_cli.c:1606-1609` checks `cfg.gen.prompt`: for our `-p "hello"` invocation it is the literal string `"hello"`, so `run_generation(engine, &cfg)` is called at `ds4_cli.c:1609`. Inside `run_generation` (`ds4_cli.c:902`), the very first two lines are:

```c
ds4_tokens prompt = {0};
build_prompt(engine, &cfg->gen, &prompt);
```

At this moment `cfg.gen` holds the resolved defaults (`ds4_cli.c:1417-1427`): `system = "You are a helpful assistant"`, `prompt = "hello"`, `think_mode = DS4_THINK_HIGH`, `ctx_size = 32768`, `n_predict = 50000` (will be clamped to 3 by `-n 3` later when `parse_options` overrides it). `prompt` is the empty `ds4_tokens` literal — `{.v = NULL, .len = 0, .cap = 0}` — that `build_prompt` will fill in.

By the end of this step `prompt` is a `ds4_tokens` holding ~10-15 integer ids representing the chat-templated, BPE-encoded input. The session does not exist yet; the GPU is idle. This step is pure CPU string processing.

## 2. The problem

The model only consumes integer token ids in the embedding-table row order. Going from `"hello"` (5 bytes, ASCII) to ids that the embedding table can index requires three layered pieces of work:

> (a) **Wrap the user text in the DS4 chat template.** Insert `<｜begin▁of▁sentence｜>` at the start, optionally a system message, then `<｜User｜>`, then the user content, then `<｜Assistant｜>`, then either `<think>` (thinking-on) or `</think>` (thinking-off). (b) **Byte-level BPE encode the natural-language fragments** ("You are a helpful assistant", "hello") into multiple token ids each, using GPT-2-style byte→codepoint mapping plus DeepSeek's pre-tokenization rules. (c) **Insert the special tokens by id**, bypassing BPE — they must not be tokenized as plain text.

The three pieces must compose correctly: getting the order of special tokens wrong, or letting BPE accidentally re-tokenize `<｜User｜>`, produces a prompt the model has never seen during training and therefore responds to incoherently.

## 3. Naive approach

String concatenation followed by a single BPE pass:

```c
char buf[1024];
snprintf(buf, sizeof(buf),
         "<｜begin▁of▁sentence｜>%s<｜User｜>%s<｜Assistant｜><think>",
         system, prompt);
bpe_tokenize_text(vocab, buf, out);
```

One pass, one allocation, easy to read. This is the path most "let's add chat support" PRs take in the first week.

## 4. Why the naive approach breaks

The naive approach has four concrete failure modes:

- **BPE will fragment special tokens.** `<｜User｜>` is a single training token; its id is `vocab->user_id`. But if it goes through `bpe_tokenize_text`, the encoder treats it as ordinary text — the `<` character, the `｜` (U+FF5C) character, the `U`, `s`, `e`, `r`, etc., each get pre-tokenized, then BPE merges some adjacent pairs. The result is 4-10 token ids that are **not** the single id the model was trained on. The model has never seen this sequence; the response is garbage.
- **`<think>` / `</think>` markers must vary by mode.** With `--think-high` (default), the assistant prefix ends with `<think>` to signal "now produce reasoning chain". With `--think-none`, it ends with `</think>` to skip the reasoning step. The naive string concat must conditionally produce different templates, and the branching gets messy fast as `--think-max` adds a long preamble.
- **System message is optional and varies.** Empty system means "skip the system tokens entirely"; non-empty means "BPE-encode the system text into the prompt before the user marker". A single `snprintf` cannot express "include this fragment only when non-empty" without manual concatenation or `printf` format hacks.
- **The `--think-max` preamble.** This is a 500-byte English instruction block (`DS4_REASONING_EFFORT_MAX_PREFIX` at `ds4.c:64-67`) that goes **between** BOS and the system message. It is itself BPE-encoded (it is plain text), but its placement is structural. Naive concat needs another conditional branch.

The deeper issue: the chat template is a structured composition where **some pieces are id-level inserts and others are text-level encodes**. Flattening to a string and re-encoding loses the distinction between "this is a special id, never split" and "this is user text, please BPE-encode".

## 5. ds4's approach

ds4's approach is to **build the token-id array directly, interleaving `token_vec_push` calls (for special tokens, by id) and `bpe_tokenize_text` calls (for user / system text, run through the full BPE encoder)**. The single function `encode_chat_prompt` at `ds4.c:15176-15197` is the canonical template; the rest of the chat helpers (`ds4_chat_append_message`, `ds4_chat_append_assistant_prefix`) compose the same primitives.

The call chain from CLI to BPE:

```
ds4_cli.c:904  build_prompt(engine, &cfg->gen, &prompt)
ds4_cli.c:466    build_prompt body
ds4_cli.c:470      ds4_encode_chat_prompt(engine, system, prompt, think_mode, out)
ds4.c:15266        ds4_encode_chat_prompt public wrapper
ds4.c:15272        encode_chat_prompt(&e->vocab, system, prompt, think_mode, out)
ds4.c:15176          encode_chat_prompt body
```

`build_prompt` at `ds4_cli.c:466-473` first checks `is_rendered_chat_prompt(gen->prompt)` — if the user passed a prompt that already contains literal special-token bytes like `<｜User｜>`, the function calls `ds4_tokenize_rendered_chat` instead (which uses `special_token_at` to find those bytes and emit ids directly). For our `-p "hello"` trace, the prompt does not contain any special-token strings, so the else branch is taken: `ds4_encode_chat_prompt(engine, gen->system, gen->prompt, cli_effective_think_mode(gen), out)`.

`cli_effective_think_mode` resolves the flag — by default (no `--think-*` argument) it returns `DS4_THINK_HIGH`. The CLI also automatically downgrades `DS4_THINK_MAX` to `DS4_THINK_HIGH` when `ctx_size < DS4_THINK_MAX_MIN_CONTEXT` (= 393 216, well above our 32 768), because the max-thinking preamble alone consumes thousands of tokens.

Inside `encode_chat_prompt` (`ds4.c:15176-15197`), the exact sequence for our trace is:

1. `token_vec_push(out, vocab->bos_id)` — appends the BOS id (`ds4.c:15182`).
2. `think_mode == DS4_THINK_MAX` is false, so the `DS4_REASONING_EFFORT_MAX_PREFIX` block is skipped (`ds4.c:15183-15185`).
3. `system && system[0]` is true (system = "You are a helpful assistant"), so `bpe_tokenize_text(vocab, "You are a helpful assistant", out)` runs (`ds4.c:15186-15188`). This produces ~5-6 tokens.
4. `token_vec_push(out, vocab->user_id)` — the `<｜User｜>` marker (`ds4.c:15189`).
5. `bpe_tokenize_text(vocab, "hello", out)` — encodes "hello" (`ds4.c:15190`). For an ASCII word in mid-sentence position, this is usually 1-2 tokens.
6. `token_vec_push(out, vocab->assistant_id)` — the `<｜Assistant｜>` marker (`ds4.c:15191`).
7. `ds4_think_mode_enabled(DS4_THINK_HIGH)` is true, so `token_vec_push(out, vocab->think_start_id)` appends `<think>` (`ds4.c:15192-15194`). For `DS4_THINK_NONE`, `vocab->think_end_id` (i.e., `</think>`) would be appended instead.

Final token sequence shape (with placeholder ids):

```
[ bos_id, <"You","Ġare","Ġa","Ġhelpful","Ġassistant" ids>,
  user_id, <"hello" ids>, assistant_id, think_start_id ]
```

Roughly 10-12 token ids for this trace. The exact numbers depend on the GGUF's specific BPE merges but stay in the same ballpark across reasonable DS4 model variants.

The BPE encoder for text fragments (`bpe_tokenize_text` at `ds4.c:15044-15112`) does its own structured work. **Pre-tokenization** (the "JoyAI" rules at `ds4.c:15044-15111`) splits a text fragment into pieces by character class: digits run together (max 3 at a time), CJK characters split individually, ASCII letters and underscores form word runs, leading single spaces attach to the following word so `"   int"` becomes `"   "` + `" int"` rather than `"    "` + `"int"`. Each piece is then handed to `bpe_emit_piece` (`ds4.c:14869`).

`bpe_emit_piece` applies the actual byte-level BPE algorithm:

1. `byte_encode` (`ds4.c:14818`) maps every raw byte through the GPT-2 byte→codepoint table so the symbols are valid UTF-8 sequences (a space becomes `Ġ`, a newline becomes `Ċ`, ASCII bytes 0x21-0x7E map to themselves).
2. The encoded string is split into UTF-8 character symbols.
3. In a loop: find the adjacent symbol pair with the lowest `bpe_rank` (`ds4.c:14852`); if none has a rank, stop; otherwise merge that pair into one symbol and repeat.
4. Look up each final symbol's id in `token_to_id` and `token_vec_push` it onto `out`.

For "hello", pre-tokenization produces one piece `"hello"`. The byte-encode leaves it as `"hello"` (all printable ASCII map to themselves). The symbols are `["h", "e", "l", "l", "o"]`. The merge loop finds the merge with lowest rank — for English-trained BPE this is typically `("h", "e") → "he"`, then `("ll", "o") → "llo"`, then `("he", "llo") → "hello"`. The final symbol `"hello"` is a single token in the DS4 vocab. So `"hello"` becomes one token id.

The `Ġ` prefix marker matters: many tokens in the vocab represent "space + word" (e.g., `"Ġhello"` is a different token id from `"hello"`). Because "hello" appears mid-sentence after `<｜User｜>` with no preceding text, BPE actually encodes it without a leading space. Inside the system text "You are a helpful assistant", "You" is at start-of-text so emits as `"You"`; "are", "a", "helpful", "assistant" each emit with leading-space variants (`"Ġare"`, `"Ġa"`, `"Ġhelpful"`, `"Ġassistant"`).

When `encode_chat_prompt` returns, `out` is a `ds4_tokens` (`ds4.h:41-45`) — a growable int array. `build_prompt` returns; `run_generation` proceeds with `prompt.len ≈ 10-12`.

## 6. Code locations

In reading order:

- `ds4_cli.c:902-905` — `run_generation` entry; declares the empty `ds4_tokens prompt`, calls `build_prompt`.
- `ds4_cli.c:466-473` — `build_prompt`; dispatches between rendered-chat and standard template paths.
- `ds4.h:140-145` — `ds4_encode_chat_prompt` public declaration.
- `ds4.c:15266-15273` — `ds4_encode_chat_prompt`; thin wrapper over the internal `encode_chat_prompt`.
- `ds4.c:15173-15197` — `encode_chat_prompt`; the structural chat template with seven sequential insert steps.
- `ds4.c:15044-15112` — `bpe_tokenize_text`; JoyAI/DeepSeek pre-tokenization rules.
- `ds4.c:14869-14935` — `bpe_emit_piece`; the actual BPE merge loop.
- `ds4.c:14818-14828` — `byte_encode`; the GPT-2 byte→codepoint mapping.
- `ds4.c:14852-14866` — `bpe_rank`; merge-rank lookup with a 512-byte stack buffer.
- `ds4.c:15203-15246` — `special_token_at`; the special-token scanner used by `ds4_tokenize_rendered_chat`.
- `ds4.c:15262-15264` — `ds4_chat_begin`; the lower-level helper that just pushes BOS for callers building chat prompts incrementally.
- `ds4.c:15279-15299` — `ds4_chat_append_message`; appends one role-tagged message, used by the multi-turn server path.
- `ds4.c:15301-15305` — `ds4_chat_append_assistant_prefix`; appends `<｜Assistant｜>` + `<think>` / `</think>`.
- `ds4.c:64-67` — `DS4_REASONING_EFFORT_MAX_PREFIX`; the 500-byte think-max preamble.
- `ds4.c:72` — `DS4_THINK_MAX_MIN_CONTEXT = 393216`; the auto-downgrade threshold.

## 7. Branches and extensions

We took the standard single-turn template path. The other paths:

- **Pre-rendered chat (`ds4_tokenize_rendered_chat`).** When the prompt already contains literal special-token bytes (server / advanced users render their own template), `build_prompt` dispatches to `ds4_tokenize_rendered_chat` (`ds4.c:15258`), which walks the text and uses `special_token_at` (`ds4.c:15203`) to recognize each marker and emit the id directly, while BPE-encoding the text between markers. This is the only way to express multi-turn history within a single CLI invocation. See [Chapter 5: Tokenizer and Chat Template](./05-tokenizer-chat.md).
- **Multi-turn server.** `ds4-server` builds the prompt incrementally with `ds4_chat_begin` + repeated `ds4_chat_append_message` + final `ds4_chat_append_assistant_prefix`. The primitives are the same; the composition differs. See [Chapter 13: HTTP Server API](./13-http-server-api.md) for the request-to-prompt mapping.
- **`DS4_THINK_MAX` mode.** Inserts `DS4_REASONING_EFFORT_MAX_PREFIX` (a 500-byte English instruction) between BOS and the system message, asking the model to use its full reasoning budget. Auto-downgrades to `DS4_THINK_HIGH` if `ctx_size < 393 216`. See [Chapter 5 §thinking modes](./05-tokenizer-chat.md).
- **CJK and multilingual prompts.** The same `bpe_tokenize_text` handles Chinese, Japanese, and Korean text via the `joyai_cjk_at` branch (`ds4.c:15058-15061`), which splits each CJK character individually before BPE. The merge step can then combine common bigrams. Useful for understanding how the encoder behaves on non-ASCII prompts. See [Chapter 5 §pre-tokenization](./05-tokenizer-chat.md).
- **Token embedding table alignment.** Once `prompt` exists, tour-08 / tour-09 use each id to index into `token_embd` (the F16 embedding matrix bound in tour-03). The row-id alignment that tour-04 set up is what makes that indexing valid. See [Chapter 2: Model Architecture](./02-model-architecture.md) and [Chapter 3 §weight binding](./03-gguf-loading.md).
- **Quantization is independent.** None of the chat template or BPE code cares about quantization formats. See [Chapter 4: Quantization](./04-quantization.md).

## 8. What you should now have in your head

1. **Chat template = interleaving of `token_vec_push` (id-level inserts) and `bpe_tokenize_text` (text-level BPE encodes).** Special tokens never go through BPE; user / system text always does. The interleaving is hard-coded in `encode_chat_prompt`; there is no runtime template engine.
2. **The DS4 template structure is: BOS → [max-thinking preamble] → [system] → `<｜User｜>` → user → `<｜Assistant｜>` → `<think>` or `</think>`.** Every bracketed piece is optional in some configuration. For our `-p "hello"` defaults all are present except the max-thinking preamble.
3. **BPE has two layers.** First, JoyAI/DeepSeek pre-tokenization splits text into pieces by character class (CJK runs, digit triples, letter runs, leading-space rules). Then `bpe_emit_piece` runs the actual greedy-merge algorithm using the rank table loaded by `vocab_load`.
4. **Byte-level BPE means token strings contain Unicode "proxy" characters.** `Ġ` proxies for space, `Ċ` for newline; the byte-encode map at `ds4.c:14818` makes the encoder operate on UTF-8 throughout. Decoding (tour-13) inverts the map.
5. **Final result is `ds4_tokens` — a growable `int *` array.** ~10-12 ids for our trace. The session does not exist yet; the GPU is idle. The next step is `ds4_session_create`, which allocates the per-conversation state that consumes these ids.
