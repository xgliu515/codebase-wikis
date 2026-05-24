# Chapter 05: Tokenizer & Chat Template

> Code version locked to `antirez/ds4@f91c12b` (2026-05-22). All `file:line` refs are repo-root-relative paths at this commit.

## 0. The problem this chapter solves

The whole point of a tokenizer is to convert one of two kinds of input — a raw text string or a multi-turn chat history — into the exact integer sequence the model was trained on. "Exact" matters more than it sounds. DeepSeek V4 Flash declares `tokenizer.ggml.pre = "joyai-llm"` and ships a specific BPE vocabulary plus a specific chat template. If any character of the pre-tokenization or the chat template is off by one — a trailing newline, a leading space, a misplaced `<｜Assistant｜>` — the model sees an input distribution different from training and degrades silently.

ds4 keeps the entire tokenizer and chat-template renderer in C inside `ds4.c`, with two public surfaces:

1. The text-level API in `ds4.h:132-153`: `ds4_tokens_*`, `ds4_tokenize_text`, `ds4_chat_begin`, `ds4_encode_chat_prompt`, `ds4_chat_append_message`, `ds4_chat_append_assistant_prefix`, `ds4_chat_append_max_effort_prefix`, `ds4_tokenize_rendered_chat`, `ds4_token_text`, `ds4_token_eos`, `ds4_token_user`, `ds4_token_assistant`.
2. The HTTP-level templating in `ds4_server.c` that constructs DSML tool-call markup and feeds it through `ds4_chat_append_message`.

This chapter walks the design from the bottom up: how raw bytes become BPE-safe codepoints, how merges are stored and queried, how JoyAI pre-tokenization shapes the input, how the chat template is built, how the three thinking modes inject prefixes, and how the DSML tool format roundtrips through ds4 in chat mode.

## 1. The byte-level BPE problem

A BPE tokenizer learns merges of the form "string A + string B → new token." If the merges operate on raw bytes, the merge dictionary needs keys that can include nulls, control characters, and other unprintable values. Hash-table operations on those keys are awkward at best and undefined at worst.

GPT-2's solution, adopted by DeepSeek's tokenizer, is to map every raw byte to a *printable* Unicode codepoint before BPE runs. The encoded text is pure printable UTF-8, the merge dictionary uses ordinary string keys, and the mapping is reversible.

The forward map (`ds4.c:14800-14814`):

```c
/* ds4.c:14800 */
static uint32_t gpt2_byte_to_codepoint(uint8_t b) {
    if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174)) {
        return b;
    }
    uint32_t n = 0;
    for (uint32_t x = 0; x < 256; x++) {
        if ((x >= 33 && x <= 126) || (x >= 161 && x <= 172) || (x >= 174)) {
            continue;
        }
        if (x == b) return 256 + n;
        n++;
    }
    return b;
}
```

"Printable" is defined by three ranges: ASCII 33–126, Latin-1 161–172, and 174–255. Those bytes (188 of them) map to themselves. The remaining 68 bytes (controls, space, ASCII 127, and Latin-1 173 plus the high-control gap 128–160) map to consecutive Unicode codepoints starting at U+0100.

`byte_encode` (`ds4.c:14818-14828`) applies the mapping byte-by-byte and emits UTF-8:

```c
/* ds4.c:14818 */
static char *byte_encode(ds4_str in, uint64_t *out_len) {
    char *out = xmalloc((size_t)in.len * 4 + 1);
    char *p = out;
    for (uint64_t i = 0; i < in.len; i++) {
        utf8_put(&p, gpt2_byte_to_codepoint((uint8_t)in.ptr[i]));
    }
    *p = '\0';
    *out_len = (uint64_t)(p - out);
    return out;
}
```

The output can be up to 4× the input length (the encoded `' '` is `Ġ` which is a 2-byte UTF-8 sequence; some controls become 2-byte UTF-8 too). `+ 1` is for the trailing NUL.

The inverse (`ds4.c:15357-15371`) walks the same table to undo the mapping during `ds4_token_text`. It returns `-1` for any codepoint that is neither a self-mapped byte nor in the synthetic range, which is how illegal token bytes get silently dropped during text reconstruction.

The single concrete consequence: every entry in the GGUF token table and every merge in the merge table is a printable UTF-8 string. The merge `"Ġ ġ"` is what you'd see in the merge table for "merge two encoded spaces"; the merge `"Hello"` would have been built up earlier via merges like `"H" + "e"`, `"He" + "l"`, and so on.

## 2. Hash tables: token_to_id and merge_rank

`ds4_vocab` (`ds4.c:14693-14705`) holds two hash tables and a few special-token IDs:

```c
struct ds4_vocab {
    ds4_str *token;
    int n_vocab;
    int bos_id;
    int eos_id;
    int user_id;
    int assistant_id;
    int think_start_id;
    int think_end_id;
    int dsml_id;
    str_i32_table token_to_id;
    str_i32_table merge_rank;
};
```

Both tables map `ds4_str → int` and are implemented as open-addressed linear-probe hash tables (`ds4.c:14605-14690`). `token_to_id` maps the printable encoded token string to its ID; `merge_rank` maps `"A B"` (with literal space) to the merge's rank in the GGUF merge list — lower rank means higher priority.

The key thing to remember is `bpe_rank` (`ds4.c:14852-14866`):

