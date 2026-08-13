# Chat-parity batch — report (25 Jul 2026, overnight)

Branch `qol-preview`, worktree `~/claude-os-qol-preview`. Nothing on `redesign-v3` or in
`~/claude-operating-system` was touched; `:8083` was still serving on 200 at the end of the run.
All development and testing ran on `:8098`, which is now stopped.

`bunx tsc --noEmit` is clean apart from the pre-existing
`src/components/usage-panel.tsx(135,7)` usage-panel error.

## Commits

| # | Hash | Section |
|---|------|---------|
| 0 | `dbe1a87` | (pre-existing uncommitted work) OpenRouter key preflight + billing card |
| 1 | `2c2426c` | Real approve/deny cards over an MCP permission-prompt server |
| 2 | `88f4274` | Automatic model failover |
| 3 | `15c2995` | Never-a-dead-end: resume, steering, live-run presence |
| 4 | `e41a9b4` | Opus 5 across the OS |
| 5 | `ebcbc20` | Router integrity preflight + real-model chip |

Commit 0 was work already in the tree when this batch started (the spec lists it as shipped). It was
committed on its own so the five numbered sections each land in a clean commit.

---

## 1. Approve/deny cards — `2c2426c`

**Flag verification first.** `claude --help` on 2.1.217 does **not** list `--permission-prompt-tool`.
The binary accepts it anyway: an unknown option aborts commander immediately
(`error: unknown option '--totally-bogus-flag'`), whereas `--permission-prompt-tool` and
`--mcp-config` both get as far as authenticating. So the flags ship, and `runAttempt` additionally
watches stderr for `unknown option '--(permission-prompt-tool|mcp-config)` and re-runs the turn
without approvals plus one `info` line, so a future CLI that drops them degrades instead of breaking.

**Server.** `/__mcp_approvals` is a Streamable-HTTP MCP server with `initialize`, `tools/list` and
`tools/call`, loopback + token gated, exposing one tool `permission_prompt`. `tools/call` registers a
pending decision keyed by `tool_use_id`, pushes a `permission` SSE event to the owning chat, and
resolves when the browser POSTs `/__permission_decision`. Ten-minute timeout → deny with
"No answer from the UI within 10 minutes." Pending decisions are keyed to a **client-minted chat id**
(header `x-claude-os-chat`) rather than the CLI session id, because the session id doesn't exist
until the first turn's `init` line. `"always"` grants persist per (chat, tool, first argv token) for
the life of the dev server.

