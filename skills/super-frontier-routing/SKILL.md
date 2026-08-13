---
name: super-frontier-routing
description: >-
  Use when deciding whether a task deserves a super-frontier model (Fable 5, or any top-tier premium
  model) instead of a cheaper lane — and whenever the user signals design/taste, architecture,
  strategy, prioritisation, "make it really good", "premium", "what's the angle?", or asks for a final
  ship-review on public / client / YouTube-facing work. Treats the super-frontier model as an EXECUTIVE
  brain, not the daily driver: cheap models compress context, the frontier model judges/designs/
  prioritises, Hermes executes. Decides call-once vs temporary /model switch vs pinned cron, mandates
  compression before any frontier call, and blocks the frontier model on raw scanning, formatting,
  log-reading, extraction, and uncompressed context. Confirms with the user before any Fable call
  (unless a configurable pre-approval threshold is set), quoting an estimated token count and dollar
  cost from hardwired pricing. Pairs with model-router for the full lane table.
version: 1.0.0
author: Jack Roberts
license: MIT
metadata:
  hermes:
    tags: [routing, model-selection, fable-5, super-frontier, cost-optimization, escalation, executive-model]
    related_skills: [model-router, dream, hermes-agent]
    reads: [../../src/data/model-intel.json]
---

# Super-Frontier Routing

> **Source of truth:** in the Claude OS repo, model facts (pricing, roster eligibility, benchmarks)
> and multi-model recipes live in `src/data/model-intel.json` — read its `models[]` for current
> prices instead of the hardwired figures below, and its `orchestration` block for the canonical
> planner/worker/verifier, draft→finish and fan-out-review recipes. The hardwired numbers in this
> skill are a fallback for standalone (non-repo) installs only.

**The job:** know exactly when to hand the wheel to a super-frontier model — and when not to. A super-frontier model (Fable 5 today; whatever sits above Opus tomorrow) is the most capable model you can call and roughly the most expensive per token. Used everywhere, it burns money on work a $1.40 model nails. Used *only* at the decision points that need taste, judgment, or strategy, it makes the whole agent feel like it has a genius on retainer.

> Cheap models compress the mountain. The frontier model judges the mountain. Hermes executes the plan.

**The core rule (the cascade):**

```text
Cheap/workhorse gathers + compresses
Fable 5 judges / designs / prioritises
Hermes executes
Fable reviews only if high-stakes
```

This skill is the **escalation half** of routing. `model-router` owns the full lane table (local → grunt → workhorse → S-tier) and the DRAFT→FINISH / FUSE / MoA machinery. This skill owns one question in depth: **does this specific task deserve the super-frontier tier, and how do I invoke it without wasting it?**

---

## Overview

Hermes gives the frontier model *hands*: tools, memory, files, browser, desktop control, cron, and execution. The frontier model gives Hermes *taste*: design judgment, architecture, strategy, prioritisation, narrative, and final review. The mistake almost everyone makes is setting the expensive model as the permanent default and letting it read raw exhaust — inboxes, logs, whole conversations — at frontier prices.

**The frontier model should see decision-grade context, not raw exhaust.**

Canonical takeaway: **Don't make Fable your worker. Make it your executive.**

---

## When to Use

Escalate to the super-frontier tier when **any** of these are true:

- design / taste is central (the output must feel premium, coherent, branded, non-generic);
- initial architecture will shape many downstream tasks (get the skeleton right once);
- a wrong answer is expensive (public, client, money, reputation, irreversible);
- the user says "best", "premium", "make it really good", "strategy", "positioning", "what's the angle?", or tags `(max)`;
- multiple plausible paths exist and *choosing* is the hard part;
- the artifact is public / client / YouTube / brand-facing;
- a cheap model already produced something plausible but **generic**, and taste would lift it;
- the task should become a **reusable rule, prompt, skill, routing policy, or style guide** (codify once, reuse forever);
- final ship/no-ship review would materially change quality.

**Don't use for** (these route to workhorse/grunt/local — see `model-router`):

- raw inbox / calendar / doc / chat scanning;
- first-pass summarisation;
- log reading;
- simple or repetitive code edits;
- formatting, linting, regex, renames;
- extraction / classification;
- low-stakes replies and admin;
- mechanical tasks a cheap model can verify itself;
- **huge raw context that has not been compressed first**;
- **anything privacy-gated** — that routes LOCAL and overrides everything, frontier included.

---

## The one rule

**Compress first. Escalate on a real signal. Invoke the frontier model on a briefing, never on the raw mountain — and capture the judgment as a reusable rule so you only pay for it once.**

---

## Cost gate — ALWAYS confirm before Fable  (hard rule)

Fable 5 is metered and expensive. **Never fire a Fable call — one-shot OR `/model` switch — without explicit user confirmation first.** Auto-escalating to Fable silently is a bug, not a convenience.