```c
/* ds4.c:14852 */
static int bpe_rank(const ds4_vocab *vocab, const owned_str *a, const owned_str *b) {
    uint64_t len = a->len + 1 + b->len;
    char stack[512];
    char *buf = len <= sizeof(stack) ? stack : xmalloc((size_t)len);

    memcpy(buf, a->ptr, (size_t)a->len);
    buf[a->len] = ' ';
    memcpy(buf + a->len + 1, b->ptr, (size_t)b->len);

    int rank = -1;
    table_get(&vocab->merge_rank, buf, len, &rank);

    if (buf != stack) free(buf);
    return rank;
}
```

A 512-byte stack buffer covers practically every merge probe; only pathologically long composites spill to `malloc`. A return of `-1` means "no merge rule for this pair," i.e. unmergeable.

## 3. The BPE inner loop: bpe_emit_piece

`bpe_emit_piece` (`ds4.c:14869-14934`) takes one pre-tokenized "piece" (a substring already chosen by the pre-tokenizer), runs full BPE on it, and pushes the resulting token IDs into the output vector.

The four stages:

1. **byte_encode the piece.** Each byte becomes its printable codepoint.
2. **Split into UTF-8 symbols.** The initial symbol array has one entry per UTF-8 character, populated with `owned_copy` of each character's bytes.
3. **Greedy merge loop.** Until no adjacent pair has a valid merge rank, find the pair with the lowest rank, merge them in place, and shift the trailing symbols left by one.
4. **Look up each surviving symbol.** If `token_to_id` doesn't have the merged string, fall back to per-byte lookup as a corruption-resilient last resort.

The merge loop (`ds4.c:14888-14916`):

```c
/* ds4.c:14888 */
for (;;) {
    int best_i = -1;
    int best_rank = INT32_MAX;

    for (int i = 0; i + 1 < n_sym; i++) {
        int rank = bpe_rank(vocab, &sym[i], &sym[i + 1]);
        if (rank >= 0 && rank < best_rank) {
            best_rank = rank;
            best_i = i;
        }
    }
    if (best_i < 0) break;

    owned_str merged;
    merged.len = sym[best_i].len + sym[best_i + 1].len;
    merged.ptr = xmalloc((size_t)merged.len);
    memcpy(merged.ptr, sym[best_i].ptr, (size_t)sym[best_i].len);
    memcpy(merged.ptr + sym[best_i].len, sym[best_i + 1].ptr, (size_t)sym[best_i + 1].len);

    free(sym[best_i].ptr);
    free(sym[best_i + 1].ptr);
    sym[best_i] = merged;

    for (int j = best_i + 1; j + 1 < n_sym; j++) {
        sym[j] = sym[j + 1];
    }
    n_sym--;
}
```

Each pass is O(n_sym). In the worst case n_sym shrinks by one per pass, so the loop is O(n²). In practice the JoyAI pre-tokenizer cuts text into pieces of bounded length (usually under 16-32 characters), so n_sym is small and the loop converges quickly.

The byte-fallback at the end (`ds4.c:14918-14930`) is the safety net for unmergeable bytes:

```c
/* ds4.c:14918 */
for (int i = 0; i < n_sym; i++) {
    int token = -1;
    if (table_get(&vocab->token_to_id, sym[i].ptr, sym[i].len, &token)) {
        token_vec_push(out, token);
    } else {
        for (uint64_t j = 0; j < sym[i].len; j++) {
            if (table_get(&vocab->token_to_id, sym[i].ptr + j, 1, &token)) {
                token_vec_push(out, token);
            }
        }
    }
    free(sym[i].ptr);
}
```

If the merged symbol isn't a token, walk each byte; if that byte's encoded codepoint isn't a token either, drop it. This never happens in practice for a well-formed GGUF, but it keeps malformed input from crashing the loop.

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="bpe_emit_piece pipeline: raw bytes through byte encode, UTF-8 split, greedy merge loop, token id lookup with byte fallback">
<defs>
<marker id="ar51" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">bpe_emit_piece pipeline (ds4.c:14869-14934)</text>
<rect x="200" y="40" width="360" height="44" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5" rx="6"/>
<text x="380" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">raw piece bytes</text>
<text x="380" y="76" text-anchor="middle" font-size="10" fill="#64748b">one substring chosen by the JoyAI pre-tokenizer</text>
<line x1="380" y1="84" x2="380" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar51)"/>
<text x="560" y="96" font-size="10" fill="#64748b" font-style="italic">byte_encode (ds4.c:14818)</text>
<rect x="200" y="104" width="360" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
<text x="380" y="124" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">printable UTF-8 string</text>
<text x="380" y="140" text-anchor="middle" font-size="10" fill="#64748b">each raw byte -&gt; printable codepoint (GPT-2 byte mapping)</text>
<line x1="380" y1="148" x2="380" y2="164" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar51)"/>
<text x="560" y="160" font-size="10" fill="#64748b" font-style="italic">split per UTF-8 char</text>
<rect x="200" y="168" width="360" height="44" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="380" y="188" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">initial symbol array</text>
<text x="380" y="204" text-anchor="middle" font-size="10" fill="#64748b">one owned_str per UTF-8 character</text>
<line x1="380" y1="212" x2="380" y2="228" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar51)"/>
<rect x="100" y="232" width="560" height="92" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
<text x="380" y="252" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">greedy merge loop (ds4.c:14888)</text>
<text x="380" y="270" text-anchor="middle" font-size="10" fill="#64748b">scan adjacent pairs: bpe_rank lookup in merge_rank table</text>
<text x="380" y="284" text-anchor="middle" font-size="10" fill="#64748b">pick lowest-rank pair; merge in place; shift trailing left</text>
<text x="380" y="298" text-anchor="middle" font-size="10" fill="#64748b">repeat until no adjacent pair has a valid rank</text>
<text x="380" y="316" text-anchor="middle" font-size="10" fill="#94a3b8">O(n^2) worst case; JoyAI keeps n bounded so it stays fast</text>
<line x1="380" y1="324" x2="380" y2="340" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar51)"/>
<rect x="200" y="344" width="360" height="44" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
<text x="380" y="364" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">final symbol array</text>
<text x="380" y="380" text-anchor="middle" font-size="10" fill="#64748b">post-merge tokens, ready for ID lookup</text>
<line x1="380" y1="388" x2="380" y2="404" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar51)"/>
<text x="560" y="400" font-size="10" fill="#64748b" font-style="italic">token_to_id lookup</text>
<rect x="200" y="408" width="360" height="56" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
<text x="380" y="428" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">append token IDs to vector</text>
<text x="380" y="444" text-anchor="middle" font-size="10" fill="#64748b">on miss: per-byte fallback via token_to_id</text>
<text x="380" y="458" text-anchor="middle" font-size="10" fill="#64748b">unmergeable bytes silently dropped (never happens in well-formed GGUF)</text>
</svg>
<span class="figure-caption">Figure R5.1 | bpe_emit_piece: a pre-tokenized piece becomes printable UTF-8, splits into UTF-8 symbols, runs a greedy lowest-rank merge loop against the GGUF merge table, then emits token IDs with byte fallback.</span>

