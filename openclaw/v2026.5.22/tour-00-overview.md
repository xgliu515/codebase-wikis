# Tour Step 00: Overview

Code version locked to `openclaw/openclaw@a374c3a5bf` (tag `v2026.5.22`, 2026-05-24). All `file:line` refs are repo-root-relative paths at this commit.

## Why a narrative trace?

The 15 reference chapters in this wiki give you OpenClaw in **breadth**: subsystem by subsystem, design choice by design choice, with all the variations and edge cases laid out. That is the right shape for the second pass, when you already know which subsystem you want to deepen. But it is the wrong shape for the first pass. On a first read you do not yet know what a `MsgContext` is, or why `ReplyDispatcher` is a separate object from the agent, or where the WebSocket frame becomes an RPC call. You need a thread to pull, not a map of every room.

This narrative trace gives you that thread. It picks one tiny, real request — a user typing `hello` into WebChat and the assistant streaming a short reply back — and walks it end-to-end through the entire stack. From `openclaw.mjs` to the WebSocket broadcast and the session-store write, every step appears, in order, with the actual `file:line` references. Nothing skipped, nothing reordered.

The pedagogical bet is that **one dimensional thread, fully traced, teaches the system better than fifteen subsystem chapters read cold**. After this tour you will know the shape of the river. After the reference chapters you will know the depth of each pool. Read the tour first.

A related claim: tracing one *real* request beats tracing a toy or composed-up example, because every line of code the trace touches is code that runs in production for every other user. Nothing in this trace is hypothetical. The same boot sequence runs when you start any gateway; the same RPC method registry serves any client; the same agent runtime answers every prompt. Coverage of the spine is therefore real coverage of the architecture, not coverage of a contrived path that exists only in the wiki.

## The chosen trace target

The single request we trace, in plain words:

> A user opens the bundled WebChat surface in their browser. The page is already connected to the local gateway. They type `hello` in the input box and press send. The default agent is configured against an Anthropic provider (`claude-sonnet-4-6` or whatever the default is at this commit). The model returns a short reply — three or four tokens. The reply streams into WebChat and is rendered. Done.

We deliberately keep the example minimum-viable. Everything else stays out of scope:

- **No tool calls**. The reply is plain text. We do not trace the tool-use loop, MCP, or skills.
- **No multi-channel routing**. WebChat in, WebChat out. No Slack/Telegram/Discord forks.
- **No attachments, no media, no voice**. Pure text.
- **No retry / multi-attempt path**. The first provider call succeeds.
- **No plugin-supplied channels beyond the bundled defaults**. WebChat is bundled, so it loads without third-party plugins.
- **No `--container`, no `--profile`, no `--dev`, no Tailscale, no TLS**. Loopback HTTP+WS, default config.
- **No `secrets audit`, no `gateway --force`, no `gateway stop`.** We start, we serve one round trip, and we stay running.
- **No update-in-place restart, no SIGUSR1 reloads, no plugin hot-reload.** The process runs straight through the whole 17 steps with no lifecycle event other than the one chat round-trip.

These omissions are intentional. They turn a 50-step labyrinth into a 17-step spine. The spine teaches the architecture; the omitted branches are pointed at in each step's section 7, so you know where to look once you want depth.

One more honest framing point: this trace is not a benchmark or a worst-case. It is the *cleanest possible* round-trip. The interesting design decisions OpenClaw makes appear even on this path — the launcher's two-layer environment governance, the gateway lock with zombie reclaim, the method-registry merge of core + plugin + ad-hoc descriptors, the `ReplyDispatcher` indirection between agent events and channel sends. Each of those would be just as visible on a more complex request, plus extra branches. Reading those branches first would hide the spine; reading the spine first makes them legible.

## The 8-section template

Steps 01 through 17 every use the same eight-section structure. The structure is not cosmetic — it forces each step to build tension before resolution, so you learn **why** OpenClaw is shaped the way it is, not just **what** the code looks like.

1. **Current situation** — what the system holds in its hands at the end of the previous step.
2. **The problem** — the one question this step must answer, stated in a sentence.
3. **Naive approach** — what a competent engineer who had never read this code would try first.
4. **Why the naive approach breaks** — the specific failure modes, in concrete terms, that force a better design.
5. **OpenClaw's approach** — the actual solution. Always opens with "OpenClaw's approach is to...".
6. **Code locations** — a compact bulleted list of the most important `file:line` references for this step.
7. **Branches and extensions** — the paths we did not take here, with cross-links into reference chapters. This is the knowledge net.
8. **What you should now have in your head** — three to five concrete takeaways. If you cannot restate them, the step did not land.