Before any Fable call, STOP and post a one-line approval request:

> ⚠️ **Fable 5 check** — *&lt;which trigger&gt;*. Est. **~&lt;N&gt;k in / ~&lt;M&gt;k out ≈ $&lt;cost&gt;**. Proceed? (y/n)

- Name the **trigger** (Taste / Architecture / Strategy / Review / Codify).
- State the **estimated tokens** — the input you'll send (briefing size) + the expected output.
- State the **estimated cost**, computed from the hardwired pricing below.
- Wait for a yes. Re-confirm **each distinct** Fable call; never batch-approve a whole session, never auto-escalate silently.

### Hardwired pricing — `claude-fable-5`  (as of 2026-07 · update if Anthropic changes it)

| model | input | output | context |
|---|---|---|---|
| **Fable 5** | **$10 / M tokens** | **$50 / M tokens** | 1M in · 128K out |
| Opus 4.8 (ref) | $5 / M | $25 / M | — |

Fable = exactly **2× Opus 4.8**.

**Estimate formula:**

```text
cost ≈ (input_tokens ÷ 1,000,000 × $10) + (output_tokens ÷ 1,000,000 × $50)
```

Worked example — a 40k-token briefing in, a 4k-token verdict out:
`(0.040 × $10) + (0.004 × $50) = $0.40 + $0.20 = $0.60`. Show that line, get the yes, then call.

### Configurable — pre-approval (so the gate isn't nagware)

The gate reads two knobs; the default is **ask every time**:

- **`fable.auto_approve_under`** — a dollar ceiling. If the *estimate* is below it, Fable may proceed and just **log** the spend (`Fable auto-approved: $0.18 < $0.50 ceiling`) instead of asking. Default `$0.00` → always ask.
- **Session pre-approval** — the user can say *"pre-approve Fable up to $X this session"*; that raises the ceiling for the current session only, then reverts.

At or above the ceiling — or whenever it's unset — **STOP and ask**. Privacy-gated content is **never** auto-approved, whatever the ceiling.

---

## Think vs hands — how to invoke

Two invocation shapes. Pick by whether the frontier model needs to *act* or only *decide*.

| Invocation | Use when | How in Hermes |
|---|---|---|
| **Call-once** (best default) | The frontier model only needs to think/judge/design/review from a prepared brief. No tools. | One-shot OpenRouter/provider call, or `/moa`-style single pass. Fable reads the brief, returns the judgment, Hermes keeps executing on the workhorse. |
| **Temporary `/model` switch** | The frontier model must operate the tools itself for a short, bounded, high-stakes run (live demo, a gnarly build it must drive). | `hermes model` → switch to Fable for the session → **switch back** when the bounded run ends. |
| **Pinned cron / subtask** | Recurring strategic review (e.g. Dream) — only if upstream context is aggressively compressed first. | Cron job that feeds the frontier model a compressed briefing, never raw sources. |
| **Permanent core model** | Almost never. Too expensive for tool plumbing, scanning, routine execution, formatting. | Don't, unless the entire session is intentionally one short high-stakes Fable session. |

> **If the frontier model only needs to think, call it directly. If it needs hands, temporarily make it the Hermes agent for that bounded run — then hand the wheel back.**

---

## The five escalation triggers (mnemonic)

The only five reasons to spend a super-frontier token. If a task doesn't hit one, it isn't a frontier task.

```text
Taste → Architecture → Strategy → Review → Codify
```

1. **Taste** — the output must feel premium, visual, branded, coherent, non-generic.
2. **Architecture** — the initial structure will shape many downstream steps; decide it once, well.
3. **Strategy / Prioritisation** — the task is *what matters, what to ignore, where the leverage is.*
4. **Review** — final ship/no-ship judgment on a public, client, or high-stakes artifact.
5. **Codify** — turn the result into a reusable Hermes rule, prompt, skill, routing policy, or style guide.

---

## Compression mandate

Before any frontier call on large context, a cheap/workhorse model must turn raw sources into a **briefing** the frontier model can act on. This is non-negotiable — it is where most of the savings live.

```text
Raw sources → cheap per-source summaries → cheap merged briefing → frontier judgment → Hermes actions
```

Rules:

- The frontier model receives the briefing **only**, never the raw pile.
- Keep uncertainty visible; do not let the cheap pass invent facts to look tidy.
- If the briefing is genuinely insufficient, the frontier model should say *exactly what's missing* — not ask to inspect all raw sources by default.
- Target briefings ≤ ~2,000–2,500 words unless the source window is unusually complex.

---

## The three patterns this powers

Each maps to a video use case. Full copy-paste prompt pairs (cheap-compress → Fable-judge) live in `references/fable-5-executive-prompts.md`; framing/patterns notes in `references/fable-executive-routing.md`.