<details>
<summary>ASCII fallback</summary>

```
   ┌─────────────────────────────┐
   │ raw piece bytes             │
   └──────────────┬──────────────┘
                  │ byte_encode
   ┌──────────────▼──────────────┐
   │ printable UTF-8 string      │
   └──────────────┬──────────────┘
                  │ split per UTF-8 char
   ┌──────────────▼──────────────┐
   │ initial symbol array        │
   └──────────────┬──────────────┘
                  │ greedy merge loop
                  │   - bpe_rank lookup
                  │   - merge lowest-rank pair
                  │   - shift left
   ┌──────────────▼──────────────┐
   │ final symbol array          │
   └──────────────┬──────────────┘
                  │ token_to_id lookup
                  │   (byte-fallback if missing)
   ┌──────────────▼──────────────┐
   │ append token IDs to vector  │
   └─────────────────────────────┘
```

</details>

## 4. JoyAI pre-tokenization

### 4.1 Why pre-tokenization matters

BPE is greedy on the *piece*; it does not merge across pieces. Different pre-tokenizations of the same input produce different final token streams even if the merged bytes are identical. The comment block at `ds4.c:15024-15041` is explicit:

```
The punctuation rule intentionally keeps trailing newlines in the same BPE
word (for example ">;\n").  Splitting those newlines separately changes the
token stream for code prompts and produces wrong long-context logits.
```

JoyAI is DeepSeek's regex-style pre-tokenizer. The regex set documented at `ds4.c:15029-15036` is:

```text
\p{N}{1,3}
[CJK/Hiragana/Katakana]+
[P/S][A-Za-z]+
[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+
 ?[\p{P}\p{S}]+[\r\n]*
\s*[\r\n]+
\s+(?!\S)
\s+
```

ds4 implements this not via a regex engine but by hand-coded byte rules. The dispatch is `bpe_tokenize_text` (`ds4.c:15044-15112`).

### 4.2 Character classification

The classifier predicates are small and local (`ds4.c:14946-15022`):

```c
/* ds4.c:14946 */
static bool ascii_digit(uint8_t c)   { return c >= '0' && c <= '9'; }
static bool ascii_space(uint8_t c)   { return c == ' ' || c == '\t' || c == '\n' ||
                                              c == '\r' || c == '\v' || c == '\f'; }
static bool ascii_newline(uint8_t c) { return c == '\n' || c == '\r'; }
/* ds4.c:14959 */
static bool joyai_ascii_punct_symbol(uint8_t c) {
    return (c >= '!' && c <= '/') ||
           (c >= ':' && c <= '@') ||
           (c >= '[' && c <= '`') ||
           (c >= '{' && c <= '~');
}
/* ds4.c:14966 */
static bool utf8_is_cjk_hira_kata(uint32_t cp) {
    return (cp >= 0x4e00 && cp <= 0x9fa5) ||
           (cp >= 0x3040 && cp <= 0x309f) ||
           (cp >= 0x30a0 && cp <= 0x30ff);
}
/* ds4.c:14994 */
static bool joyai_letter_like_at(const char *s, uint64_t len, uint64_t pos) {
    (void)len;
    uint8_t c = (uint8_t)s[pos];
    if (c < 128) return ascii_alpha(c);
    /* Non-ASCII non-control bytes are letters too. */
    return true;
}
```

Three deliberate choices:

- `joyai_ascii_punct_symbol` excludes ASCII letters and digits; it covers `!"#$%&'()*+,-./`, `:;<=>?@`, `[\]^_\``, and `{|}~`.
- `utf8_is_cjk_hira_kata` covers CJK Unified Ideographs (U+4E00–U+9FA5), Hiragana (U+3040–U+309F), and Katakana (U+30A0–U+30FF). This is intentionally narrow — it does not include CJK extensions A through G or Bopomofo.
- `joyai_letter_like_at` collapses everything non-ASCII and non-control into "letter." That keeps Latin-extended (French accents, Spanish ñ), Greek, Cyrillic, Arabic, etc. behaving like Western text from a pre-tokenization perspective.

