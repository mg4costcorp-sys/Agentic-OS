# Claude-parity chat batch — spec (25 Jul 2026, overnight build)

Owner: this worktree (`~/claude-os-qol-preview`, branch `qol-preview`). Main app runs on :8083 from
`~/claude-operating-system` (branch `redesign-v3`) and **must not be disturbed** — two Kimi K3 website
builds are streaming through it all night. Develop and test on **:8098**. Merge happens later, by hand.

Jack's words, verbatim, for why this exists:
- "First priority for you is to fix the chat interface, it should function like Claude, there should
  never be a scenario where it stops working or anything like that."
- "Approve and deny card, that's great, just use the same UI that Claude uses."
- "THIS CAN NEVER HAPPEN, WE NEED TO FIX IT... if a model errors it should default back to like
  GPT 5.6 or maybe even Claude... we make a set of errors which if it happens it goes back to Claude
  and gives it a prompt and then we also change the model visible on the page."

Already shipped and live (do not rebuild): segment tagging + ephemeral working panel + collapse-to-pill,
pulsing harness bar with live elapsed/tokens/narration, send-while-working queue with the "queued —
hasn't interrupted the run" chip, autopilot continue, 60-min idle watchdog + 3h cap + detach-on-disconnect,
dynamic auto-compact at 72% of the model's context window, `/__openrouter_key` preflight + billing card,
per-session turn lock.

---

## 1. Real approve/deny cards, Claude Code's own UI  (headline item)

Today the pane runs `--dangerously-skip-permissions` (yolo) or silently gets a tool blocked. Neither is
Claude. Build the real thing.

**Server (`vite.config.ts`)**
- Add a minimal **MCP-over-HTTP endpoint** `/__mcp_approvals` (loopback + token gated, same as the chat
  endpoints). It needs only three methods: `initialize`, `tools/list`, `tools/call`. It exposes one tool,
  `permission_prompt`, matching Claude Code's permission-prompt-tool contract: it receives
  `{ tool_name, input, tool_use_id }` and must return content that is JSON-stringified
  `{"behavior":"allow","updatedInput":<input>}` or `{"behavior":"deny","message":"<why>"}`.
- `tools/call` does **not** answer immediately: it registers a pending decision keyed by `tool_use_id`,
  pushes a `permission` SSE event to the owning chat stream, and resolves when the browser POSTs to
  `/__permission_decision` `{ id, decision: "allow"|"deny"|"always", message? }`. Time out after 10
  minutes → deny with "no answer from the UI".
- Map the pending decision to the right chat stream by session id. Keep a `Map<sessionId, PendingSet>`.
- When the chat spawns `claude`, pass (unless yolo is explicitly on for that chat):
  `--permission-prompt-tool mcp__approvals__permission_prompt` and
  `--mcp-config '{"mcpServers":{"approvals":{"type":"http","url":"http://127.0.0.1:<port>/__mcp_approvals","headers":{"x-claude-os-token":"<token>"}}}}'`
  Verify the flag names against the installed CLI first (`claude --help`) and adapt if they differ —
  do not ship a flag the local binary rejects. If the CLI refuses the flags, fall back to the current
  behaviour and log a single clear `info` event saying approvals are unavailable, rather than breaking runs.
- "always" decisions persist per (chat, tool, first argv token) in memory for the life of the server, and
  auto-allow silently thereafter — mirroring Claude Code's "don't ask again" scope.

**Client (`src/components/home-command.tsx`, `src/styles.css`)**
Render the card to match Claude Code's terminal permission prompt closely enough to be recognisable:
- A bordered panel, tool name as the title in the tool-orange used for `⚙` lines
  (e.g. "Bash command", "Edit file", "Write file", "Fetch URL"), the CLI's own titling.
- The body shows what Claude Code shows: for Bash, the command in mono on its own line plus the
  description; for Edit/Write, the file path and a **rendered diff** (red/green gutter, monospace);
  for anything else, pretty-printed JSON of the input, truncated at ~40 lines with a "show all" toggle.
- Three actions, in Claude's order and wording:
  `1. Yes`  ·  `2. Yes, and don't ask again for <tool> commands in <dir>`  ·  `3. No, and tell Claude what
  to do differently (esc)`. Option 3 opens a one-line input whose text is sent as the deny `message`.
- Keyboard: `1`/`2`/`3`, Enter = option 1, Esc = option 3, while a card is focused.
- The harness bar switches to a distinct "⏸ waiting on you" state (no pulse, amber) while any card is
  pending, and the queue does not fire.
- A resolved card collapses to a one-line receipt (`✓ allowed Bash(ls …)` / `✗ denied`).