Sections 2, 4, and 5 are the load-bearing trio. Section 6 is the index for verification against source. Section 8 is the self-check.

Why this template, and not just "narrative"? Because pure narrative makes it too easy to nod along without absorbing. Forcing each step to articulate the problem before the solution, and to name the naive design that breaks before showing the real one, produces a sequence of small "oh, *that* is why" moments. Those moments are what make the design choices stick. By the end of 17 steps you should be able to predict roughly how OpenClaw would handle a feature you have not yet read about — because the same problem-then-solution structure recurs at every layer.

The "naive approach" section is not a strawman. It is what a competent engineer who had read no OpenClaw source would draft on a whiteboard. Reading what is wrong with it is half the lesson.

## 17-step preview

| Step | Title | Key code | Output state after this step |
|------|-------|----------|------------------------------|
| 01 | After typing `openclaw gateway` | `openclaw.mjs`, `src/entry.ts`, `src/cli/run-main.ts` | Node process up, argv normalized, `process.title="openclaw"`, about to enter gateway command |
| 02 | Gateway server starts listening | `src/cli/gateway-cli/run-loop.ts`, `src/gateway/server.impl.ts`, `src/infra/gateway-lock.ts` | HTTP+WS listener bound, session lock held, RPC registry built, no clients yet |
| 03 | WebChat opens a connection | `src/gateway/server.impl.ts` (WS handlers), `connect` frame handler | WebSocket connection upgraded, `connectionId` assigned, connection-level auth passed |
| 04 | Client sends `chat.send` | WebChat frontend, `src/gateway/server.impl.ts` frame dispatch | A `chat.send` RPC request frame is in the gateway, awaiting method dispatch |
| 05 | RPC method registry dispatch | `src/gateway/methods/registry.ts`, `core-descriptors.ts` | `chat.send` handler resolved, scope `operator.write` authorized, handler invoked |
| 06 | Building MsgContext | `src/gateway/methods/core-descriptors.ts`, `MsgContext` type | A normalized `MsgContext` exists with text, channel, session pointer |
| 07 | dispatchInboundMessage | `src/gateway/dispatch-inbound.ts` | Inbound coordinator owns the request; about to resolve session |
| 08 | Session resolution & load | `src/config/sessions/*`, agent + model picked | `session` loaded, `agent` and `model` resolved |
| 09 | `message_received` hook | `src/hooks/*` | Plugins had their chance to mutate / veto; message continues |
| 10 | Creating the `ReplyDispatcher` | reply dispatcher constructor | `ReplyDispatcher` instance ready to receive agent events |
| 11 | Entering the agent command | `src/commands/agent.ts`, `src/gateway/agent-prompt.ts` | Agent runtime entered, attempt 1 about to start |
| 12 | Building the prompt & context | prompt assembly | Final messages array (system + history + `hello`) ready for provider |
| 13 | Calling the LLM provider | `src/llm/providers/anthropic/*` | Provider streaming call open, first byte expected |
| 14 | Emitting & subscribing to stream events | agent event bus | Token deltas flowing as `agent.text` events; `ReplyDispatcher` subscribed |
| 15 | Assembling the `ReplyPayload` | reply assembly in `ReplyDispatcher` | Final `ReplyPayload` materialized with full assistant text |
| 16 | Delivering back to WebChat and broadcasting | WS broadcast, channel send | Reply frame written to WebChat socket; other subscribers notified |
| 17 | Session persistence | `src/config/sessions/store.ts` | Transcript written to session store; loop returns to idle |

A quick way to read the table: the first column is your linear position, the second is the action of the step, the third is where to look in source if the description is not enough, and the fourth is the state object the step produces. If you find yourself wondering "wait, where did the `ReplyDispatcher` come from?" jump to its first appearance — step 10 — and the prior steps will not have hidden it from you, because it does not exist before step 10.