### 4.3 The dispatch

```c
/* ds4.c:15044 */
static void bpe_tokenize_text(const ds4_vocab *vocab, const char *text, token_vec *out) {
    const uint64_t len = strlen(text);
    uint64_t pos = 0;

    while (pos < len) {
        uint64_t start = pos;
        uint8_t c = (uint8_t)text[pos];

        if (ascii_digit(c)) {
            int ndigits = 0;
            while (pos < len && ascii_digit((uint8_t)text[pos]) && ndigits < 3) {
                pos++;
                ndigits++;
            }
        } else if (joyai_cjk_at(text, len, pos)) {
            do {
                pos = next_utf8_char(text, len, pos);
            } while (pos < len && joyai_cjk_at(text, len, pos));
        } else if (joyai_ascii_punct_symbol(c) &&
                   pos + 1 < len &&
                   ascii_alpha((uint8_t)text[pos + 1])) {
            pos++;
            while (pos < len && ascii_alpha((uint8_t)text[pos])) pos++;
        } else if (joyai_letter_like_at(text, len, pos)) {
            pos = joyai_consume_letters(text, len, pos);
        } else if (!ascii_newline(c) &&
                   !joyai_ascii_punct_symbol(c) &&
                   pos + 1 < len &&
                   joyai_letter_like_at(text, len, pos + 1)) {
            pos++;
            pos = joyai_consume_letters(text, len, pos);
        } else if (c == ' ' &&
                   pos + 1 < len &&
                   joyai_ascii_punct_symbol((uint8_t)text[pos + 1])) {
            pos++;
            while (pos < len && joyai_ascii_punct_symbol((uint8_t)text[pos])) pos++;
            while (pos < len && ascii_newline((uint8_t)text[pos])) pos++;
        } else if (joyai_ascii_punct_symbol(c)) {
            while (pos < len && joyai_ascii_punct_symbol((uint8_t)text[pos])) pos++;
            while (pos < len && ascii_newline((uint8_t)text[pos])) pos++;
        } else if (ascii_space(c)) {
            /* ... see Section 4.4 for the space rule */
        } else {
            pos = next_utf8_char(text, len, pos);
        }

        if (pos == start) pos = next_utf8_char(text, len, pos);
        bpe_emit_piece(vocab, (ds4_str){ text + start, pos - start }, out);
    }
}
```

The order of branches matters — earlier matches take precedence. Digits are pulled off in groups of up to 3 (so `"4096"` becomes `"409" + "6"`). CJK characters are emitted one per piece (the loop body absorbs a run, but each piece is one character wide because each iteration emits then resets). Punctuation followed by ASCII letters captures forms like `";abort"` as one piece. Pure-letter runs become one piece. Punctuation runs capture trailing newlines.

The `pos == start` guard at the end is defensive: if a branch failed to advance (a degenerate input), force a UTF-8 character step so we always make progress.

### 4.4 The space rule

The trickiest rule is for whitespace (`ds4.c:15084-15104`):

```c
/* ds4.c:15084 */
} else if (ascii_space(c)) {
    uint64_t p = pos;
    uint64_t last_newline_end = 0;
    while (p < len && ascii_space((uint8_t)text[p])) {
        uint8_t sc = (uint8_t)text[p++];
        if (ascii_newline(sc)) last_newline_end = p;
    }
    if (last_newline_end) {
        pos = last_newline_end;
    } else if (p < len && p > pos + 1 &&
               (joyai_letter_like_at(text, len, p) ||
                joyai_ascii_punct_symbol((uint8_t)text[p]))) {
        /*
         * JoyAI lets a single leading space join the following word or
         * punctuation run.  For "    int", the pre-tokenizer therefore emits
         * "   " then " int", not "    " then "int".
         */
        pos = p - 1;
    } else {
        pos = p;
    }
}
```

Three sub-cases:

- If the whitespace run contains any newline, emit up to and including the last newline. This is what keeps trailing newlines attached to whatever followed them in the previous piece, and what makes `"abc\n\n\n"` cleanly delimited.
- If the whitespace run has length ≥ 2 and is followed by a letter or punctuation, leave one space behind for the following piece (`"    int" → "   " + " int"`).
- Otherwise emit the entire whitespace run as a single piece.

The "leave one space behind" branch is what implements GPT-2's `Ġword` convention without literally inserting the `Ġ` byte: the next pass will start at `pos - 1`, see a space followed by letters, and the dispatch will fall through to the second branch (`!ascii_newline && !punct && next is letter-like`) and produce `" int"` as one piece.

### 4.5 An example

```
Input:    " Hello, 世界123\n"
Pieces:   [" Hello"][","][ ][世][界][123][\n]
            ↑           ↑   ↑    ↑    ↑      ↑
            │           │   │    │    │      └─ punct branch absorbs newline
            │           │   │    │    └─ ascii_digit, ndigits ≤ 3
            │           │   │    └─ CJK, one piece per char
            │           │   └─ CJK
            │           └─ punct alone (next is space, not letter)
            └─ space rule: previous step's "leave one space" hands off here

Per piece, bpe_emit_piece runs the byte→codepoint encode, splits into UTF-8 chars,
merges greedily against merge_rank, and emits token IDs.
```

## 5. Loading the vocabulary from GGUF

`vocab_load` (`ds4.c:15124-15164`) reads three pieces from the GGUF:

