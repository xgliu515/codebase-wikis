# Chapter 13: HTTP Server and OpenAI / Anthropic API

> Code version locked to `antirez/ds4@f91c12b50a1448527c435c028bfc70d1b00f6c33` (HEAD on `main`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

Related chapters: [Chapter 14: Disk KV Cache and Replay](14-disk-kv-cache.md) - [Chapter 6: Engine Session](06-engine-session.md).

`ds4_server.c` is 15348 lines. That is a lot of code for one file, and the temptation is to skim. Resist it. The size is not because the code is repetitive or generated; it is because a single C process here is doing the job that elsewhere is split between FastAPI, vLLM's API server, a redis queue, and a tokenization microservice. The reason all of that collapses into one file is the same reason any one of these systems exists: the inference engine has exactly one live GPU session, and the entire HTTP layer is shaped around protecting it.

This chapter is a tour. The first half is structural: the threading model, the three API parsers, the streaming state machine, and how a request travels from `accept()` to a finished SSE stream. The second half is the things that make this server unusual: a "tool memory" radix tree that remembers the exact bytes the model sampled so they can be replayed verbatim on the next turn; live continuation paths that bypass token-prefix matching when the server can prove the request is a follow-up; and the recent shift toward keepalive-aware prefill callbacks.

## 1. What this server is, and what it deliberately is not

The first twelve lines of the file state the design contract:

```c
/* OpenAI/Anthropic compatible local server.
 *
 * HTTP is intentionally simple: each client connection is handled by a small
 * blocking thread that parses one request, then queues a job to the single
 * Metal worker.  The worker owns the ds4_session and therefore owns all live KV
 * cache state.  That keeps session reuse, disk checkpointing, and future
 * batching decisions in one place instead of spreading graph mutations across
 * client threads. */
```
(`ds4_server.c:5-12`)

Three architectural decisions are baked into that comment and they together explain the file's shape:

1. **One Metal session, one worker thread.** Multiple clients can connect at the same time; multiple requests can sit in a FIFO queue; but only one request at a time runs through `ds4_session_sync()` / `ds4_session_sample()`. No batching, no per-client KV, no parallelism inside the engine.
2. **HTTP is dumb on purpose.** There is no chunked transfer encoding, no `Transfer-Encoding: gzip`, no keepalive, no HTTP/2. `Connection: close` is hard-coded into every response (`ds4_server.c:4783`, `ds4_server.c:4857`). The protocol is the minimum surface that OpenAI and Anthropic clients require.
3. **The worker owns the session.** Client threads parse JSON, build a `request` struct, drop a `job` on the queue, and wait on a condition variable. They never touch `s->session` directly. The worker drains the queue and is the only code that calls `ds4_session_*`. This is a real ownership rule and not a code-style preference - the moment a client thread writes to the live KV, the disk-cache invariants in [Chapter 14](14-disk-kv-cache.md) collapse.

What the server is *not* is also informative. There is no auth: no API keys, no bearer tokens, no rate limiter, no per-user quotas. The default `--host` is `127.0.0.1` (`ds4_server.c:11420`); the explicit deployment model is "single local user." CORS is opt-in via `--cors` (`ds4_server.c:11454-11455`) precisely so that the default never exposes a cross-origin surface. The protocol-compatible OpenAI/Anthropic API is a *transport* choice, not a hosting choice.

```
                   ds4-server process
       +--------------------------------------------+
       |  main()  : signal handlers, parse_options, |
       |            engine + session + lock, start  |
       |            worker, accept() loop           |
       +-----+--------------------------------------+
             |
             | per connection: pthread_create
             v
       client thread (1..N)         worker thread (exactly 1)
       --------------------         ------------------------
       read HTTP, parse JSON        dequeue job
       build request struct         generate_job():
       enqueue(&j)                    cache lookup, sync,
       wait on j.cv  <--- signal      sample loop, stream
       close(fd), exit                signal j.cv
```

## 2. The shape of `ds4_server.c`

Like Chapter 2 of the OpenClaw wiki treats `server.impl.ts` as a script, we treat `ds4_server.c` as a sequence of regions:

| Lines | Region |
|------:|--------|
| 1-460 | Buffer helpers, JSON parser primitives, signal handlers |
| 460-2200 | Chat message structs, prompt rendering, DSML emit |
| 2200-2600 | Tool result rendering, render-live-tool-tail, fast-path prepare |
| 2600-3960 | API parsers: chat (`:2608`), Anthropic (`:2778`), Responses (`:3667`) |
| 3960-4760 | `/v1/completions` parser + DSML constants + parsed-message reader |
| 4760-5160 | HTTP response writers, SSE primitives, OpenAI tool deltas |
| 5160-6900 | DSML decode tracker, streaming tool projection, Anthropic stream |
| 6900-7600 | Responses stream, finalizers, parsed-call attach |
| 7600-8200 | Server struct, job, tool memory (rax-backed) |
| 8200-9050 | KV cache wrappers (thin shims onto `ds4_kvstore.c`) |
| 9050-9450 | Cache trace events, live-prefix helpers |
| 9450-9700 | Prefill progress callback, prefill failure response |
| 9700-9870 | `canonicalize_tool_checkpoint`, `remember_thinking_checkpoint` |
| 9870-10880 | `generate_job` - the dispatcher and decode loop |
| 10880-11210 | enqueue/dequeue, worker thread, HTTP request reader, client thread |
| 11210-11660 | Option parsing, `main()` |
| 11660-end | `#else` test block (compiled under `DS4_SERVER_TEST`) |

Three functions dominate this layout: **`parse_chat_request` / `parse_anthropic_request` / `parse_responses_request`** turn JSON into a `request`; **`render_chat_prompt_text`** turns a `request` into raw DS4 chat bytes the engine can tokenize; **`generate_job`** turns one `request` into a full HTTP/SSE response. Everything else either prepares input for those three or projects their output into a wire format.

## 3. Process and thread model

### 3.1 `main()`

`main()` lives at `ds4_server.c:11524`. Trimmed to its skeleton:

```c
int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);                            // 11525
    /* SIGINT / SIGTERM -> stop_signal_handler */         // 11526-11531
    server_config cfg = parse_options(argc, argv);        // 11533
    if (cfg.chdir_path && chdir(cfg.chdir_path) != 0) ... // 11534-11538
    ds4_engine_open(&engine, &cfg.engine);                // 11541
    ds4_session_create(&session, engine, cfg.ctx_size);   // 11546
    /* fill `server s` from cfg, init mutexes/cvs */      // 11553-11573
    if (cfg.trace_path) s.trace = fopen(...);             // 11574-11584
    pthread_create(&worker, NULL, worker_main, &s);       // 11586-11587
    int lfd = listen_on(cfg.host, cfg.port);              // 11589
    g_listen_fd = lfd;                                    // 11600
    while (!g_stop_requested) {                           // 11603
        int fd = accept(lfd, NULL, NULL);                 // 11604
        configure_client_socket(fd);                      // 11616
        client_arg *ca = xmalloc(sizeof(*ca));            // 11617
        ca->srv = &s; ca->fd = fd;
        s.clients++;                                      // 11620-11622
        pthread_create(&th, NULL, client_main, ca);       // 11624
        pthread_detach(th);                               // 11633
    }
    /* drain: stopping=true; cond_broadcast; join worker; */
    /* wait clients==0; if KV enabled, save shutdown checkpoint */
    /* server_close_resources, return 0 */
}
```

`SIGPIPE` is ignored at line 11525 because a slow client closing mid-stream must not kill the worker. The signal handler at `ds4_server.c:46-55` flips `g_stop_requested` and closes the listening fd so `accept()` unblocks. Second `SIGINT` calls `_exit(130)` to escape if the graceful drain hangs.

The accept loop runs until shutdown. There is no backlog limit beyond `listen(fd, 128)` at `ds4_server.c:11189`; if more than 128 connections pile up before the OS can fork-off a client thread, new connections get a TCP-level refusal. In practice the worker is much slower than client setup, so the queue inside `server` (not the kernel backlog) is where contention shows up.

The shutdown ordering (`ds4_server.c:11635-11657`) matters:

1. Close the listening fd (no new clients can connect).
2. Set `s.stopping = true`, broadcast the worker cv so it stops blocking on an empty queue.
3. Join the worker.
4. Wait for any client threads still inside `client_main` to exit (`clients == 0`).
5. If KV cache is enabled and the live session has at least `min_tokens`, call `kv_cache_store_current(&s, "shutdown")` so the conversation is durable across restarts.
6. Free everything.

### 3.2 The worker thread

`worker_main` (`ds4_server.c:10910`) is trivial:

```c
static void *worker_main(void *arg) {
    server *s = arg;
    for (;;) {
        job *j = dequeue(s);
        if (!j) break;
        generate_job(s, j);
        pthread_mutex_lock(&j->mu);
        j->done = true;
        pthread_cond_signal(&j->cv);
        pthread_mutex_unlock(&j->mu);
    }
    return NULL;
}
```

`dequeue` (`ds4_server.c:10895`) blocks on `s->cv` until a job arrives or `s->stopping` is set. The work happens inside `generate_job`, then the worker signals the client thread via the per-job cv. Because the client thread owns the job on its stack, the worker does *not* free anything - it just writes `done = true` and lets the client side dispose.

### 3.3 The job and ownership

`struct job` is declared at `ds4_server.c:7710`:

```c
/* Jobs are stack-owned by the client thread.  The worker signals completion
 * after the response has been written, so request data and the socket remain
 * valid without heap-allocating per-request job objects. */
struct job {
    int fd;
    request req;
    bool done;
    pthread_mutex_t mu;
    pthread_cond_t cv;
    job *next;
};
```
(`ds4_server.c:7707-7717`)

This is the central memory rule of the server: **jobs live on the client thread's stack**. The client allocates a `job j;` (`ds4_server.c:11141`), fills it, calls `enqueue(s, &j)`, blocks on `j.cv` until done, then frees its inputs. The worker only borrows `j` for the duration of `generate_job`. There is no per-request heap allocation for the job object itself, no reference counting, no risk of dangling pointers because the client thread literally cannot return from `client_main` until the worker has signalled.

### 3.4 The client thread

`client_main` (`ds4_server.c:11078`) is the per-connection driver. Strip out the route table and it is short:

```c
http_request hr = {0};
if (!read_http_request(fd, &hr)) { http_error(fd, ..., 400, "bad HTTP request"); goto done; }
if (OPTIONS)                     { http_response(fd, ..., 204, NULL, ""); goto done; }
if (GET /v1/models)              { send_models(s, fd); goto done; }
if (GET /v1/models/...)          { send_model(s, fd); goto done; }

request req;
if      (POST /v1/messages)         ok = parse_anthropic_request(...);
else if (POST /v1/chat/completions) ok = parse_chat_request(...);
else if (POST /v1/responses)        ok = parse_responses_request(...);
else if (POST /v1/completions)      ok = parse_completion_request(...);
else                                { http_error(fd, ..., 404, "unknown endpoint"); goto done; }

if (!ok)                              { http_error(fd, ..., 400, err); goto done; }
if (request_exceeds_context(&req))    { http_error_context_length_exceeded(...); goto done; }

set_client_socket_nonblocking(fd);
job j; /* stack alloc */
enqueue(s, &j);
while (!j.done) pthread_cond_wait(&j.cv, &j.mu);
```
(condensed from `ds4_server.c:11078-11167`)

`read_http_request` (`ds4_server.c:10963`) is the entire HTTP parser. It reads until it sees `\r\n\r\n`, sscanfs the method and path out of the first line, reads `Content-Length` (case-insensitive at `ds4_server.c:10953`), then reads exactly that many body bytes. Header cap is 64 KiB (`ds4_server.c:10966`); body cap is 64 MiB (`ds4_server.c:10967`). No chunked encoding, no `Expect: 100-continue`, no `Connection: keep-alive`. Anything that does not fit this shape is a 400.

`set_client_socket_nonblocking(fd)` (`ds4_server.c:11204`) is critical. Read the comment:

```c
static void set_client_socket_nonblocking(int fd) {
    /* The inference worker writes streaming responses itself.  Once a request is
     * queued, a blocked socket would block every other request too, so slow
     * clients are failed instead of back-pressuring the model session. */
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
```

Once a job is enqueued, the worker is going to call `send()` on this fd from inside `generate_job`. If the client's TCP receive window fills up (slow consumer, dropped Wi-Fi, browser tab in background), a blocking `send()` would freeze the *worker*, which would freeze every other queued request. So the socket is made non-blocking *before* enqueue, and the SSE writers check for EWOULDBLOCK in `send_all` and fail the request instead of waiting.

### 3.5 Why one worker, not N

A reasonable question is "why not run multiple workers and pipeline through batching?" The answer is at `ds4_server.c:8-12`: every graph mutation is on the same Metal session, and the disk-KV checkpoint protocol (Chapter 14) assumes a single owner of that session. Multi-tenant batching is a separate project that would require either per-request KV slices or a proper continuous-batching scheduler. The current design says: serial, simple, fast in the common single-user case.

This has a real consequence: if request A is doing a 30000-token cold prefill and request B arrives, B waits. The server does not interrupt A. The wait is bounded only by A's max_tokens. To keep B's client alive during long prefills, the server uses keepalive callbacks (section 9 below).

## 4. The three API parsers

ds4-server speaks four URL paths:

| Path | Parser | Result `request.api` |
|------|--------|---------------------|
| `POST /v1/chat/completions` | `parse_chat_request` at `ds4_server.c:2608` | `API_OPENAI` |
| `POST /v1/messages` | `parse_anthropic_request` at `ds4_server.c:2778` | `API_ANTHROPIC` |
| `POST /v1/responses` | `parse_responses_request` at `ds4_server.c:3667` | `API_RESPONSES` |
| `POST /v1/completions` | `parse_completion_request` at `ds4_server.c:3961` | `API_OPENAI`, `REQ_COMPLETION` |

Plus two GETs that exist to make SDK probing work: `/v1/models` and `/v1/models/deepseek-v4-flash` (`ds4_server.c:11096-11105`). All four POST paths dispatch into the same `generate_job`. The differences are entirely in:

- how the JSON body is read into a `request` struct,
- how the prompt is rendered into chat bytes,
- how the response is projected back out.

### 4.1 Selective JSON parsing

The parsers share one philosophy, stated at `ds4_server.c:2604-2607`:

```c
/* The API parsers are intentionally selective JSON parsers: they keep only
 * fields that affect model semantics, rendering, streaming, or cache keys, and
 * skip extension fields.  The output is always a rendered DS4 chat/completion
 * prompt plus the small amount of protocol state needed to translate the reply. */
```

The implication is that unknown fields are *skipped without parsing them into a tree*. This is what `json_skip_value_depth` (`ds4_server.c:346`) is for. The skipper is recursive (because JSON values nest), and the recursion has a hard ceiling:

```c
/* The request parser only understands the API fields we use and skips the
 * rest.  Skipping is recursive because JSON values nest, so keep an explicit
 * ceiling: without it, a useless ignored field like {"x":[[[...]]]} can spend
 * the whole C stack before the request is rejected. */
#define JSON_MAX_NESTING 256
```
(`ds4_server.c:288-292`)

Without `JSON_MAX_NESTING`, a malicious client could send `{"x":[[[[[...]]]]]}` and blow the worker stack inside the parser. The cap is checked at the top of every recursive entry (`ds4_server.c:297`, `:319`).

### 4.2 The `request` struct

The shape of the parsed request is the contract between the parsers and `generate_job`. It lives at `ds4_server.c:582`:

```c
typedef struct {
    req_kind kind;          // REQ_CHAT or REQ_COMPLETION
    api_style api;          // API_OPENAI / API_ANTHROPIC / API_RESPONSES
    ds4_tokens prompt;      // tokenized prompt
    char *prompt_text;      // raw rendered DS4 chat bytes
    stop_list stops;
    tool_schema_orders tool_orders;  // per-tool property name order (for canonical JSON re-emit)
    int max_tokens, top_k;
    float temperature, top_p, min_p;
    uint64_t seed;
    bool stream;
    bool has_tools;
    ds4_think_mode think_mode;
    /* Responses-specific continuation fields */
    bool responses_requires_live_tool_state;
    bool responses_requires_live_reasoning;
    stop_list responses_live_call_ids;
    char *responses_live_suffix_text;
    /* Anthropic-specific continuation fields */
    bool anthropic_requires_live_tool_state;
    stop_list anthropic_live_call_ids;
    char *anthropic_live_suffix_text;
    tool_replay_stats tool_replay;
} request;
```
(condensed from `ds4_server.c:582-631`)

`prompt_text` is the raw chat string the engine tokenized; it doubles as the disk-cache *key* (see Chapter 14). `prompt` is the same content as token IDs. Most other fields are the small amount of protocol state needed to re-encode the model's output: the API style picks the response shape, the stops list is consulted during decode, the tool orders preserve client-declared property ordering so re-emitted JSON tool calls match the client's declared schema.

The `responses_live_*` / `anthropic_live_*` fields are evidence for `generate_job` that this request is bound to a prior live turn by call_id. Without them, every Responses tool-output request would have to do a full token-prefix match against a partially-replayed visible history.

### 4.3 The Anthropic block parser

The Anthropic API uses content blocks rather than flat strings. The parser at `ds4_server.c:1675` collapses them into the DS4 chat format:

```c
/* Anthropic content is block-structured, while the engine consumes one compact
 * chat_msg per role.  Parsing collapses text/thinking into strings, converts
 * assistant tool_use blocks to tool_calls, and keeps tool_result blocks as
 * escaped text because DS4 sees tool results in its chat template. */
```
(`ds4_server.c:1671-1674`)

The mapping is straightforward:
- `"type":"text"` -> append to `msg.content`
- `"type":"thinking"` -> append to `msg.reasoning`
- `"type":"tool_use"` -> push a `tool_call` (with id, name, input JSON)
- `"type":"tool_result"` -> append `<tool_result>...</tool_result>` text into `msg.content`

The last one is the interesting choice: DS4's chat template renders tool results as a literal `<tool_result>` tag inside the user message. So the parser does not need a separate "tool_result" role - it just escapes the result text and tucks it into a user message.

### 4.4 The Responses (Codex) parser

`/v1/responses` is the Codex CLI's protocol. The body looks like `{"input":[...], "tools":[...], "tool_choice":"auto", "reasoning":{"effort":"high"}}`. `input` is the conversation history; items can include `tool_namespace` groupings, hosted-tool descriptors, and reasoning items.

Two Responses-specific behaviors are worth flagging:

- `previous_response_id` and `conversation` are intentionally rejected (HTTP 400) - DS4 has no concept of server-managed conversation IDs. Continuation is by call_id, not by response_id.
- `tool_choice: "required"` and explicit-function `tool_choice` are rejected (`ds4_server.c:3747-3756`) because constrained decoding for those modes is not implemented. The error tells the client instead of silently downgrading to `auto`.

The Responses parser is also where the **live-tool fast paths** are set up. Inside the parser, after walking the input items, it calls a "prepare" routine (`responses_prepare_live_continuation`, around `ds4_server.c:2490`) that scans for tool-output items whose `call_id` matches a known live assistant call. If found, it computes `responses_live_suffix_text` (just the new tool results and the next assistant prefix, see [section 6](#6-rendering-only-the-tail)) and stores the matched call_ids in `responses_live_call_ids`. `generate_job` later checks those fields and, if the live session is still positioned at the right frontier, skips token-prefix matching entirely (see [section 7](#7-the-cache-decision-ladder)).

### 4.5 DSML: the markup the model speaks

DS4 does not output JSON tool calls. It emits an XML-ish format the team calls DSML (DeepSeek Markup Language). The model is taught the format by including an example in the prompt (`ds4_server.c:1996-2015`):

<svg viewBox="0 0 800 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DSML tool_calls nested tag structure"><defs><marker id="r131ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="400" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">DSML — the markup the model emits for tool calls</text><rect x="40" y="40" width="720" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="50" y="58" font-size="11" font-weight="700" fill="#9a3412">&lt;|DSML|tool_calls&gt;</text><text x="50" y="72" font-size="10" fill="#7c2d12">outer block — opens a parallel batch of one or more tool invocations</text><line x1="80" y1="80" x2="80" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r131ar)"/><rect x="80" y="98" width="680" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="90" y="116" font-size="11" font-weight="700" fill="#5b21b6">&lt;|DSML|invoke name="bash"&gt;</text><text x="90" y="130" font-size="10" fill="#5b21b6">one tool call — name attribute selects the registered tool schema</text><line x1="120" y1="138" x2="120" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r131ar)"/><rect x="120" y="156" width="640" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/><text x="130" y="174" font-size="11" font-weight="700" fill="#115e59">&lt;|DSML|parameter name="command" string="true"&gt;ls /tmp&lt;/|DSML|parameter&gt;</text><text x="130" y="188" font-size="10" fill="#064e3b">one parameter — name + string attribute; body holds the value bytes</text><text x="130" y="200" font-size="10" fill="#064e3b">string="true" → escape as JSON string · string="false" → minify raw JSON</text><line x1="120" y1="206" x2="120" y2="224" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r131ar)" stroke-dasharray="3,2"/><rect x="80" y="224" width="680" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/><text x="90" y="242" font-size="11" font-weight="700" fill="#5b21b6">&lt;/|DSML|invoke&gt;</text><line x1="80" y1="256" x2="80" y2="274" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r131ar)" stroke-dasharray="3,2"/><rect x="40" y="274" width="720" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/><text x="50" y="292" font-size="11" font-weight="700" fill="#9a3412">&lt;/|DSML|tool_calls&gt;</text><text x="40" y="328" font-size="10" fill="#64748b">escapes that round-trip: &amp;amp; &amp;lt; &amp;gt; &amp;quot; &amp;apos;  · five entities are essential because parse→render must yield identical bytes for KV cache reuse</text><text x="40" y="346" font-size="10" fill="#64748b">actual delimiter is the FE0F-decorated &lt;｜DSML｜&gt; Unicode escape; macros at ds4_server.c:4185-4193 define long / short / fallback forms</text></svg>
<span class="figure-caption">Figure R13.1 | DSML tool_calls block: nested invoke / parameter tags with name and string attributes. The model is taught this shape via an in-prompt example so its sampled output matches what the server's parser expects.</span>

<details>
<summary>ASCII fallback</summary>

```
You can invoke tools by writing a "<|DSML|tool_calls>" block like the following:

<|DSML|tool_calls>
<|DSML|invoke name="bash">
<|DSML|parameter name="command" string="true">ls /tmp</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>
```

</details>

(The actual delimiter is the FE0F-decorated `<｜DSML｜>` Unicode escape, but ASCII-only readers can think of it as `<|DSML|>`.) The macros at `ds4_server.c:4185-4193` define both the long form (`DS4_TOOL_CALLS_START`, `DS4_INVOKE_START`, etc.) and a short form, plus a fallback `<tool_calls>` for when the model drifts.

The escape rules are tight because the model can produce arbitrary tool arguments:

```c
/* The prompt renderer escapes DSML text so a tool argument can safely contain
 * shell operators or closing tags.  The generated-DSML parser must undo exactly
 * those entities before it turns parameters back into JSON; otherwise
 * parse->render is not a stable cache key. */
```
(`ds4_server.c:4261-4264`)

Five entities round-trip: `&amp; &lt; &gt; &quot; &apos;`. The unescape table is `dsml_unescape_text` at `ds4_server.c:4265`. The reason this matters for caching is that on the next turn the server has to re-render the tool call back into the prompt. If the round-trip is not identical bytes, the cached KV no longer matches, and the next request becomes a cold prefill.

The opposite direction - DSML parameter to JSON - is `dsml_parse_leaf_param_json` at `ds4_server.c:4331`. It reads `name=` and `string=` attributes from the tag, then either escapes the value as a JSON string (`string="true"`) or minifies it as raw JSON (`string="false"`). Long generations sometimes drift into a looser shape with nested parameters; the parser is forgiving rather than strict because losing the whole sampled continuation to a single malformed parameter is much worse than passing imperfect JSON to the client (`ds4_server.c:4319-4330`).

## 5. Tool memory: the verbatim replay map

Now we arrive at one of the server's three unusual subsystems.

### 5.1 The problem

The model samples bytes. The client receives a structured `tool_calls` array (OpenAI) or `tool_use` block (Anthropic). On the next request, the client sends that structured data back in the conversation history. The server has to render it back to DSML for the prompt.

But the client may have re-keyed the JSON. `{"a":1,"b":2}` and `{"b":2,"a":1}` are equivalent JSON but distinct token sequences. Even a different stringification of the same numbers (`1.0` vs `1`) can change the prompt bytes. If those bytes differ, the cached KV (token-aligned to the original sampled bytes) is invalid, and the server must re-prefill the whole turn.

The solution lives at `ds4_server.c:7719-7731`:

```c
/* The model speaks DSML, while OpenAI and Anthropic clients round-trip tool
 * calls as JSON.  Re-rendering that JSON is not always the same byte sequence:
 * clients may preserve, sort, or rebuild object keys differently.  Tool call
 * ids are the bridge between both worlds.  For every generated tool call we
 * remember the exact DSML block sampled by the model under a random id.  When
 * the client later sends the same id back in conversation history, we replay
 * the sampled DSML verbatim and keep the KV cache aligned with the live model
 * state. */
```

### 5.2 The data structure

The `tool_memory` struct at `ds4_server.c:7638` holds two radix trees and an LRU list:

```c
typedef struct {
    rax *by_id;            // tool_id -> tool_memory_entry
    rax *by_block;         // dsml_text -> tool_memory_block (with refcount)
    tool_memory_entry *head;
    tool_memory_entry *tail;
    int entries;
    int max_entries;
    size_t bytes;
    size_t max_bytes;
    uint64_t clock;
    uint64_t scan_clock;
} tool_memory;
```

The split between `entry` and `block` matters: many tool ids can point at the same DSML block (the model often calls one tool multiple times in one assistant turn, and all those calls share the surrounding `<|DSML|tool_calls>` envelope). Storing the envelope text once and reference-counting it makes the disk-trailer encoding (Chapter 14) much cheaper.

`max_entries` defaults to `DS4_TOOL_MEMORY_DEFAULT_MAX_IDS = 100000` (`ds4_server.c:7733`); `max_bytes` defaults to 512 MiB (`ds4_server.c:7734`). LRU eviction runs whenever either bound is exceeded.

### 5.3 The flow

The lifecycle of a single tool call:

1. Worker generates a tool call. After parsing the assistant's DSML into a `tool_calls` array, `assign_tool_call_ids(s, &parsed_calls, j->req.api)` (`ds4_server.c:8162`) gives each call a random `call_<32-hex>` (or `toolu_<...>` for Anthropic) id, checking against existing in-memory ids to avoid collisions.
2. `tool_memory_remember(s, &parsed_calls)` (`ds4_server.c:8072`) inserts each id into `by_id` with a pointer to the shared block.
3. The server emits the tool calls to the client.
4. The client later sends them back as conversation history.
5. The chat-message parser calls `tool_memory_attach_to_messages` (`ds4_server.c:8098`), which for each `tool_calls` array looks up each id in `by_id`. If *all* ids in the array map to the same block, it sets `calls->raw_dsml = xstrdup(matched->dsml)` so the prompt renderer can splice the exact original bytes back in.
6. If any id is missing or they disagree, the renderer falls back to canonical JSON-to-DSML rendering - lower fidelity, but the conversation can continue.

The disk-checkpoint extension (Chapter 14) writes a "tool-id map" trailer that persists this map alongside the KV payload, so a restart does not lose the verbatim replay.

The `--disable-exact-dsml-tool-replay` flag (`ds4_server.c:11370-11371`, `:11474-11475`) turns this whole subsystem off and always re-renders canonically. The flag exists because for evaluation it is sometimes useful to confirm the prompt still tokenizes correctly without the verbatim path.

## 6. Rendering only the tail

The prompt renderer has a fast path for tool-result continuation. The naive thing would be to re-render the whole conversation and tokenize it; that throws away the cached KV. Instead, `render_live_tool_tail` (`ds4_server.c:2355`) renders *only* the bytes that need to be appended to the existing live KV:

```c
/* Render only the semantic tail that must be appended to the live KV for a
 * tool-result continuation.
 *
 * In the common agent tool path, the previous assistant tool-call turn is
 * already in the model session, including hidden thinking and exact sampled
 * DSML.  The next request provides only the tool results, either as OpenAI
 * Responses tool-output items or Anthropic user content blocks.  Re-rendering
 * the assistant call here would duplicate it and destroy cache alignment, so
 * this function starts at the first new item and emits only:
 *
 *   previous EOS, tool results, and the next assistant prefix.
 *
 * This is intentionally independent from req.prompt's already-tokenized suffix */
```
(comment at `ds4_server.c:2338-2354`, function body `:2355-2403`)

What this produces, in bytes, is:

```
<|end_of_sentence|><|User|><tool_result>...</tool_result><|Assistant|><think>
```

(`<|end_of_sentence|>` is the literal special-token bytes; `<think>` is emitted if thinking mode is on, otherwise `</think>` is emitted to close any previously-open think block.)

The Anthropic fast path is wired up by `anthropic_prepare_live_continuation` (around `ds4_server.c:2571`). It walks the latest user message looking for `tool_result` blocks, collects their `tool_use_id`s, and produces `req->anthropic_live_suffix_text` if those ids correspond to the model's last sampled assistant call. The Responses path is analogous and stashes `req->responses_live_suffix_text`. Whether either path is taken at execution time is decided in `generate_job` based on whether the *live* session position still matches.

## 7. The cache decision ladder

`generate_job` (`ds4_server.c:9870-10880`) is the dispatcher. It is long (about 1000 lines), but the first 100 lines are a strict decision ladder. Here is the priority order, with file:line refs:

```
1. Responses visible-prefix continuation        ds4_server.c:9893
2. Responses tool-output-ids continuation       ds4_server.c:9904
3. Anthropic tool-output-ids continuation       ds4_server.c:9915
4. (rejection)  responses requires_live_tool, but no match  -> 409
5. (rejection)  anthropic requires_live_tool, but no match  -> 409
6. Exact token-prefix match against live KV     ds4_server.c:9943
7. Thinking-visible continuation                ds4_server.c:9947
8. Live text-prefix match                       ds4_server.c:9960
9. Disk text-prefix match                       ds4_server.c:9982
10. Cold prefill                                (everything else)
```

Each step either fills `effective_prompt` and returns a `cached` token count, or returns 0 and lets the next step try. `cache_source` is a string constant ("responses-visible", "memory-token", "memory-text", "disk-text", "none") used for logging.

The two intermediate rejection paths (steps 4, 5) are important. If a Responses request carries `responses_requires_live_tool_state = true` (set by the parser after validating that some tool result lacks a corresponding prior assistant call in the replay), and by the time the worker dequeues the job the live frontier no longer matches, the server returns HTTP 409 with "Responses continuation state is not available; retry by replaying the full input history" (`ds4_server.c:9932`). This is the protocol's way of forcing the client to re-send the full conversation, including the prior assistant tool_use, when the fast path is no longer safe.

After the ladder, three more pieces of state are computed:

- `responses_reasoning_state_preserved` (`ds4_server.c:9992`) - did the chosen cache path keep hidden reasoning tokens? True for the Responses visible/tool-output paths and for disk hits flagged `KV_EXT_RESPONSES_VISIBLE`.
- `responses_visible_replay_without_reasoning` (`ds4_server.c:9998`) - did the request claim to need reasoning state but get matched against a path that does not preserve it? If so, log a warning and continue with lower fidelity (`ds4_server.c:10050-10066`).
- `cache_read_tokens` and `cache_write_tokens` (`ds4_server.c:10006-10007`) - reported as `usage.prompt_tokens_details.cached_tokens` and DS4's extension `cache_write_tokens` in the response.

### 7.1 Why text-prefix at all

If the model sampled `[t1, t2, t3, t4]` and the next request's prompt rendered to the same bytes but tokenizes to `[t1, t2', t3, t4]` because BPE merges differently across the prompt boundary, an exact token-prefix check would fail. The text-prefix check handles this case. The trick (also used by the disk cache) is to keep using the *original* token IDs from the live session for the common prefix, and only tokenize the new text suffix afresh:

```c
build_prompt_from_exact_prefix_and_text_suffix(
    s->engine, live_tokens, req->prompt_text + visible_len,
    effective_prompt);
```
(`ds4_server.c:8910-8912`)

This is why `request.prompt_text` is kept around even after the request is tokenized: it is the lookup key, not just an intermediate.

## 8. The decode loop

After the cache decision and prefill, `generate_job` enters its main decode loop at `ds4_server.c:10261`:

```c
while (!g_stop_requested && completion < max_tokens &&
       ds4_session_pos(s->session) < ds4_session_ctx(s->session)) {
    ...
    int token = ds4_session_sample(s->session, temperature, top_k, top_p, min_p, &rng);
    if (token == ds4_token_eos(s->engine)) { finish = "stop"; break; }

    /* Maybe call ds4_session_eval_speculative_argmax for MTP */
    /* or ds4_session_eval for the simple path */

    for (int ti = 0; ti < ntok && completion < max_tokens; ti++) {
        /* extract piece text */
        /* update thinking_state, dsml_decode_tracker */
        /* compute stop_pos / stream_len with utf8_stream_safe_len */
        /* sse_chunk / anthropic_sse_stream_update / openai_sse_stream_update /
           responses_sse_stream_update */
        /* observe_tool_markers (might set saw_tool_end) */
        /* hit_stop -> finish = "stop", break */
        /* saw_tool_end -> finish = "tool_calls", break */
    }
}
```
(condensed from `ds4_server.c:10261-10474`)

Three subsystems run alongside the raw sampling:

- **`thinking_state`** (`ds4_server.c:10254`, `thinking_state_feed` updates it) tracks whether the sampled text is currently inside a `<think>...</think>` block.
- **`dsml_decode_tracker`** (`ds4_server.c:10258`, `dsml_decode_tracker_update` updates it) is a forgiving state machine that tracks where the next byte falls in a DSML tool block: outside, structural (inside tags), in a string parameter body, in a JSON parameter body. Streaming SSE projection consults this to decide whether to emit a token as plain text or as a tool-argument delta.
- **`observe_tool_markers`** (`ds4_server.c:10413`) tracks whether the model has produced a `<|DSML|tool_calls>` opening (`saw_tool_start`) and the matching close (`saw_tool_end`). Once `saw_tool_end` is true, decoding stops with `finish = "tool_calls"`.

### 8.1 The in-think tool-call guard

The decode loop has a subtle guard at `ds4_server.c:10395-10406`:

```c
if (j->req.kind == REQ_CHAT && j->req.has_tools) {
    if (thinking_gates_tool_markers && thinking.inside) {
        /* A DSML block inside reasoning is not executable.  This is
         * the live guard: do not let a quoted or mistaken marker in
         * <think> stop decoding as a real tool call. */
        tool_scan_waiting_for_think_close = true;
        tool_scan_from = text.len;
    } else {
        if (tool_scan_waiting_for_think_close) {
            const char *think_end = find_last_substr(text.ptr, "</think>");
            tool_scan_from = think_end ? (size_t)((think_end + 8) - text.ptr) : text.len;
            ...
            tool_scan_waiting_for_think_close = false;
        }
        ...
    }
}
```

The model sometimes quotes DSML inside its `<think>` block while reasoning about whether to call a tool. That quoted block is not an executable tool call - if the server treated it as one, decoding would stop early and the assistant would never produce a real call. The guard says: while inside `<think>`, do not scan the new text for tool markers, and after `</think>` closes, resume scanning from past the close tag.

(There is a corresponding agent-side change in `ds4_agent.c` at commit b63d77a, "Stop generation on in-think tool calls". That commit hardens the *agent* loop's tool-marker detection. The server-side guard predates that commit; both layers share the same invariant.)

### 8.2 MTP speculative decoding

When temperature is 0 (greedy) and the engine reports MTP draft tokens (`ds4_engine_mtp_draft_tokens(s->engine) > 1`), the server uses `ds4_session_eval_speculative_argmax` (`ds4_server.c:10290-10301`) instead of `ds4_session_eval`. This batches the verification of N draft tokens at once. The result is `ntok` actual tokens accepted in one engine call. The decode loop then iterates over each accepted token to apply streaming, stop scanning, and tool tracking. The escape hatch is the env var `DS4_MTP_SPEC_DISABLE`, useful when bisecting a kernel issue.

### 8.3 Tool-call repair and recovery

If decoding stops mid-DSML (the model emitted an opening tag but ran out of tokens before the closing tag), the server tries to repair the output at `ds4_server.c:10481-10555`:

1. `try_repair_dsml` attempts to deterministically complete a simple truncation by appending the missing closing tags. If parsing the repaired text yields valid `tool_calls`, the repair is accepted.
2. Otherwise, for non-streaming requests, `continue_after_invalid_dsml` appends a model-visible "tool error" message into the live session and re-decodes (the `goto decode_again` at `ds4_server.c:10544`). This gives the model a chance to issue a corrected call.

The recovery path is intentionally bounded: `dsml_recovery_attempted` (`ds4_server.c:10230`) prevents an infinite loop. If the second decode also fails, the response is sent as `finish="error"`.

## 9. Prefill keepalive and the f91c12b change

A 30000-token cold prefill on a MacBook can take 30+ seconds. During that time the server is busy and cannot send anything to the client. Browsers and HTTP libraries time out idle connections in 10-30 seconds. So the server has a callback-driven keepalive.

The struct is at `ds4_server.c:9261`:

```c
typedef struct {
    server *srv;
    req_kind kind;
    int prompt_tokens;
    int cached_tokens;
    char ctx[48];
    const char *phase;
    bool has_tools;
    bool responses_protocol;
    double t0;
    double last_t;
    int last_current;
    bool seen;
    /* SSE keepalive during long prefill ... */
    int fd;
    bool stream;
    bool enable_cors;
    bool headers_sent;
    bool stream_failed;
    double last_keepalive;
} server_prefill_progress;
```

The callback `server_progress_cb` (`ds4_server.c:9504`) is the change introduced by the f91c12b commit (head of `main`). Before f91c12b it accepted only one event name, `"prefill_chunk"`. After f91c12b it accepts two:

```c
static void server_progress_cb(void *ud, const char *event, int current, int total) {
    server_prefill_progress *p = ud;
    if (!p || !event) return;
    const bool is_chunk = strcmp(event, "prefill_chunk") == 0;
    const bool is_display = strcmp(event, "prefill_display") == 0;
    if (!is_chunk && !is_display) return;
```
(`ds4_server.c:9504-9509`)

The split matters because the engine now emits two kinds of progress events:

- `prefill_chunk` - a real compute chunk finished, log progress and consider writing a continued KV checkpoint.
- `prefill_display` - the engine wants the UI to keep the connection alive, but no real progress was made (think: still loading a layer from disk).

The shared keepalive block (`ds4_server.c:9518-9534`) writes the SSE headers the first time the callback fires (`!p->headers_sent`) so the client connection has a real HTTP response, then emits an SSE comment line (`: prefill\n\n` at `ds4_server.c:9527-9528`) every 5 seconds. SSE comments start with `:` and are ignored by spec-compliant clients, but they count as bytes on the wire, so HTTP/TCP idle timeouts do not fire.

After the keepalive block, the callback returns early for `prefill_display`:

```c
    if (is_display) return;
```
(`ds4_server.c:9535`)

so the real progress-logging machinery (`ds4_server.c:9536-9581`) runs only for `prefill_chunk`.

The reason for two phases is wired through `generate_job` at `ds4_server.c:10073-10074`:

```c
ds4_session_set_progress(s->session, server_progress_cb, &progress);
ds4_session_set_display_progress(s->session, server_progress_cb, &progress);
```

Two distinct hooks on the engine, both pointing at the same C function, are cleared with the matching pair of `NULL, NULL` assignments at every exit point. The same pair is set during `canonicalize_tool_checkpoint` (`ds4_server.c:9803-9804`) so the keepalive runs there too.

The same pattern is wired into `ds4_cli.c` (the interactive CLI) and `ds4.c` (the engine itself emits both events). The f91c12b commit touches all three files; in `ds4_server.c` the diff is +13 / -1 lines spread across the three call sites and the callback body.

## 10. Streaming projection

SSE for an OpenAI chat completion looks like:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: close

data: {"id":"chatcmpl-1","object":"chat.completion.chunk",...,"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-1",...,"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-1",...,"choices":[{"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-1",...,"choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

The relevant primitives:

- `sse_headers` at `ds4_server.c:4850` writes the response head.
- `sse_chunk` at `ds4_server.c:4880` writes one `data: {...}\n\n` frame.
- `sse_done` at `ds4_server.c:4957` writes the optional `usage` frame and the literal `data: [DONE]\n\n` terminator.
- `sse_error_event` at `ds4_server.c:4863` writes an `event: error\ndata: {...}\n\n` frame for in-stream failures.

The OpenAI tool-call streaming is the interesting case because the model produces DSML rather than JSON. The translator state machine is documented at `ds4_server.c:5122-5126`:

```c
/* OpenAI clients can consume function.arguments as a stream of JSON text
 * fragments.  DS4 generates XML-ish DSML instead, so this parser switches to a
 * hidden tool mode at <...tool_calls>, emits the tool header once the invoke tag
 * is complete, then translates each parameter body into argument deltas while
 * holding only tiny tails for partial closing tags, UTF-8, and DSML entities. */
```

The two delta writers:

- `sse_chat_tool_call_start_delta` (`ds4_server.c:5127`) emits the tool-call opener with id + name and an empty arguments string.
- `sse_chat_tool_call_args_delta_n` (`ds4_server.c:5146`) emits an arguments-string fragment.

The Anthropic streaming projection is at `ds4_server.c:6849-7030` and follows the same idea but with Anthropic's `content_block_start` / `content_block_delta` / `content_block_stop` event names and an `input_json_delta` payload that carries a string fragment of a JSON object. The translator emits an opening `{`, then quoted keys with raw or escaped values, then a closing `}`, exactly matching the DSML parser's final JSON build.

Responses streaming is at `ds4_server.c:6900-7300`. The notable property: argument deltas are *not* streamed because Codex's SSE consumer only reads complete `output_item.done` events for function calls. The server still tracks the tool call internally; it just does not project intermediate arguments to the wire.

### 10.1 The dsml_decode_tracker

The DSML position tracker (`ds4_server.c:5189-5239`) is the bridge between raw sampled bytes and SSE projection. Its enum says everything:

```c
typedef enum {
    DSML_DECODE_OUTSIDE,         // sampled bytes are visible text
    DSML_DECODE_STRUCTURAL,      // inside a DSML tag (`<invoke ...>`)
    DSML_DECODE_STRING_BODY,     // inside a `string="true"` parameter body
    DSML_DECODE_JSON_STRUCTURAL, // inside a `string="false"` JSON body, but not in a string
    DSML_DECODE_JSON_STRING,     // inside a string within that JSON body
} dsml_decode_state;
```

Five states is enough to know, byte by byte, whether a sampled token should be:
- streamed to the client as visible content (`OUTSIDE`),
- discarded from the visible stream and projected as protocol metadata (`STRUCTURAL`),
- streamed as part of a tool-argument JSON value (everything else).

The tracker mode (`DSML_TRACK_SEARCH`, `DSML_TRACK_STRUCTURAL`, ...) is updated by `dsml_decode_tracker_update`. The note at `ds4_server.c:5189-5204` calls it "intentionally a forgiving recognizer, not a validator" - malformed DSML still gets parsed later by the normal parser, the tracker only needs enough state to decide what kind of SSE frame to emit.

## 11. Putting it together: one request

Let us walk a single request through the server.

The client (a Claude Code session) sends:

```
POST /v1/messages HTTP/1.1
Host: 127.0.0.1:8000
Content-Type: application/json
Content-Length: 14823

{ "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 4096,
  "stream": true,
  "thinking": {"type": "enabled", "budget_tokens": 8192},
  "tools": [{"name":"bash", "input_schema":{...}}],
  "messages": [
    { "role": "user", "content": [{"type":"text","text":"List the C files in this repo."}] },
    { "role": "assistant", "content": [
        {"type":"thinking", "thinking":"User wants ls. I should call bash."},
        {"type":"tool_use", "id":"toolu_abc...", "name":"bash", "input":{"command":"ls *.c"}}
    ] },
    { "role": "user", "content": [
        {"type":"tool_result", "tool_use_id":"toolu_abc...", "content":"ds4.c\nds4_server.c\n..."}
    ] }
  ]
}
```

What happens, step by step:

1. **Accept**. `main`'s accept loop (`ds4_server.c:11604`) returns a new `fd`. `configure_client_socket(fd)` sets `SO_RCVTIMEO/SO_SNDTIMEO` to 10 s. A new client thread is spawned with `pthread_create`.

2. **HTTP read**. `read_http_request` (`ds4_server.c:10963`) reads until `\r\n\r\n`, sscanfs `POST /v1/messages`, reads `Content-Length: 14823`, fills `hr.body`.

3. **Route**. `client_main` matches `POST /v1/messages` at `ds4_server.c:11111` and calls `parse_anthropic_request`.

4. **Parse**. `parse_anthropic_request` (`ds4_server.c:2778`):
   - walks the JSON, collecting `model`, `max_tokens`, `stream`, `thinking`, `tools`, `messages`
   - calls `parse_messages` -> `parse_anthropic_content_block` for each user/assistant turn
   - the assistant's `tool_use` block becomes `chat_msg.calls[0]` with `id="toolu_abc..."`
   - the user's `tool_result` becomes `<tool_result>ds4.c\nds4_server.c\n...</tool_result>` text inside `msg.content`
   - calls `kv_cache_restore_tool_memory_for_messages` (`ds4_server.c:8511`) to seed `tool_mem` from any disk-resident KTM trailer entries that match the ids in this conversation
   - calls `tool_memory_attach_to_messages` to attach `raw_dsml` to the assistant's `tool_calls` array if all ids in it map to one block in memory
   - calls `anthropic_prepare_live_continuation` to detect that this user message is a pure tool_result follow-up and stash `req->anthropic_live_suffix_text` + `req->anthropic_live_call_ids`
   - calls `render_chat_prompt_text(&msgs, ...)` to produce the full rendered prompt text
   - calls `ds4_tokenize_rendered_chat` to tokenize it

5. **Enqueue**. `client_main` allocates `job j` on its stack, sets `j.fd` and `j.req`, calls `set_client_socket_nonblocking(fd)`, and `enqueue(s, &j)`. Then it blocks on `j.cv`.

6. **Dequeue**. The worker (`worker_main`, `ds4_server.c:10910`) had been waiting on `s->cv`. It wakes, takes `j` off `s->head`, and calls `generate_job(s, j)`.

7. **Cache ladder**. `generate_job` walks the ladder (section 7 above):
   - Responses visible-prefix: no (not a Responses request) -> 0
   - Responses tool-output: no -> 0
   - Anthropic tool-output-ids continuation (`ds4_server.c:9915`):
     - `req->anthropic_live_suffix_text` is set
     - `anthropic_live_matches_request(s, &req->anthropic_live_call_ids, old_pos)` checks that the server's `s->anthropic_live.call_ids` contains `toolu_abc...` and `s->anthropic_live.live_tokens == old_pos`
     - if both true, `build_prompt_from_exact_prefix_and_text_suffix` builds `effective_prompt = live_tokens + tokenize(anthropic_live_suffix_text)`
     - returns `cached = live_tokens->len`, `cache_source = "anthropic-tool-output"`

8. **Prefill**. `ds4_session_set_progress(s->session, server_progress_cb, &progress)` and the matching `display_progress` are installed. `ds4_session_sync(s->session, prompt_for_sync, ...)` runs. Because `cached` equals the live frontier and only the new suffix is appended, the prefill is short (a few hundred tokens at most: `<|end_of_sentence|><|User|><tool_result>...</tool_result><|Assistant|><think>`).

9. **SSE headers**. If the progress callback fired during prefill, headers were already sent (`progress.headers_sent == true`). Otherwise `sse_headers(j->fd, s->enable_cors)` writes them now.

10. **Anthropic stream start**. `anthropic_sse_start_live` emits a `message_start` event, content blocks for any starting thinking block, etc.

11. **Decode loop**. The worker samples tokens. For each:
    - `dsml_decode_tracker_update` keeps the wire-projection state correct
    - `thinking_state_feed` tracks `<think>` open/close
    - `anthropic_sse_stream_update` emits `content_block_delta` events
    - `observe_tool_markers` looks for `<|DSML|tool_calls>` markers
    - if a stop sequence or `</think>...</invoke>` is seen, the loop exits

12. **Parse and finalize**. After decode:
    - `parse_generated_message_for_response` extracts content / reasoning / tool_calls
    - if there are tool calls: `apply_anthropic_stream_tool_ids` (`ds4_server.c:8185`) merges in the random ids assigned during streaming, `tool_memory_remember` (`ds4_server.c:8072`) saves the verbatim DSML
    - `anthropic_live_remember` (`ds4_server.c:7981`) updates `s->anthropic_live` so the next tool-result follow-up can take the fast path again
    - `kv_cache_maybe_store_continued` may have already saved a "continued" checkpoint at a token-aligned boundary during decode (see Chapter 14)

13. **Finish**. `anthropic_sse_finish_live` emits the final `message_delta` and `message_stop` events. The worker sets `j->done = true`, signals `j->cv`.

14. **Client cleanup**. The client thread wakes from `pthread_cond_wait`, destroys `j.cv` / `j.mu`, frees `j.req`, closes `fd`, decrements `s.clients`, and exits.

Total elapsed time for a tool-result follow-up that hits the live KV: tens of milliseconds for the prefill, then real generation time. Without the live continuation path, the same request would re-prefill the entire 14 KB prompt and lose the model's hidden thinking from the previous turn.

## 12. Configuration surface

The relevant flags for understanding server behavior:

```
-m, --model FILE                    GGUF weights (default ds4flash.gguf)
--mtp FILE / --mtp-draft N          MTP speculative decoder
-c, --ctx N                         Context size at startup (default 32768)
-n, --tokens N                      Default max output tokens (default 393216)
--chdir DIR                         chdir before loading model / metal kernels
--host HOST                         Bind host (default 127.0.0.1)
--port N                            Bind port (default 8000)
--cors                              Emit Access-Control-Allow-* headers
--trace FILE                        Write human-readable session trace
--kv-disk-dir DIR                   Enable disk KV cache (Chapter 14)
--kv-disk-space-mb N                Disk budget (default 4096 MiB)
--kv-cache-min-tokens N             Minimum tokens to checkpoint (default 512)
--kv-cache-cold-max-tokens N        Auto-cold-save threshold (default 30000)
--kv-cache-continued-interval-tokens N   Continued checkpoint interval (default 10000)
--kv-cache-boundary-trim-tokens N   Trim tail before cold save (default 32)
--kv-cache-boundary-align-tokens N  Align cold save (default 2048)
--kv-cache-reject-different-quant   Refuse cross-quant checkpoints
--disable-exact-dsml-tool-replay    Disable verbatim DSML map
--tool-memory-max-ids N             RAM tool-id cap (default 100000)
--think / --nothink                 Override default think mode
```
(parsed at `ds4_server.c:11412-11522`; documented in `usage()` at `ds4_server.c:11299-11390`)

The defaults match a single-user MacBook deployment. The most consequential flags in practice are `--ctx` (memory budget for the live session) and `--kv-disk-dir` (whether long agent sessions can survive a server restart).

### 12.1 CORS

CORS is off by default and there is no way to configure origins or methods - either all are allowed, or no header is emitted. The relevant test at `ds4_server.c:12020-12034` enforces:

- Without `--cors`: response headers must *not* include any `Access-Control-Allow-*`.
- With `--cors`: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: *` are emitted.

The opt-in design is deliberate: the assumption is that any browser client running this server is doing so on `localhost` and is fully trusted, but the operator must say so explicitly. There is no scenario in which random remote browsers should be talking to this server.

### 12.2 Trace files

`--trace PATH` opens an unbuffered file at startup (`ds4_server.c:11574-11583`) and the server writes a structured per-request log: input messages, cache decision, output token text, parsed tool calls, finish reason. The relevant primitive is `trace_begin` / `trace_event` / `trace_piece` / `trace_finish` (defined further up the file). Trace is the single best way to debug a cache miss: `cache_diag` (`trace_cache_capture` at `ds4_server.c:9876`) records why each ladder step rejected the request.

## 13. Three details worth their own section

Three more pieces deserve to be more than footnotes: how Anthropic streaming threads a four-mode state machine through the same byte stream OpenAI streaming projects differently; how the post-decode parse round-trips through `parse_generated_message_for_response`; and how the canonical-rewrite path keeps the live KV usable across multi-turn agent loops.

### 13.1 The Anthropic stream state machine

The Anthropic projection is the most complex of the three because Anthropic's wire format models content as a list of typed *content blocks* that must be opened and closed in order. The model is sampling one continuous stream of bytes, but the wire sees a sequence of `content_block_start` / `content_block_delta` / `content_block_stop` events with monotonic indices.

The state machine has four modes (`ds4_server.c:6905-6910`):

```c
typedef enum {
    ANTH_STREAM_THINKING,  // raw bytes are thinking-block text
    ANTH_STREAM_TEXT,      // raw bytes are visible assistant text
    ANTH_STREAM_TOOL,      // raw bytes are inside a DSML tool block
    ANTH_STREAM_SUPPRESS,  // raw bytes are DSML protocol metadata; do not emit
} anthropic_stream_mode;
```

Transitions are driven by `dsml_decode_tracker` (the byte-position tracker from section 10.1) and by detecting `<think>` / `</think>` boundaries in the sampled text. The current open block type (`anthropic_block_type` at `ds4_server.c:6912-6917`) tracks which block on the wire is open right now, so the projector knows when it needs to emit a `content_block_stop` before opening the next type.

Thinking blocks need one Anthropic-specific touch when they close: a `signature_delta` event must be appended:

```c
buf_printf(&b,
           "{\"type\":\"content_block_delta\",\"index\":%d,"
           "\"delta\":{\"type\":\"signature_delta\",\"signature\":",
           st->next_index);
json_escape(&b, id);
```
(around `ds4_server.c:7034`)

The signature is the SSE chunk id used in the rest of the stream. Anthropic clients use it to verify that the thinking block came from the same response and was not tampered with by a proxy.

For tool blocks, the open event has to wait until the `<|DSML|invoke name="X">` tag is complete (so the projector knows the tool name and can assign an id). Once the tag is closed, `anthropic_sse_open_tool_block` (`ds4_server.c:7045`) emits `content_block_start` with `{"type":"tool_use","name":"X","id":"toolu_..."}`. Subsequent parameter bodies become `input_json_delta` events. The note at `ds4_server.c:7007-7013` describes the JSON-fragment encoding: an opening `{`, quoted keys, raw JSON values or escaped string contents, and the closing `}` - exactly the bytes the final DSML parser will assemble.

The `anthropic_tool_stream` substate (`ds4_server.c:6919-6931`) carries an array of per-index tool ids. These are generated on the fly during streaming because the client wants to see the id alongside the tool name on the wire, before the assistant turn finishes. After decode, `apply_anthropic_stream_tool_ids` (`ds4_server.c:8185-8197`) reconciles the streaming ids with the final parsed `tool_calls`, ensuring the ids the client received during streaming are the same ones `tool_memory_remember` writes into the radix tree:

```c
/* The SSE stream may have exposed tool ids before final DSML parsing.  The
 * parsed calls must inherit those ids before assign_tool_call_ids() and
 * tool_memory_remember(), otherwise the client returns a tool_result for an
 * id that the continuation fast path does not know. */
```
(`ds4_server.c:8188-8191`)

Without this reconciliation, the client would have an id the server never persisted, and the next tool-result follow-up would fall off the live continuation path into a full cold prefill - exactly the failure mode the verbatim replay map exists to prevent.

### 13.2 Post-decode parsing

The decode loop appends every sampled byte into a single `buf text`. After the loop exits, `parse_generated_message_for_response` (called at `ds4_server.c:10581`) re-walks that buffer to extract three things:

- `parsed_content` - the visible assistant text (stripped of `<think>...</think>` and DSML tool blocks)
- `parsed_reasoning` - the contents of any `<think>...</think>` block
- `parsed_calls` - a `tool_calls` array, each entry with `id` (left empty - filled in by stream IDs or assigned later), `name`, `arguments` JSON

The function also produces a `final_finish` reason and a `recovered_tool_parse_failure` flag. The latter is set when DSML markers were observed (`saw_tool_start`) but the parser could not turn the block into valid tool calls. In that case, the recovery path (`ds4_server.c:10593-10676`) feeds a model-visible tool error into the live session and re-decodes via `goto decode_again`. This is bounded by `dsml_recovery_attempted` so the recovery runs at most once.

The interaction with streaming is subtle: for OpenAI clients, `parsed_calls` is the final, canonical version sent in the response. But the SSE stream already emitted partial argument deltas during decode. The id assigned in the SSE stream (random, deterministic per call) must match the id in `parsed_calls`. `apply_openai_stream_tool_ids` and `apply_anthropic_stream_tool_ids` (`ds4_server.c:8162-8197`) do this reconciliation: they walk `parsed_calls`, and for any call whose id is still empty, they take the id that was generated during streaming and stored in the stream's `ids[]` array.

For Anthropic, there is also a contract with `anthropic_live_remember` (`ds4_server.c:7981`). If parsing succeeds and produces tool calls with non-empty ids, the live state is updated so the next turn's tool-result fast path works. If parsing fails, the live state is cleared (`ds4_server.c:10723-10725`); the next request will have to use full prefix matching.

### 13.3 Canonicalize tool checkpoint

After a successful tool-call decode, the live KV state is positioned at the exact bytes the model sampled (DSML, with the model's particular spacing and entity escaping). But the *next* request will render those same calls back from a JSON `tool_calls` array, possibly with different byte spacing. If the bytes diverge, even by one byte, the next request loses its live KV continuation and falls back to text-prefix or disk.

`canonicalize_tool_checkpoint` at `ds4_server.c:9700-9846` is the fix. After parsing the assistant turn, if there is no exact-DSML replay available (because the model produced a malformed call that was repaired, or because exact replay is disabled), the server:

1. Renders the *canonical* prompt-text version of this assistant turn (the same bytes the next request will produce on re-render).
2. Tokenizes that canonical text to get `canonical` tokens.
3. Computes `common = ds4_session_common_prefix(s->session, &canonical)`.
4. If `common == live_len` and `canonical.len == live_len`, no rewrite is needed (`ds4_server.c:9715`).
5. Otherwise, if the canonical text equals the rendered live text byte-for-byte, also skip (`ds4_server.c:9719-9727`) - canonicalizing tokens would only replace a valid sampled history with a different BPE spelling of the same transcript.
6. Otherwise call `ds4_session_rewrite_from_common(s->session, &canonical, common, ...)`. There are three results:
   - `DS4_SESSION_REWRITE_OK`: the rewrite fit in the live raw-window ring, we are done.
   - `DS4_SESSION_REWRITE_REBUILD_NEEDED`: the canonical tail is too long to overwrite safely in place; prefer reloading an older disk checkpoint and re-syncing rather than throwing away all live state. This is the `ds4_server.c:9748-9834` branch, which kv_cache_try_load_text + ds4_session_sync.
   - any other error: log and continue with the un-canonicalized state.

The reason this only runs for non-Responses requests (`ds4_server.c:10728-10730`) is that Responses has `previous_response_id` semantics that bind the next turn to the live state by id, not by prompt-rendered bytes. There is nothing to canonicalize against.

The recent f91c12b change touched this function too: the `set_display_progress` pair (`ds4_server.c:9803-9807`, `:9825-9826`) ensures keepalive comments are still emitted during a rebuild that might take seconds.

## 14. Error responses by API

Errors are projected differently per API. The branch for context-length-exceeded shows the pattern (`ds4_server.c:4813-4844`):

```c
if (r && r->api == API_ANTHROPIC) {
    buf_puts(&b, "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":");
    json_escape(&b, msg);
    /* + n_prompt_tokens, n_ctx */
} else {
    buf_puts(&b, "{\"error\":{\"message\":");
    json_escape(&b, msg);
    buf_puts(&b, ",\"type\":\"invalid_request_error\",\"param\":");
    json_escape(&b, context_length_error_param(r));
    buf_puts(&b, ",\"code\":\"context_length_exceeded\",\"n_prompt_tokens\":");
    /* + n_prompt_tokens, n_ctx */
}
```

`context_length_error_param` (`ds4_server.c:4800-4804`) picks `"input"` for Responses, `"prompt"` for completion-style requests, and `"messages"` for chat. The `n_prompt_tokens` / `n_ctx` extension fields are not part of the upstream OpenAI/Anthropic schema; they are added because operators of a small-context model need to see exactly how badly the request overshot.

The general-purpose `http_error` (`ds4_server.c:4790`) emits the OpenAI shape regardless of `r->api`. The Anthropic-shaped error is only used for the context-length case because that error is by far the most common in real workloads (long agent sessions slowly exceeding ctx) and a malformed JSON `error` field there confuses the Anthropic SDKs into a generic "internal error" message that obscures the real cause.

SSE errors mid-stream (`sse_error_event`, `ds4_server.c:4863`) are similarly projected:

- Anthropic: `event: error\ndata: {"type":"error","error":{"type":"api_error","message":"..."}}\n\n`
- everything else: `event: error\ndata: {"error":{"message":"...","type":"server_error"}}\n\n`

After an SSE error event the connection is closed. The client sees a structured error event, not a truncated stream.

## 15. The CORS preflight short-circuit

Browser JS clients send `OPTIONS` preflight requests before any cross-origin `POST` with a `Content-Type: application/json` body. The handler at `ds4_server.c:11090-11094` is:

```c
if (!strcmp(hr.method, "OPTIONS")) {
    http_response(fd, s->enable_cors, 204, NULL, "");
    http_request_free(&hr);
    goto done;
}
```

204 No Content, no body, no `Content-Type`, just the bare HTTP status line and (if `--cors` was passed) the `Access-Control-Allow-*` headers from `append_cors_headers` (`ds4_server.c:4757-4762`).

This short-circuit is the only reason `--cors` matters beyond the response headers on the POST itself: without an OPTIONS handler that emits the allow-headers, the browser will reject the subsequent POST before it is even sent. With `--cors`, the OPTIONS returns 204 plus the headers, the browser accepts the preflight, and the POST goes through.

## 16. The HTTP path of a request, summarized

To anchor everything before moving on to Chapter 14, here is the full path of one request rendered as ASCII, with the file:line refs that own each step:

```
client TCP connection                                                accept
        |                                                              |
        v                                                              v
read_http_request               <-- ds4_server.c:10963     ds4_server.c:11604
parse method, path, headers, body
        |
        +-- OPTIONS              -> 204 No Content (CORS preflight)  ds4_server.c:11090
        +-- GET /v1/models       -> append_model_json + send         ds4_server.c:11096
        +-- POST /v1/messages    -> parse_anthropic_request          ds4_server.c:2778
        +-- POST /v1/chat/...    -> parse_chat_request               ds4_server.c:2608
        +-- POST /v1/responses   -> parse_responses_request          ds4_server.c:3667
        +-- POST /v1/completions -> parse_completion_request         ds4_server.c:3961
        +-- else                 -> 404                              ds4_server.c:11123
        |
        v
parser fills `request`:
   prompt + prompt_text + stops + tool_orders + think_mode + api-specific live fields
        |
parse-time tool-memory side effects:
   kv_cache_restore_tool_memory_for_messages   ds4_server.c:8511
   tool_memory_attach_to_messages              ds4_server.c:8098
        |
render_chat_prompt_text + ds4_tokenize_rendered_chat
        |
request_exceeds_context?                          ds4_server.c:4806
   yes -> http_error_context_length_exceeded     ds4_server.c:4813
        |
set_client_socket_nonblocking                     ds4_server.c:11204
job j; enqueue(s, &j); cond_wait(j.cv)            ds4_server.c:11141
        |
        v
=== worker thread, inside generate_job ===       ds4_server.c:9870

cache decision ladder:
  1. responses_live_visible_prefix_prompt        ds4_server.c:9893
  2. responses_live_continuation_prompt          ds4_server.c:9904
  3. anthropic_live_continuation_prompt          ds4_server.c:9915
  4. responses_requires_live_tool_state -> 409   ds4_server.c:9932
  5. anthropic_requires_live_tool_state -> 409   ds4_server.c:9938
  6. exact token-prefix                          ds4_server.c:9943
  7. thinking_live_visible_prefix_prompt         ds4_server.c:9947
  8. live_text_prefix_prompt                     ds4_server.c:9961
  9. kv_cache_try_load (disk)                    ds4_server.c:9982
 10. cold prefill (cached = 0)
        |
ds4_session_set_progress + display_progress      ds4_server.c:10073
maybe prefill to cold_store_len + kv_cache_store_live_prefix(reason="cold")
ds4_session_sync(prompt_for_sync)                ds4_server.c:10129
        |
decode loop:                                     ds4_server.c:10261
   ds4_session_sample
   dsml_decode_tracker_update
   stream chunk via sse_chunk / anthropic_sse_stream_update / ...
   observe_tool_markers
   hit_stop / saw_tool_end -> break
        |
parse_generated_message_for_response             ds4_server.c:10581
   recover via continue_after_invalid_dsml if needed (-> decode_again)
        |
api-specific live remember:
   responses_live_remember                        ds4_server.c:7964
   anthropic_live_remember                        ds4_server.c:7981
canonicalize_tool_checkpoint (chat only)         ds4_server.c:9700
remember_thinking_checkpoint                     ds4_server.c:9680
        |
emit final stream events:
   anthropic_sse_finish_live                      ds4_server.c:7557
   openai_sse_finish_live
   responses_sse_finish_live
   sse_done + [DONE]                              ds4_server.c:4957
        |
j.done = true; cond_signal(j.cv)
        |
=== back on client thread ===
free job, close fd, exit                          ds4_server.c:11160-11167
```

Every named function in that diagram is in `ds4_server.c`. The disk-cache machinery (`kv_cache_*`) shows up at three points: the parse-time tool-memory restore (step 2 of parser), the cold/continued saves around prefill (step "maybe prefill to cold_store_len" and inside the decode loop), and the disk load attempt (step 9 of the ladder). Those three points are the bridge into Chapter 14.

## 17. What this chapter glossed over

A few things this tour did not cover, with file:line pointers for the curious:

- The `chat_msgs` and `tool_calls` structs and how they are filled by message parsers (`ds4_server.c:540-560`, `:514-519`).
- How `tool_schema_orders` preserves the client's declared property order so re-emitted tool-call JSON matches the schema's declared key order (`ds4_server.c:528-544`).
- The `responses_stream` / `openai_stream` / `anthropic_stream` per-tool-call state (`ds4_server.c:5670-5800` and friends) that tracks which tool-call index is currently being streamed.
- The full `parse_responses_input` walker (around `ds4_server.c:3000-3500`) that handles tool_namespace items and reasoning items.
- The OPTIONS / CORS preflight short-circuit at `ds4_server.c:11090-11094`.
- Trace event types and the cache-miss reason taxonomy.

Chapter 14 picks up where the cache ladder leaves off and explains exactly what is in each `.kv` file on disk, why the filename is `SHA1(text)` rather than `SHA1(tokens)`, and how the tool-memory trailer makes verbatim replay survive across restarts.