<svg viewBox="0 0 880 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OpenClaw trace tour 17 steps grouped by architecture layer">
  <defs>
    <marker id="t0arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">The 17-step trace, grouped by architecture layer</text>
  <rect x="30" y="48" width="820" height="62" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="48" y="70" font-size="12" font-weight="700" fill="#ea580c">L1 Channels (WebChat)</text>
  <text x="48" y="92" font-size="11" fill="#64748b">browser surface, WebSocket transport, channel-side delivery</text>
  <g font-size="11" fill="currentColor"><circle cx="690" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="690" y="82" text-anchor="middle" font-weight="600">03</text><circle cx="725" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="725" y="82" text-anchor="middle" font-weight="600">04</text><circle cx="790" cy="78" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="790" y="82" text-anchor="middle" font-weight="600">16</text></g>
  <rect x="30" y="128" width="820" height="62" rx="8" fill="#fdba74" stroke="#f97316" stroke-width="1.2"/>
  <text x="48" y="150" font-size="12" font-weight="700" fill="#9a3412">L2 Gateway control plane</text>
  <text x="48" y="172" font-size="11" fill="#64748b">boot, lock, listener, RPC method registry, scope authorization</text>
  <g font-size="11" fill="currentColor"><circle cx="585" cy="158" r="14" fill="#fff" stroke="#f97316" stroke-width="1.2"/><text x="585" y="162" text-anchor="middle" font-weight="600">01</text><circle cx="620" cy="158" r="14" fill="#fff" stroke="#f97316" stroke-width="1.2"/><text x="620" y="162" text-anchor="middle" font-weight="600">02</text><circle cx="690" cy="158" r="14" fill="#fff" stroke="#f97316" stroke-width="1.2"/><text x="690" y="162" text-anchor="middle" font-weight="600">05</text></g>
  <rect x="30" y="208" width="820" height="62" rx="8" fill="#fb923c" stroke="#ea580c" stroke-width="1.2"/>
  <text x="48" y="230" font-size="12" font-weight="700" fill="#ffffff">L3 Message orchestration</text>
  <text x="48" y="252" font-size="11" fill="#fef3c7">MsgContext, session resolve, hook fan-out, ReplyDispatcher, persistence</text>
  <g font-size="11" fill="currentColor"><circle cx="510" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="510" y="242" text-anchor="middle" font-weight="600">06</text><circle cx="545" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="545" y="242" text-anchor="middle" font-weight="600">07</text><circle cx="580" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="580" y="242" text-anchor="middle" font-weight="600">08</text><circle cx="615" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="615" y="242" text-anchor="middle" font-weight="600">09</text><circle cx="650" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="650" y="242" text-anchor="middle" font-weight="600">10</text><circle cx="755" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="755" y="242" text-anchor="middle" font-weight="600">15</text><circle cx="790" cy="238" r="14" fill="#fff" stroke="#ea580c" stroke-width="1.2"/><text x="790" y="242" text-anchor="middle" font-weight="600">17</text></g>
  <rect x="30" y="288" width="820" height="62" rx="8" fill="#c2410c" stroke="#9a3412" stroke-width="1.2"/>
  <text x="48" y="310" font-size="12" font-weight="700" fill="#ffffff">L4 AI core (agent + LLM provider)</text>
  <text x="48" y="332" font-size="11" fill="#fed7aa">agent-command, prompt assembly, Anthropic stream, event emission</text>
  <g font-size="11" fill="currentColor"><circle cx="685" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="685" y="322" text-anchor="middle" font-weight="600">11</text><circle cx="720" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="720" y="322" text-anchor="middle" font-weight="600">12</text><circle cx="755" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="755" y="322" text-anchor="middle" font-weight="600">13</text><circle cx="790" cy="318" r="14" fill="#fff" stroke="#c2410c" stroke-width="1.2"/><text x="790" y="322" text-anchor="middle" font-weight="600">14</text></g>
  <text x="30" y="384" font-size="11" font-style="italic" fill="#64748b">Reading order: 01 → 17 (the request flows down through L1→L4 to call the model, then bubbles back L4→L3→L1 to deliver and persist).</text>
  <path d="M 585 175 L 690 90" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#t0arr)"/>
  <path d="M 690 95 L 725 90" stroke="#94a3b8" stroke-width="1" marker-end="url(#t0arr)"/>
  <path d="M 725 95 L 690 175" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#t0arr)"/>
  <path d="M 690 175 L 510 225" stroke="#94a3b8" stroke-width="1" marker-end="url(#t0arr)"/>
  <path d="M 650 225 L 685 305" stroke="#94a3b8" stroke-width="1" marker-end="url(#t0arr)"/>
  <path d="M 790 305 L 755 225" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#t0arr)"/>
  <path d="M 790 225 L 790 95" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#t0arr)"/>
</svg>
<span class="figure-caption">Figure T0.1 | The 17 trace steps mapped onto the four-layer runtime architecture. Down-arrows are the request descent; dashed up-arrows are the reply ascent.</span>

<details>
<summary>ASCII original</summary>

```
L1 Channels (WebChat)        ........... 03 04 ........ 16
L2 Gateway control plane     . 01 02 ... 05 ............
L3 Message orchestration     ........... 06 07 08 09 10 .... 15 . 17
L4 AI core (agent + LLM)     ........... 11 12 13 14 ............
                             time --------->
```

</details>

## State variables across the 17 steps

This is the map you should keep open in a second window while reading the steps. Each row is one step; each column is a state variable that lives some span of the trace. A `·` means unchanged from the row above. The earliest cell where a variable becomes meaningful is where it is born.