```c
/* ds4.c:15129 */
if (!model_get_array(model, "tokenizer.ggml.tokens", &tokens) ||
    tokens.type != GGUF_VALUE_STRING ||
    tokens.len > INT32_MAX) {
    ds4_die("GGUF tokenizer token table is missing or invalid");
}
if (!model_get_array(model, "tokenizer.ggml.merges", &merges) ||
    merges.type != GGUF_VALUE_STRING) {
    ds4_die("GGUF tokenizer merge table is missing or invalid");
}

vocab->n_vocab = (int)tokens.len;
vocab->token = xcalloc((size_t)vocab->n_vocab, sizeof(vocab->token[0]));
table_init(&vocab->token_to_id, tokens.len);

ds4_cursor c = cursor_at(model, tokens.data_pos);
for (int i = 0; i < vocab->n_vocab; i++) {
    if (!cursor_string(&c, &vocab->token[i])) ds4_die(c.error);
    table_put(&vocab->token_to_id, vocab->token[i], i);
}

table_init(&vocab->merge_rank, merges.len);
c = cursor_at(model, merges.data_pos);
for (uint64_t i = 0; i < merges.len; i++) {
    ds4_str merge;
    if (!cursor_string(&c, &merge)) ds4_die(c.error);
    table_put(&vocab->merge_rank, merge, (int)i);
}
```

`tokenizer.ggml.tokens` is a flat string array; index = token ID. `tokenizer.ggml.merges` is also a string array; index = merge rank (lower = higher priority).

Then it resolves the seven special tokens by literal lookup (`ds4.c:15157-15163`):

```c
vocab->bos_id       = vocab_lookup(vocab, "<｜begin▁of▁sentence｜>");
vocab->eos_id       = vocab_lookup(vocab, "<｜end▁of▁sentence｜>");
vocab->user_id      = vocab_lookup(vocab, "<｜User｜>");
vocab->assistant_id = vocab_lookup(vocab, "<｜Assistant｜>");
vocab->think_start_id = vocab_lookup(vocab, "<think>");
vocab->think_end_id   = vocab_lookup(vocab, "</think>");
vocab->dsml_id        = vocab_lookup(vocab, "｜DSML｜");
```

`vocab_lookup` (`ds4.c:15114-15121`) calls `exit(1)` if any of these is missing — the model is unusable without them, and a bad model is better caught at boot than at first inference.

Two specifics worth noticing:

- The special tokens use the fullwidth vertical bar `｜` (U+FF5C, UTF-8 `ef bd 9c`) and the lower-one-eighth block `▁` (U+2581) instead of ASCII `|` and `_`. This is intentional: it makes the tokens unambiguous in any input text, because nobody types fullwidth vertical bars in code or English prose.
- The vocabulary size is `DS4_N_VOCAB = 129280` (`ds4.c:90`), shared as a fixed constant.

## 6. The chat template

### 6.1 The skeleton

DeepSeek V4 Flash's chat template is:

```
[BOS]
[optional Think Max prefix]
[optional system tokens]
<｜User｜>
[user tokens]
<｜Assistant｜>
[<think> or </think> depending on think mode]
[assistant tokens]
... next turn ...
```

The single-shot constructor `encode_chat_prompt` (`ds4.c:15176-15197`):

```c
/* ds4.c:15176 */
static void encode_chat_prompt(
        const ds4_vocab *vocab,
        const char      *system,
        const char      *prompt,
        ds4_think_mode   think_mode,
        token_vec       *out) {
    token_vec_push(out, vocab->bos_id);
    if (think_mode == DS4_THINK_MAX) {
        bpe_tokenize_text(vocab, DS4_REASONING_EFFORT_MAX_PREFIX, out);
    }
    if (system && system[0]) {
        bpe_tokenize_text(vocab, system, out);
    }
    token_vec_push(out, vocab->user_id);
    bpe_tokenize_text(vocab, prompt, out);
    token_vec_push(out, vocab->assistant_id);
    if (ds4_think_mode_enabled(think_mode)) {
        token_vec_push(out, vocab->think_start_id);
    } else {
        token_vec_push(out, vocab->think_end_id);
    }
}
```

Three things stand out:

1. **System text has no role marker.** It is BPE-tokenized directly between BOS and `<｜User｜>`. There is no "system role" tag.
2. **The Think Max prefix sits before system.** This places the longest, most expensive prefix at the very front of the sequence where it can match across many requests.
3. **The closing think token is `</think>` for "no thinking" mode.** This is counter-intuitive but correct: by closing the think block immediately, the model goes straight into the answer.

### 6.2 Public single-shot API

```c
/* ds4.h:139 */
void ds4_chat_begin(ds4_engine *e, ds4_tokens *tokens);
void ds4_encode_chat_prompt(ds4_engine *e,
                            const char *system, const char *prompt,
                            ds4_think_mode think_mode,
                            ds4_tokens *out);
```

`ds4_chat_begin` (`ds4.c:15262-15264`) is a single-line helper that pushes only the BOS — useful when the caller wants to build the prompt message-by-message.

`ds4_encode_chat_prompt` (`ds4.c:15266-15273`) is the single-shot path, forwarding to the static `encode_chat_prompt` above.

### 6.3 Multi-turn API

For multi-turn dialogs the server uses `ds4_chat_append_message` (`ds4.c:15279-15299`):