**Client.** Card matches the CLI's prompt: tool-orange title using the CLI's own naming ("Bash
command", "Edit file"), mono command + description for Bash, a rendered red/green LCS diff for
Edit/Write, pretty-printed JSON capped at 40 lines with "show all" otherwise; the three options in
Claude's order and wording; `1`/`2`/`3`, Enter = 1, Esc = 3; option 3 opens a one-line input whose
text becomes the deny `message`. Resolved cards collapse to `✓ allowed Edit(…)` / `✗ denied`. The
harness bar switches to a steady amber `⏸ waiting on you` with the slide animation replaced by a
static bar. The pane header's read/full switch is now **Ask · auto-edits · yolo**, persisted with the
chat's model in `claude-os.claude-chats.v1` and restored on rail click.

**Verified.** Two ways.
1. A scripted MCP client (`approval_test.py` in the scratchpad) standing in for the CLI, against a
   real live turn: card delivered over SSE with scope `Bash:git`; allow returned
   `{"behavior":"allow","updatedInput":{"command":"git status"}}`; deny returned the user's message
   verbatim; `always` allowed and then auto-allowed the next `git diff` in **0 ms with no card
   raised**; `rm -rf` in the same chat still raised a card; 3 `permission_done` events fired.
2. In the browser on `:8098`: a real glm-5.2 turn, an `Edit` card raised into it, rendered with the
   diff and the three options, `1` pressed → the simulated CLI received the allow verdict and the
   card collapsed to `✓ allowed Edit(~/notes/example.md)`.

**Not verified: the real `claude` binary calling the endpoint.** Anthropic OAuth on this machine is
expired (`Failed to authenticate: OAuth session expired and could not be refreshed` — reproduced
directly in a clean shell, so it is not an env-inheritance problem). Every `claude`-lane run therefore
dies before MCP servers are started. The MCP hop is the only link in the chain not exercised against
the genuine client. **Run `claude login`, then send one Bash-using message in Ask mode to close this
out.**

## 2. Model failover — `88f4274`

The turn runner was refactored into an attempt-based loop (`runAttempt`), because both the approvals
fallback and failover need to re-run the same turn. Lane (codex / ccr / subscription) is re-derived
per attempt, so a failover can change lanes mid-turn.

Trigger set: `Key limit exceeded`, `requires more credits`, model/token-limit overflow,
`Provider returned error`, `ECONNREFUSED`/`ECONNRESET`, OAuth `could not be refreshed`, 401/403,
402/Payment Required, model-not-available, `API Error: <status>`, plus any non-zero exit that
produced no real assistant text. Chain: configured model → `z-ai/glm-5.2` → `claude-opus-5` → Codex.
Max 3 hops, never twice to the same model, `--resume` for the Claude-lane hops, fresh context plus a
takeover preamble for Codex. `failover {from,to,reason}` goes out as an SSE event; the client swaps
the header chip (grafting the model into the picker if the catalog doesn't list it), drops
`⚠ failed over X → Y (reason)` in-thread, and remembers the new model. A spent chain produces a
single error naming the last model and real cause, with `↻ retry` under the bubble.

**The bug this caught.** The first implementation used "the model produced assistant text" as the
success signal. A forced run against a bogus ccr model showed Claude Code emits provider failures
*as assistant text* — `API Error: 400 Error from provider(openrouter,…)` followed by a JS stack —
so the turn looked answered and **no failover happened**. Harness-shaped text is now routed to the
error corpus and does not count as a reply. This is precisely Jack's "THIS CAN NEVER HAPPEN" case and
it would have shipped silently broken.

**Verified.** A chat pointed at `bogusvendor/nonexistent-model-x`:
`failover {"from":"bogusvendor/nonexistent-model-x","to":"z-ai/glm-5.2","reason":"the model isn't
available on this account"}` → resumed the same session on GLM → replied → `done ok`.

**Codex hop caveat.** A bare `gpt-5.6` is rejected by this ChatGPT account
(`The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account`). The chain's last
entry therefore reads the id `codex` itself defaults to from `~/.codex/config.toml` (currently
`gpt-5.6-sol`) and falls back to `gpt-5.6` when that file has nothing usable. Codex auth itself works
— a direct `codex exec` returned a normal answer.

## 3. Resume, steering, live presence — `15c2995`

- **Live runs.** Every turn registers in a `liveRuns` map with a 4 000-event replay buffer and a
  subscriber set. `sendEvent` writes to the originating response, the buffer, and every subscriber.
- **`GET /__sessions_live`** lists `{chatId, sessionId, model, startedAt}`. The rail polls it every
  5 s and every row whose agent is alive — including chats nobody has open — shows a pulsing amber
  dot and `working — Xm`, on its own 30-second clock so the number keeps counting between polls.
- **`GET /__claude_attach?chatId=`** replays the buffer then streams the rest, in the identical SSE
  vocabulary, so the client pumps it through the same reader. Opening a chat whose child is alive
  re-joins it (`⇢ reattached to the run in progress`) instead of showing a dead transcript. The SSE
  consumption loop was extracted into `pumpStream` so send and attach are literally the same code.
- **`POST /__claude_abort`** stops the child. Steering (`⌘⏎` while a turn streams) queues
  "The user interjected mid-turn: … Fold this in and continue." and then aborts, so the interjection
  fires immediately rather than after the run; the bubble reads `⇢ steering — folding into the run`.
- **Resume chip.** Turns ending in `[Tool use interrupted]`, an abort, or a watchdog kill render
  `↻ resume this turn`, which re-sends the intent prefixed "You were interrupted mid-work — continue
  exactly where you left off, do not restart."
- A deliberate stop is never mistaken for a dead model: `liveRun.abortedByUser` suppresses failover,
  and exits 143/130 (both CLIs trap SIGTERM and exit themselves) are treated as the stop we sent.

**Verified.** `/__sessions_live` reported the run mid-turn; `/__claude_attach` replayed **35 events,
exactly matching the primary stream**, and closed on `done`; the registry cleared afterwards.
`/__claude_abort` stopped a long essay after 13 s and released the turn.

## 4. Opus 5 — `e41a9b4`

`claude-opus-5` heads the Claude lane in the served catalog (`/__claude_models`) and the offline
`CLAUDE_FALLBACK`, wears a `flagship` chip in the picker with the subtitle "Current flagship · the OS
default", has a 1M `CTX_RULES` entry for the dynamic auto-compact, and is already hop 3 of the
failover chain. Its `model-intel.json` entry ships **every price, speed, popularity and benchmark
field `null`** — nothing in the repo's data establishes them, and an invented number there would
quietly drive routing, cost estimates and the Champions strip. `docs/model-intelligence.md` explains
why. Opus 4.8 stays listed. Confirmed in the browser: opus-5 is top of the list, selected by default,
flagship chip visible, 1M ctx in the telemetry strip.

## 5. Router integrity — `ebcbc20`

A ccr-lane chat reads `~/.claude-code-router/config.json` before it sends and cards every route that
disagrees with the selected model, with a one-click "pin all routes to X" that writes a timestamped
backup first and then restarts ccr (the card says plainly that in-flight runs are interrupted).
`POST /__ccr_pin_routes` keeps each route's existing provider prefix and only rewrites the model.
Separately every turn emits `model_used` from the harness's `init` line and from `result.modelUsage`,
shown as a chip on the finished-turn pill.

**Refinement the live test forced.** A chat on glm-5.2 against a router pinned entirely to kimi-k3
reported `model_used: z-ai/glm-5.2` — the chat's explicit `ANTHROPIC_MODEL` selector *does* win for
ordinary turns. So `default` is checked but not warned about; the four routes ccr picks for itself
(`background`, `think`, `longContext`, `webSearch`) are the ones that escape the pin, and they are
exactly the ones that rewrote the overnight builds. Warning on `default` too would have made the card
fire on every ccr chat and trained the user to ignore it.

**Note on the current config:** all five routes are presently pinned to `moonshotai/kimi-k3` — the
same class of bug as 24 Jul, just a different model. Nothing was rewritten; the detector is read-only
until clicked.

---

## Not done / known gaps

1. **The real `claude` binary has never called `/__mcp_approvals`** — Anthropic OAuth is expired on
   this machine. See section 1. One `claude login` plus one Bash message closes it.
2. **`--permission-prompt-tool` is undocumented in 2.1.217's help.** It works today (verified by the
   argument-parsing probe) and there is a coded fallback, but it is an unsupported surface.
3. **Only the ccr lane was exercised end to end.** The subscription lane (OAuth) and the Codex lane
   inside the chat endpoint were not, for the same auth reasons; Codex was verified standalone.
4. **`prettier` is unhappy with `home-command.tsx`** — but it already was: 951 fixable errors on the
   base commit versus 1 091 now, on a 3 400-line file that has never been formatted. Running
   `--fix` would bury this batch's diff in whitespace, so it was left alone.
5. **The `default` ccr route is deliberately not warned about** (see section 5). If a future change
   stops passing `ANTHROPIC_MODEL` explicitly, that exemption becomes wrong.
6. **`liveRuns` is per-process.** A dev-server restart forgets in-flight runs; the children keep going
   headless but the rail stops reporting them.