**Per-chat control**: replace the binary yolo switch with three modes in the pane header —
`Ask` (default, cards) · `Auto-accept edits` · `Yolo`. Persist per chat, same store as the model choice.

## 2. Automatic model failover — "this can never happen again"

**Server.** Watch the child's stderr + stream for this error set:
`Key limit exceeded`, `requires more credits`, `exceeded model token limit`, `Provider returned error`,
`ECONNREFUSED` to the router, OAuth `could not be refreshed`, codex `401`, HTTP 402/403 from OpenRouter,
and a child that exits non-zero having produced **no assistant text at all**.

On match, do not surface a dead end. Retry the same turn down a chain:
`configured model → z-ai/glm-5.2 → claude (Anthropic subscription lane) → gpt-5.6 via codex (last resort)`.
- Same session via `--resume <id>` for the first three (transcripts are lane-agnostic). Codex cannot
  resume a Claude transcript, so for that hop send a fresh context with a summary preamble.
- Inject the preamble: "You are taking over mid-conversation from <model>, which hit <error>. Continue
  the work seamlessly; do not restart or re-plan."
- Emit a `failover` SSE event `{from, to, reason}`.
- Max 3 hops per turn; never loop back to a model that already failed this turn.
- If every hop fails, emit a single clear error card with the real cause and a `↻ retry` affordance —
  never a silent stop.

**Client.** On `failover`: swap the model chip in the pane header to the new model (with the vendor logo),
drop an in-thread note `⚠ failed over kimi-k3 → glm-5.2 (key limit exceeded)`, and update the chat's
remembered model. The billing/error card still renders underneath so the cause stays visible.

## 3. Never-a-dead-end: resume + steering

- **Resume chip.** Any turn that ends in `[Tool use interrupted]`, an aborted stream, or a child killed by
  the watchdog renders `↻ resume this turn` under the last bubble. Clicking re-sends the user's last intent
  prefixed "You were interrupted mid-work — continue exactly where you left off, do not restart."
- **Mid-turn steering.** A second composer mode while a turn is streaming: `⇢ steer` sends the text to the
  running turn as a nudge instead of queueing it (implement as: abort-with-context then immediately resume
  the same session with "The user interjected mid-turn: <text>. Fold this in and continue."). The existing
  queue stays the default; steering is the explicit alternative, one keystroke away (`⌘⏎`).
- **Live session presence.** A chat whose child process is alive can never render as idle. Server tracks
  live pids per session and exposes `/__sessions_live`; the client polls it every 5s and shows a pulsing
  dot + `working — Xm` on every chat row in the sidebar, including chats that are not currently open, and
  reattaches the stream on click. If the browser reconnects to a live session, resume its SSE rather than
  showing a dead thread.

## 4. Opus 5 across the whole OS

Add `claude-opus-5` everywhere a model is named: the pane's model picker (Claude lane, top of list, marked
as the current flagship), `model-intel.json` (capabilities, context window, pricing, routing guidance —
match the existing schema for the other entries), any default/failover chains, the docs/README model table,
and the ctx-window map used by the dynamic auto-compact. Keep Opus 4.8 listed. Do not guess pricing — if a
number is not verifiable from the repo's existing data, mark it `null` and note it rather than inventing.

## 5. Router integrity preflight (found the hard way tonight)

`~/.claude-code-router/config.json` had **every** route (`default`, `background`, `think`, `longContext`,
`webSearch`) pinned to `z-ai/glm-5.2`. So a chat set to Kimi K3 was silently answered by GLM 5.2 for every
thinking request and every request past the 60k long-context threshold — two all-night website builds were
authored by a model the user never chose, and it looked like "the model lost the plot". It has been
repaired, but nothing detected it.

Build the detector: on chat start, when the model routes through ccr, read the router config and compare
every route to the selected model. Any mismatch → an `info` card in the thread:
`⚠ router will answer <category> with <other-model>, not <selected>` plus a one-click "pin all routes to
<selected>" that rewrites the config (backup first) and restarts ccr. Also surface the *actual* model from
each turn's `init`/usage payload as a small chip on the finished-turn pill, so the model that really answered
is always visible.

## Definition of done
- `bunx tsc --noEmit` clean (the pre-existing usage-panel error is allowed).
- Dev server on :8098 boots; a real chat runs end to end in Ask mode: a Bash tool raises a card, `1` allows,
  the turn completes, the pill shows the real model.
- Failover verified at least once by forcing an error (e.g. point a chat at a bogus model id and confirm it
  lands on the next hop with the chip swapped and the note in-thread).
- One commit per numbered section, messages in the repo's existing style. Do not merge to `redesign-v3`.
- Append anything you learn that future-you would want to know to `~/Desktop/k3-builds/_ops/HICCUPS.md`.