```c
/* ds4.c:15279 */
void ds4_chat_append_message(ds4_engine *e, ds4_tokens *tokens, const char *role, const char *content) {
    ds4_vocab *vocab = &e->vocab;
    if (!role) role = "user";
    if (!content) content = "";

    if (!strcmp(role, "system") || !strcmp(role, "developer")) {
        bpe_tokenize_text(vocab, content, tokens);
    } else if (!strcmp(role, "assistant")) {
        token_vec_push(tokens, vocab->assistant_id);
        if (strncmp(content, "<think>", 7) != 0 && strncmp(content, "</think>", 8) != 0) {
            token_vec_push(tokens, vocab->think_end_id);
        }
        bpe_tokenize_text(vocab, content, tokens);
    } else {
        token_vec_push(tokens, vocab->user_id);
        if (!strcmp(role, "tool") || !strcmp(role, "function")) {
            bpe_tokenize_text(vocab, "Tool: ", tokens);
        }
        bpe_tokenize_text(vocab, content, tokens);
    }
}
```

Per-role rules:

- `system`, `developer`: BPE only, no role marker. Same as the system slot in the single-shot template.
- `assistant`: push `<｜Assistant｜>`, then `</think>` (unless the content already begins with `<think>` or `</think>`), then BPE the content. This is what makes multi-turn replay work: a stored assistant turn renders identically to what `encode_chat_prompt` would have built when generation started.
- `user`, `tool`, `function`: push `<｜User｜>`, then for `tool`/`function` prepend `"Tool: "` (BPE-tokenized as ordinary text), then BPE the content. Tool replies are user-side messages with a literal prefix.

`ds4_chat_append_assistant_prefix` (`ds4.c:15301-15305`) pushes only the `<｜Assistant｜>` plus the think delimiter — useful when the caller wants the prompt to end exactly where generation will begin.

`ds4_chat_append_max_effort_prefix` (`ds4.c:15275-15277`) inserts the Think Max prefix text (BPE-tokenized) into the token vector. Callers that build prompts incrementally use this in place of the implicit branch inside `encode_chat_prompt`.

### 6.4 ds4_tokenize_rendered_chat

When the server already has a rendered chat string with literal special tokens (for example, restored from a snapshot), it can re-tokenize without re-rendering using `ds4_tokenize_rendered_chat` (`ds4.c:15258-15260` → `ds4.c:15237-15256`):

```c
/* ds4.c:15203 */
static bool special_token_at(const ds4_vocab *vocab, const char *p, int *token, size_t *len) {
    struct special {
        const char *text;
        int token;
    } specials[] = {
        {"<｜begin▁of▁sentence｜>", vocab->bos_id},
        {"<｜end▁of▁sentence｜>",   vocab->eos_id},
        {"<｜User｜>",              vocab->user_id},
        {"<｜Assistant｜>",         vocab->assistant_id},
        {"<think>",                vocab->think_start_id},
        {"</think>",               vocab->think_end_id},
        {"｜DSML｜",                vocab->dsml_id},
    };
    /* prefix match against the seven specials */
}
```

The dispatcher (`ds4.c:15237`) walks the text byte-by-byte, peels off any special token literal it finds and pushes its ID directly, and BPE-tokenizes the runs between specials. The difference from a regular `bpe_tokenize_text` over the same text is that the specials become single IDs instead of being chopped up by BPE.

This is the path that handles tool-call replay (Section 9), where DSML markup contains `<｜DSML｜...>` literals that need to round-trip through `dsml_id`.

## 7. Thinking modes

### 7.1 The three modes

```c
/* ds4.h:23 */
typedef enum {
    DS4_THINK_NONE,
    DS4_THINK_HIGH,
    DS4_THINK_MAX,
} ds4_think_mode;
```

- `DS4_THINK_NONE`: assistant prefix ends with `</think>`, so the model goes straight to the visible answer.
- `DS4_THINK_HIGH`: assistant prefix ends with `<think>`, so the model produces a hidden reasoning chain followed by `</think>` followed by the visible answer.
- `DS4_THINK_MAX`: same as HIGH plus a long preamble text injected after BOS that instructs the model to produce maximal reasoning.

`ds4_think_mode_enabled` (`ds4.c:15977-15979`) returns true for HIGH and MAX:

```c
bool ds4_think_mode_enabled(ds4_think_mode mode) {
    return mode == DS4_THINK_HIGH || mode == DS4_THINK_MAX;
}
```

The mode names (`ds4.c:15981-15988`) map to `"none"`, `"high"`, `"max"`.

### 7.2 The Think Max prefix

The prefix itself (`ds4.c:64-67`):

```c
/* ds4.c:64 */
static const char DS4_REASONING_EFFORT_MAX_PREFIX[] =
    "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n"
    "You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\n"
    "Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n";
```

The exposed accessor is `ds4_think_max_prefix()` (`ds4.c:15990-15992`).

### 7.3 The context-size requirement

```c
/* ds4.c:69 */
#define DS4_THINK_MAX_MIN_CONTEXT 393216u   /* 384 * 1024 */
```

384k tokens is the minimum context recommended for Think Max. The prefix itself plus the resulting reasoning chain easily consumes tens of thousands of tokens; if the context budget is smaller, the answer will be truncated.

`ds4_think_mode_for_context` silently downgrades to HIGH when the context is too small (`ds4.c:15998-16003`):

```c
/* ds4.c:15998 */
ds4_think_mode ds4_think_mode_for_context(ds4_think_mode mode, int ctx_size) {
    if (mode == DS4_THINK_MAX && (uint32_t)(ctx_size > 0 ? ctx_size : 0) < DS4_THINK_MAX_MIN_CONTEXT) {
        return DS4_THINK_HIGH;
    }
    return mode;
}
```