### 1. Build Anything
```text
User rough idea → cheap model interviews + scopes → Fable Input Pack →
Fable Architecture Pass → Hermes/workhorse implementation → optional Fable final review
```
Cheap model writes the mega-prompt (a compact architect brief). Fable designs. Hermes builds. Fable reviews only if it's high-stakes.

### 2. Dream
```text
Raw sources (email/calendar/docs/chats/sessions) → cheap source summaries →
cheap merged Dream Briefing → Fable strategic pass → Hermes action layer
```
Never let Fable roam raw sources ad hoc. Hermes compresses the day into one briefing; Fable decides priorities, risks, and the highest-leverage move; Hermes turns that into reminders, drafts, and tasks.

### 3. Routing Intelligence
```text
Hermes observes tasks/outcomes → cheap classifier labels type/stakes/context/privacy →
router picks local/cheap/workhorse/fable_once/fable_agent/multi_model →
Fable periodically reviews failures + high-stakes examples → Hermes updates the rules
```
This is the meta-pattern: Fable helps Hermes get better at knowing when to use Fable. Classifier fields and the Fable routing-review prompt are in the reference.

---

## Decision algorithm

```text
route_frontier(task):

  # 1. PRIVACY GATE — hard, overrides everything including frontier
  if task.is_sensitive or privacy == local_only:   -> LOCAL. stop.

  # 2. CHEAP FIRST — always attempt the cheapest capable lane
  lane = model_router.route(task)                   # usually GLM workhorse
  if not hits_any_of(TASTE, ARCH, STRATEGY, REVIEW, CODIFY):
      -> run on `lane`. done. (no frontier)

  # 3. COMPRESS — never send raw mountain to the frontier
  if context.is_large:
      brief = cheap_model.compress(context)         # briefing, not raw
  else:
      brief = task

  # 4. THINK vs HANDS
  if frontier_needs_tools:  -> temp /model switch to Fable (bounded), then switch back
  else:                     -> call-once Fable on `brief`

  # 5. CODIFY — if the judgment is reusable, save it as a rule/prompt/skill
  if result.is_reusable:    -> write it into a skill / routing policy / style guide

  return result
```

---

## Worked examples

| User says | Router does |
|---|---|
| "summarise these 40 emails" | cheap/workhorse. **Not** frontier — raw scanning. |
| "**(private)** read these client emails" | PRIVACY gate → local. Frontier never sees them. |
| "design the landing page, make it feel premium" | **Taste** → compress refs into a brief → **call-once Fable** architect pass → Hermes builds. |
| "should we go event-driven? big architectural call" | **Architecture + Strategy** → FUSE or call-once Fable on a compressed brief. |
| "run my morning Dream" | Cheap compresses the day → **call-once Fable** strategic pass → Hermes schedules actions. |
| "build this site with an embedded AI agent and ship it" | **Architecture** → Fable Input Pack → Fable architecture → Hermes builds + deploys (see `vercel-integration`) → optional Fable review. |
| "why did the router send that to the expensive model?" | **Codify** → Fable routing-policy review → update this skill's triggers. |

---

## Common Pitfalls

1. **Setting Fable as the permanent core model.** It becomes an expensive plumber. Keep Hermes on the workhorse; escalate per-task. Completion check: `hermes model` shows the workhorse (GLM-5.2) as default, not Fable.
2. **Sending raw context to Fable.** Every uncompressed inbox/log/transcript is money burned. Completion check: the frontier call's input is a briefing under ~2.5k words, not a raw dump.
3. **Escalating on vibes, not a trigger.** If you can't name which of Taste/Architecture/Strategy/Review/Codify applies, it isn't a frontier task. Completion check: the escalation logs which trigger fired.
4. **Paying for the same judgment twice.** If a Fable decision is reusable, it must be codified into a rule/skill/prompt. Completion check: recurring frontier judgments have a saved artifact.
5. **Forgetting to switch back after a temporary `/model` Fable run.** The session silently stays on the expensive model. Completion check: after a bounded Fable run, `hermes model` is back on the workhorse.
6. **Overclaiming.** This is rule-based escalation on models you already own — not a learned orchestrator. Say so honestly; don't sell it as magic.

---

## Verification Checklist

- [ ] The task was first attempted on the cheapest capable lane (privacy-gated → local).
- [ ] **Before any Fable call, the user was shown the trigger + estimated tokens + estimated $ and said yes.**
- [ ] Frontier escalation names an explicit trigger (Taste / Architecture / Strategy / Review / Codify).
- [ ] Any large context was compressed into a briefing before the frontier call.
- [ ] Invocation shape chosen correctly: call-once (think) vs temporary `/model` (hands).
- [ ] After a temporary Fable run, the core model was switched back to the workhorse.
- [ ] Reusable frontier judgments were codified into a skill / prompt / routing policy.
- [ ] No privacy-gated content was sent to any cloud frontier model.