| Step | connectionId | MsgContext | sessionId / session | ReplyDispatcher | agent attempt | provider call | ReplyPayload | transcript events |
|------|--------------|-----------|---------------------|-----------------|---------------|--------------|--------------|-------------------|
| 01   | —            | —         | —                   | —               | —             | —            | —            | —                 |
| 02   | —            | —         | —                   | —               | —             | —            | —            | —                 |
| 03   | assigned     | —         | —                   | —               | —             | —            | —            | —                 |
| 04   | ·            | —         | —                   | —               | —             | —            | —            | —                 |
| 05   | ·            | —         | —                   | —               | —             | —            | —            | —                 |
| 06   | ·            | built     | sessionKey only     | —               | —             | —            | —            | —                 |
| 07   | ·            | ·         | ·                   | —               | —             | —            | —            | —                 |
| 08   | ·            | ·         | loaded (agent+model)| —               | —             | —            | —            | —                 |
| 09   | ·            | possibly mutated | ·             | —               | —             | —            | —            | —                 |
| 10   | ·            | ·         | ·                   | created         | —             | —            | —            | —                 |
| 11   | ·            | ·         | ·                   | ·               | 1 started     | —            | —            | —                 |
| 12   | ·            | ·         | ·                   | ·               | ·             | prepared     | —            | —                 |
| 13   | ·            | ·         | ·                   | ·               | ·             | open (streaming) | —        | —                 |
| 14   | ·            | ·         | ·                   | receiving events| ·             | ·            | growing      | growing           |
| 15   | ·            | ·         | ·                   | finalizing      | done          | closed       | finalized    | ·                 |
| 16   | broadcast    | ·         | ·                   | delivering      | ·             | ·            | sent         | ·                 |
| 17   | ·            | discarded | written back        | discarded       | ·             | ·            | discarded    | persisted         |

Read it horizontally to track one object's life: `ReplyDispatcher` is born in step 10, subscribes in 14, finalizes in 15, delivers in 16, discarded in 17 — a five-step lifespan covering the entire reply half of the trace. Read it vertically to see what holds state at any moment: at step 13 we are mid-flight, holding a `connectionId`, a `MsgContext`, a loaded `session`, an empty `ReplyDispatcher`, an in-progress agent attempt, an open provider stream, and nothing else.

The point of the table is not to memorize it. The point is that it is a cheap lookup whenever you lose the thread. If a step talks about a variable and you cannot place when it appeared, the table tells you. If you want to know what objects exist at the moment the model returns its first token, scan row 14. If you want to know the half-life of `MsgContext` (born step 6, discarded step 17 after the persistence write reads it), scan its column.

A subtle but important property of the table: the variables move in waves. Steps 01-05 are dominated by transport-layer state (connection, registry). Steps 06-09 introduce request-layer state (`MsgContext`, session). Steps 10-15 introduce reply-layer state (`ReplyDispatcher`, agent attempt, provider stream, payload). Step 17 collapses everything into a persisted transcript. These waves match the four-layer architecture from Chapter 01.

## How to read the trace

- Read the steps in order, 01 through 17. Each step opens by accepting whatever state the previous step ended on; reading out of order means filling state in by hand.
- Every step is self-contained: it does not rely on memory of step 03 by the time you reach step 13. The state table above is the bridge — keep it open in a second window.
- Sections 2, 4, and 5 of each step are the load-bearing trio. Sections 6 and 8 are auxiliary: section 6 is the index back into the source, section 8 is the self-check. If you are short on time, read 1-2-4-5-8 and skim 3, 6, 7.
- Section 7 of each step links back into the reference chapters. When something in section 7 looks more interesting than the main thread, follow the link — but come back, because the spine matters more than any one branch on the first read.
- The trace is **intentionally minimal**. No tool calls, no voice, no multi-channel, no retries. The reference chapters cover those once you have the spine. The deliberately-skipped branches are listed in the "chosen trace target" section above so there is no surprise about what you will *not* see.
- All `file:line` references in section 6 of every step are resolvable at the locked commit `a374c3a5bf` (tag `v2026.5.22`). If you are reading the source at a different commit, the line numbers will drift — the wiki is locked, not chasing main.

One last note on scope: the trace deliberately treats the WebChat surface and the model provider as black boxes at their outer edges. We do not trace how the WebChat JavaScript renders the input box or how Anthropic's servers actually generate tokens. The trace covers everything between the WebChat WebSocket frame leaving the browser and the WebChat WebSocket frame arriving back — the OpenClaw process is the universe of this trace.

Begin at [tour-01-cli-boot.md](./tour-01-cli-boot.md).