The CLI and server call this before constructing the prompt. The downgrade is silent: there is no warning printed because users routinely run on context budgets below 384k and the right thing is to honor their explicit context cap without nagging.

### 7.4 What the prefix looks like in tokens

```
Mode = NONE  →  [BOS] [system] <｜User｜> [user] <｜Assistant｜> </think>
Mode = HIGH  →  [BOS] [system] <｜User｜> [user] <｜Assistant｜> <think>
Mode = MAX   →  [BOS] [Reasoning Effort: ...] [system] <｜User｜> [user] <｜Assistant｜> <think>
```

The Max prefix runs through `bpe_tokenize_text` like any other text, so it picks up the JoyAI pre-tokenization. The leading `"Reasoning"` ends up as multiple tokens; the trailing `"\n\n"` is consumed by the punctuation-with-trailing-newline rule.

## 8. Token-to-text reconstruction

### 8.1 The basic flow

`ds4_token_text` (`ds4.c:15382-15410`) is the inverse of the tokenizer: given a token ID, produce the bytes that token represents.

```c
/* ds4.c:15382 */
char *ds4_token_text(ds4_engine *e, int token, size_t *len) {
    ds4_vocab *vocab = &e->vocab;
    if (token < 0 || token >= vocab->n_vocab) {
        if (len) *len = 0;
        char *out = xmalloc(1);
        out[0] = '\0';
        return out;
    }

    ds4_str s = vocab->token[token];
    char *out = xmalloc((size_t)s.len + 1);
    if (vocab_token_is_literal_special(s)) {
        memcpy(out, s.ptr, (size_t)s.len);
        out[s.len] = '\0';
        if (len) *len = (size_t)s.len;
        return out;
    }

    size_t n = 0;
    uint64_t pos = 0;
    while (pos < s.len) {
        uint32_t cp = utf8_decode_one(s.ptr, s.len, &pos);
        int b = gpt2_codepoint_to_byte(cp);
        if (b >= 0) out[n++] = (char)b;
    }
    out[n] = '\0';
    if (len) *len = n;
    return out;
}
```

For an ordinary token, decode its stored UTF-8, map each codepoint back to a byte via `gpt2_codepoint_to_byte`, and emit the result. The caller owns the buffer via `free()`.

For a "literal special" token (Section 8.2), return the stored bytes unchanged. This preserves the fullwidth bar `｜` etc. in log output.

### 8.2 What counts as literal-special

```c
/* ds4.c:15373 */
static bool vocab_token_is_literal_special(ds4_str s) {
    const unsigned char bar[] = {0xef, 0xbd, 0x9c}; /* U+FF5C fullwidth vertical bar. */
    if (s.len < sizeof(bar)) return false;
    for (uint64_t i = 0; i + sizeof(bar) <= s.len; i++) {
        if (!memcmp(s.ptr + i, bar, sizeof(bar))) return true;
    }
    return false;
}
```

Any token whose stored bytes contain the UTF-8 encoding of U+FF5C is treated as a literal — that is, `<｜begin▁of▁sentence｜>`, `<｜User｜>`, `<｜Assistant｜>`, `<｜end▁of▁sentence｜>`, and the `｜DSML｜` family. The fullwidth bar is a reliable signature because none of the BPE-encoded ordinary tokens will contain it (the byte-level BPE encodes ASCII `|` through `gpt2_byte_to_codepoint`, but `|` is in the self-map range and stays as `0x7c`, not `ef bd 9c`).

### 8.3 Multi-byte UTF-8 streaming

A single token's bytes can be only a fragment of a UTF-8 character. For example, a Chinese character is three bytes; if the BPE happens to split it (rare but possible at byte-fallback time), the caller will see partial UTF-8.

The downstream consumers (`ds4_cli.c`, `ds4_server.c`) accumulate bytes across tokens and use `utf8_len_from_first_byte` (`ds4.c:14830-14836`) to know when a complete codepoint has been assembled:

```c
/* ds4.c:14830 */
static int utf8_len_from_first_byte(uint8_t c) {
    if (c < 0x80) return 1;
    if ((c & 0xe0) == 0xc0) return 2;
    if ((c & 0xf0) == 0xe0) return 3;
    if ((c & 0xf8) == 0xf0) return 4;
    return 1;
}
```

The engine itself is byte-stream pure: it gives you bytes per token, and the byte stream concatenated across tokens is a valid UTF-8 sequence.

## 9. DSML tool format in chats

### 9.1 What DSML is

DSML ("DeepSeek Markup Language") is the tool-call serialization format DeepSeek V4 Flash was trained against. The model emits DSML when it decides to call a tool; the server parses the DSML, executes the tool, and round-trips the result back to the model.

The format is defined by literal tokens (`ds4_server.c:4183-4190`):

```c
/* ds4_server.c:4183 */
#define DS4_DSML "｜DSML｜"
#define DS4_DSML_SHORT "DSML｜"
#define DS4_TOOL_CALLS_START "<" DS4_DSML "tool_calls>"
#define DS4_TOOL_CALLS_END   "</" DS4_DSML "tool_calls>"
#define DS4_INVOKE_START     "<" DS4_DSML "invoke"
#define DS4_INVOKE_END       "</" DS4_DSML "invoke>"
#define DS4_PARAM_START      "<" DS4_DSML "parameter"
#define DS4_PARAM_END        "</" DS4_DSML "parameter>"
```

The fullwidth bars are real characters in the literal strings, encoded as UTF-8 in the C source.

### 9.2 Where the chat template introduces DSML

When tool schemas are present, the server injects a system-side instructions block (`ds4_server.c:1998-2013`):

```c
/* ds4_server.c:2000 */
"You can invoke tools by writing a \"<｜DSML｜tool_calls>\" block like the following:\n\n"
"<｜DSML｜tool_calls>\n"
"<｜DSML｜invoke name=\"$TOOL_NAME\">\n"
"<｜DSML｜parameter name=\"$PARAMETER_NAME\" string=\"true|false\">$PARAMETER_VALUE</｜DSML｜parameter>\n"
"...\n"
"</｜DSML｜invoke>\n"
"<｜DSML｜invoke name=\"$TOOL_NAME2\">\n"
"...\n"
"</｜DSML｜invoke>\n"
"</｜DSML｜tool_calls>\n\n"
"...\n"
"Only if a string value itself contains the exact closing parameter tag `</｜DSML｜parameter>`, write that tag as `&lt;/｜DSML｜parameter>` inside the value. "
```

This block becomes part of the system tokens emitted by `bpe_tokenize_text`. Because `｜DSML｜` is a single special token (`vocab->dsml_id`), the encoded sequence is dense rather than a long string of byte tokens — important both for prompt budget and for the model to recognize the markup unambiguously.

### 9.3 Rendering a model-emitted DSML tool call

When the model produces a tool call during generation, the server canonicalizes the call into a fresh DSML block before adding it to the next prompt (`ds4_server.c:2215-2235`):

```c
/* ds4_server.c:2215 */
static void append_dsml_tool_calls_text(buf *b, const tool_calls *calls) {
    if (!calls || calls->len == 0) return;
    if (calls->raw_dsml && calls->raw_dsml[0]) {
        buf_puts(b, calls->raw_dsml);
        return;
    }
    buf_puts(b, "\n\n<｜DSML｜tool_calls>\n");
    for (int i = 0; i < calls->len; i++) {
        const tool_call *tc = &calls->v[i];
        buf_puts(b, "<｜DSML｜invoke name=\"");
        append_dsml_attr_escaped(b, tc->name);
        buf_puts(b, "\">\n");
        if (!append_dsml_arguments_from_json(b, tc->arguments, NULL)) {
            buf_puts(b, "<｜DSML｜parameter name=\"arguments\" string=\"true\">");
            append_dsml_parameter_text(b, tc->arguments);
            buf_puts(b, "</｜DSML｜parameter>\n");
        }
        buf_puts(b, "</｜DSML｜invoke>\n");
    }
    buf_puts(b, "</｜DSML｜tool_calls>");
}
```

Two paths:

- If the original raw DSML string is still available (`calls->raw_dsml`), use it byte-for-byte. This preserves whatever ordering the model produced, including non-canonical attribute orderings, so the KV cache prefix match stays intact.
- Otherwise re-render from the parsed JSON arguments. Parameter values that look like JSON arrays/objects/numbers are written directly; only the fallback path (`arguments` parameter) wraps the whole JSON in a single `string="true"` parameter.

`append_dsml_parameter_text` (`ds4_server.c:2118` onwards) and `append_dsml_attr_escaped` handle the escape rules: any occurrence of `</｜DSML｜parameter>` inside a value becomes `&lt;/｜DSML｜parameter>`.

### 9.4 The reason canonicalization is non-trivial

When a request includes prior assistant turns that contained DSML tool calls, the server must re-render those calls into the prompt so the model "sees" the conversation history. But the original model output may have used arbitrary parameter ordering, and the server's re-render uses a canonical (often JSON-key-sorted) ordering. If the re-rendered DSML doesn't match the original, the KV cache prefix match fails and the session has to discard everything past that turn.

This is why `raw_dsml` is preserved — see the `ds4_session_rewrite_*` machinery in Chapter 6, which uses `ds4_session_common_prefix` to detect this exact mismatch and chooses between in-place sync, rebuild, or disk-cache restore.

## 10. End-to-end flow

```
   User input + system + tool schemas
              │
              ▼   (ds4_server.c renders to text)
   Full chat text with role markers
              │
              ▼
   ds4_chat_begin       → BOS
   ds4_chat_append_max_effort_prefix (if THINK_MAX)
   ds4_chat_append_message system    → BPE only
   ds4_chat_append_message user      → <｜User｜> + BPE
   ds4_chat_append_message assistant → <｜Assistant｜> + </think> + BPE
   ds4_chat_append_message tool      → <｜User｜> + "Tool: " + BPE
   ...
   ds4_chat_append_assistant_prefix  → <｜Assistant｜> + (<think>|</think>)
              │
              ▼
   For each text payload:
       bpe_tokenize_text
         pre-tokenize JoyAI rules
         bpe_emit_piece per piece
           byte_encode + UTF-8 split + greedy merge + token_to_id
              │
              ▼
   token vector
              │
              ▼
   ds4_session_sync (Chapter 6)
```

The total length of the token vector flowing out the bottom is what `ds4_session_sync` then compares to its live checkpoint to decide between incremental prefill, full prefill, or rewrite-rebuild.

## 11. Cross-references

- The session that consumes the token vector is Chapter 6 (`ds4_session_sync`, `ds4_session_common_prefix`, `ds4_session_rewrite_from_common`).
- The GGUF arrays `tokenizer.ggml.tokens` and `tokenizer.ggml.merges` come from the loader described in Chapter 3.
- The DSML tool format described in Section 9 has its full canonicalization and parsing pass in the HTTP/chat layer (`ds4_server.c`).
- The KV-cache implications of common-prefix matching across turns are Chapters 7 and 14.
