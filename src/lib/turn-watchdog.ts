/**
 * Turn watchdog — the rules that decide whether a chat turn that STOPPED was
 * actually FINISHED, and whether the server should quietly resume it.
 *
 * Why this is a module and not another closure inside `/__claude_chat`: every
 * branch here spends the user's money. An unbounded auto-retry is the single
 * most expensive bug this codebase could ship, and logic buried in an 800-line
 * request handler can only be tested by making real provider calls. Pure
 * functions + explicit state can be driven through every bound in milliseconds
 * (`scripts/turn-watchdog-check.ts`), which is the only way the caps are
 * anything more than a comment claiming they exist.
 *
 * The sibling machinery is FAILOVER (in vite.config.ts): that changes MODEL
 * when a lane is dead. This changes NOTHING — same session, same model — and
 * exists for the turn that died with the lane perfectly healthy: the child
 * process killed mid-sentence, the `result` line that came back `is_error`,
 * the harness printing "API Error: 400" into the assistant stream. Failover
 * runs first and this runs second, in one sequential loop, so they can both
 * fire on one turn without racing.
 */

/** What one attempt (= one child process) actually did. */
export interface TurnOutcome {
  /** The attempt exited without an error we could name. */
  ok: boolean;
  /** What we WOULD surface if this attempt were the last word. */
  errorText: string;
  /** Everything the child wrote to stderr (plus harness-error assistant text). */
  stderr: string;
  /** Did the model produce real reply text (harness errors don't count)? */
  sawAssistantText: boolean;
  /** The CLI printed its own final `result` / `turn.completed` line — i.e. the
      turn reached its own end rather than being cut off. */
  reachedResult: boolean;
  /** …and that final line carried `is_error: true`. */
  resultIsError: boolean;
  /** The assistant stream carried harness-error text (HARNESS_ERROR_TEXT). */
  harnessError: boolean;
  /** The stream went flat past the threshold AND the child process was gone.
      A live-but-quiet child is THINKING and never sets this. */
  flatlined: boolean;
  /** The CLI printed its `system/init` line — it launched, authenticated, and
      opened a session that exists on disk. That is the difference between a
      turn worth resuming and a lane that never came up at all. */
  sawInit: boolean;
  /** Progress signals for loop detection, counted per attempt. */
  toolCalls: number;
  textChars: number;
  /** Extended-thinking characters. Counts as "the turn had started" but NOT
      as progress: a model that thought and then died twice running has not
      moved, and resuming it again is the loop this file exists to stop. */
  thinkChars: number;
  /** "Bash:codex exec …" — the last tool call that came back an error. The
      identical value twice running is the shape that killed the codex build. */
  lastFailedTool: string;
  /**
   * The child was ENDED BY SOMETHING OUTSIDE THIS TURN — a signal it did not
   * ask for, an exit code that only a signal produces (143 = 128+15,
   * 130 = 128+2), a `pkill`, an OOM kill, the dev server restarting underneath
   * it. NOT the user's Stop (that is `aborted`) and NOT our own idle watchdog
   * (that is a detected hang, which a resume can genuinely fix).
   *
   * This exists because Codex CLI 0.144.1 emits NO terminal JSON event when it
   * is interrupted — `turn.completed` and `turn.failed` are its only terminals
   * — so an interrupted turn and a turn that died mid-thought are byte-for-byte
   * identical in the stream. Without a process-level signal the watchdog reads
   * the interruption as "unfinished" and BUYS RESUMES of a turn nobody asked to
   * continue.
   */
  interrupted: boolean;
  /** What ended it, in words, when `interrupted` is set (e.g. "SIGKILL"). */
  interruptedBy: string;
  /**
   * Prompt+completion tokens this attempt reported, on lanes that report tokens
   * but no money. See AUTO_CONTINUE.MAX_ADDED_TOKENS — this is what bounds
   * recovery on the Codex lane, where the USD threshold is structurally unable
   * to fire.
   */
  tokens: number;
}

export const emptyOutcome = (): TurnOutcome => ({
  ok: true,
  errorText: "",
  stderr: "",
  sawAssistantText: false,
  reachedResult: false,
  resultIsError: false,
  harnessError: false,
  flatlined: false,
  sawInit: false,
  toolCalls: 0,
  textChars: 0,
  thinkChars: 0,
  lastFailedTool: "",
  interrupted: false,
  interruptedBy: "",
  tokens: 0,
});

/**
 * The bounds. Every one of these exists because without it the loop could run
 * until the user's credit card noticed.
 *
 * MAX_RESUMES 5 — five is past every real recovery seen (a killed child needs
 *   one), and five failed attempts is already the signal that the problem is
 *   not transient.
 * MAX_ADDED_MS 30min — recovery is meant to be minutes, not a second workday.
 *   The turn as a whole is still capped at 4h by TURN_MAX_MS.
 * MAX_ADDED_USD 2 — a SOFT THRESHOLD, deliberately not called a cap, and the
 *   UI must not call it one either. Two structural reasons, both still true:
 *
 *   (a) It is checked BETWEEN resumes, never during one. A resume that is
 *       already running cannot be priced until it ends, so the threshold stops
 *       the NEXT one, not the current one. A measured run overshot to $3.00
 *       against $2.00 exactly this way. The stop message now states the figure
 *       it actually reached and says it is checked between resumes, rather than
 *       implying the number was enforced.
 *   (b) Codex's JSONL carries no USD field at all — only input/cached/output/
 *       reasoning token counts — so `addedUsd` stays 0 on that lane and this
 *       branch can never trip there.
 *
 *   (b) is now covered: MAX_ADDED_TOKENS bounds recovery with the number that
 *   lane DOES report. (a) is inherent to after-the-fact pricing and is
 *   disclosed rather than hidden.
 * MAX_ADDED_TOKENS 2,000,000 — the ceiling for lanes that report tokens instead
 *   of money (Codex). Measured, not estimated: it is the sum of the
 *   input/cached/output counts the CLI itself printed on each recovery attempt.
 *   Two million tokens of recovery is far past any real fix and well inside a
 *   single frontier context window's worth of thrash.
 *
 *   Both of those gaps are now closed, and NOT here — at the single spawn
 *   boundary in vite.config.ts, which is the only place every child passes
 *   through (initial attempt, session/flag retries, failover hops, resumes).
 *   That boundary enforces abort, the turn's 4h deadline and a hard ceiling on
 *   how many agent processes one turn may start; the failover hops that used to
 *   sit outside every count now pass it too, and a detached run no longer loses
 *   its deadline to the browser disconnecting.
 *
 *   What the boundary still cannot enforce is SPEND, and no amount of wording
 *   changes that: a child can only be priced once it has finished, so any money
 *   figure stops the NEXT child and never the current one. Hence "threshold"
 *   everywhere, and hence the overshoot being stated rather than hidden.
 * BACKOFF_MS — a provider that just 429'd/500'd wants a gap, and a gap also
 *   makes a runaway loop visibly slow instead of invisibly fast.
 */
export const AUTO_CONTINUE = {
  MAX_RESUMES: 5,
  MAX_ADDED_MS: 30 * 60_000,
  MAX_ADDED_USD: 2,
  MAX_ADDED_TOKENS: 2_000_000,
  BACKOFF_MS: [2_000, 5_000, 10_000, 20_000, 30_000],
  /** Consecutive resumes with no tool call and no text before we call it stuck. */
  MAX_NO_PROGRESS: 2,
  /** Consecutive resumes ending in the identical failure before we call it stuck. */
  MAX_SAME_FAILURE: 2,
  /** A context overflow gets exactly ONE resume. The CLI compacts between
      turns, so one resume is a real chance at a smaller window; a second is
      thrashing against a wall, and thrashing is what this file exists to
      prevent. */
  MAX_CONTEXT_OVERFLOW: 1,
} as const;

/** Errors that mean "the window is full", where a plain resume may or may not
    help depending on whether the CLI managed to compact between turns. */
const CONTEXT_OVERFLOW =
  /exceeded (the )?model('s)? (maximum |token )?(context |token )?limit|context length exceeded|prompt is too long|too many tokens|context window/i;

export const isContextOverflow = (text: string): boolean => CONTEXT_OVERFLOW.test(text);

/**
 * A stable fingerprint for "this failure again". Numbers are stripped because
 * the interesting repetition — the same 400 from the same provider — carries
 * different request ids, byte counts and timestamps every time, and comparing
 * raw text would call every repeat a brand-new failure and never stop.
 */
export function failureSignature(o: TurnOutcome): string {
  const raw = `${o.errorText}\n${o.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3)[0];
  if (!raw) {
    // No text at all: the SHAPE of the ending is still a signature — a child
    // killed three times running looks identical every time.
    return `shape:${o.ok ? 1 : 0}${o.reachedResult ? 1 : 0}${o.resultIsError ? 1 : 0}${
      o.flatlined ? 1 : 0
    }`;
  }
  return raw
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#") // ids, hashes, request uuids
    .replace(/\d+/g, "#")
    .slice(0, 160);
}

/**
 * Did this turn stop without finishing? Returns the reason in words the user
 * can read, or null when there is nothing to continue.
 *
 * The `started` gate matters: an attempt that produced NOTHING and errored is
 * a dead lane, which is failover's job, not this one. Resuming a lane that
 * never spoke just buys the same error again at 2/5/10/20/30-second intervals.
 */
export function unfinishedReason(o: TurnOutcome): string | null {
  // What "started" means, learned the hard way on 26 Jul by killing turns at
  // three different moments and watching which ones dead-ended:
  //   • killed mid-answer → text, resumed fine
  //   • killed inside a long thinking block → no text at all, and the pane
  //     said "No reply came back." Thinking is output.
  //   • killed a minute in with NOTHING emitted but the `init` line → also a
  //     dead end, and also perfectly resumable: init carries the session id,
  //     so the transcript exists on disk and `--resume` will find it.
  // The gate is really "did a session come up?", not "did it produce prose".
  // Lanes that are genuinely dead — no binary, router refused, auth rejected —
  // never get as far as init, so they still belong to failover, not here.
  const started =
    o.sawInit ||
    o.sawAssistantText ||
    o.toolCalls > 0 ||
    o.reachedResult ||
    o.thinkChars > 0;
  if (!started) return null;
  if (o.resultIsError) return "the harness ended the turn with an error";
  if (o.harnessError) return "the harness printed a provider error instead of an answer";
  if (o.flatlined) return "the agent process was gone and the stream had stopped";
  if (!o.reachedResult) return "the agent process exited before the turn finished";
  return null;
}

/** Mutable bookkeeping for one turn's recoveries. */
export interface AutoContinueState {
  resumes: number;
  addedMs: number;
  addedUsd: number;
  /** Tokens the recoveries added, on lanes that report tokens and not money. */
  addedTokens: number;
  noProgressStreak: number;
  sameFailureStreak: number;
  contextOverflows: number;
  lastSignature: string;
  lastFailedTool: string;
  /** Reasons in order, for the honest final message. */
  history: string[];
}

export const freshAutoContinueState = (): AutoContinueState => ({
  resumes: 0,
  addedMs: 0,
  addedUsd: 0,
  addedTokens: 0,
  noProgressStreak: 0,
  sameFailureStreak: 0,
  contextOverflows: 0,
  lastSignature: "",
  lastFailedTool: "",
  history: [],
});

export type AutoContinueDecision =
  | { go: true; attempt: number; max: number; reason: string; delayMs: number }
  | { go: false; stopReason: string; message: string };

export interface AutoContinueInput {
  /** The user pressed Stop, or the turn was cancelled. Never auto-continue. */
  aborted: boolean;
  /** Failover already spent the whole chain and everything failed — the
      problem is the lane, not the turn, and resuming re-buys the same error. */
  laneExhausted: boolean;
}

/**
 * The whole decision, in one place. Mutates `state` — it is this turn's
 * private ledger and every caller wants the update.
 */
export function decideAutoContinue(
  state: AutoContinueState,
  outcome: TurnOutcome,
  input: AutoContinueInput,
): AutoContinueDecision {
  // 1. Is there anything to continue at all?
  const reason = unfinishedReason(outcome);
  if (!reason) return { go: false, stopReason: "finished", message: "" };

  // 2. The user's own Stop is not a failure. Nothing below this line may
  //    override it — an agent that carries on after Stop is a worse bug than
  //    a turn that dead-ends.
  if (input.aborted) return { go: false, stopReason: "aborted", message: "" };

  // 2b. An INTERRUPTION is not an unfinished turn — it is a turn something
  //     outside the turn ended. Resuming it buys work the user may not want and
  //     cannot consent to, because nothing on screen said the turn was killed.
  //     Codex is the reason this is a process-level check and not a stream one:
  //     0.144.1 emits no terminal event on interruption, so an interrupted turn
  //     and a crashed one are identical in the JSONL. Say what happened.
  if (outcome.interrupted)
    return {
      go: false,
      stopReason: "interrupted",
      message: `⏹ this turn was interrupted${
        outcome.interruptedBy ? ` (${outcome.interruptedBy})` : ""
      } rather than finishing on its own — something outside the turn ended the agent process. Not resuming automatically: an interruption is indistinguishable from a crash from in here, and buying a resume for one you caused yourself is not a decision this should make for you. Everything above is kept — send again to carry on.`,
    };

  if (input.laneExhausted)
    return {
      go: false,
      stopReason: "lane-exhausted",
      message: "",
    };

  // 3. Progress and repetition, measured against the previous attempt.
  const signature = failureSignature(outcome);
  const madeProgress = outcome.toolCalls > 0 || outcome.textChars > 0;
  if (state.resumes > 0) {
    state.noProgressStreak = madeProgress ? 0 : state.noProgressStreak + 1;
    state.sameFailureStreak =
      signature && signature === state.lastSignature ? state.sameFailureStreak + 1 : 0;
  }
  const toolLoop =
    !!outcome.lastFailedTool &&
    outcome.lastFailedTool === state.lastFailedTool &&
    state.resumes > 0;
  state.lastSignature = signature;
  state.lastFailedTool = outcome.lastFailedTool;

  const tried = () =>
    `Tried ${state.resumes} automatic resume${state.resumes === 1 ? "" : "s"}${
      state.history.length ? ` (${[...new Set(state.history)].join("; ")})` : ""
    }.`;

  if (toolLoop)
    return {
      go: false,
      stopReason: "tool-loop",
      message: `⏹ stopped resuming: the same tool call (${outcome.lastFailedTool}) failed on consecutive attempts, so continuing would just repeat it. ${tried()} Anything above is kept — say what to do differently and it will carry on.`,
    };
  if (state.noProgressStreak >= AUTO_CONTINUE.MAX_NO_PROGRESS)
    return {
      go: false,
      stopReason: "no-progress",
      message: `⏹ stopped resuming: ${state.noProgressStreak} consecutive resumes produced no new output and no new tool calls. ${tried()} Send a message to steer it.`,
    };
  if (state.sameFailureStreak >= AUTO_CONTINUE.MAX_SAME_FAILURE)
    return {
      go: false,
      stopReason: "same-failure",
      message: `⏹ stopped resuming: the identical failure came back ${
        state.sameFailureStreak + 1
      } times running — ${reason}. ${tried()} That is a real problem to fix, not a blip to retry.`,
    };

  // 4. Context overflow is its own stop, because a resume that overflows again
  //    is guaranteed to overflow a third time.
  if (isContextOverflow(`${outcome.errorText}\n${outcome.stderr}`)) {
    state.contextOverflows += 1;
    if (state.contextOverflows > AUTO_CONTINUE.MAX_CONTEXT_OVERFLOW)
      return {
        go: false,
        stopReason: "context-overflow",
        message:
          "⏹ stopped resuming: the context window overflowed again after a resume, so the CLI's between-turn compaction isn't recovering it. Start a fresh chat (or /compact this one) rather than paying for the same overflow repeatedly.",
      };
  }

  // 5. The hard ceilings.
  if (state.resumes >= AUTO_CONTINUE.MAX_RESUMES)
    return {
      go: false,
      stopReason: "max-resumes",
      message: `⏹ stopped after ${AUTO_CONTINUE.MAX_RESUMES} automatic resumes — ${reason}. ${tried()} Everything above is kept; send again to carry on from here.`,
    };
  if (state.addedMs >= AUTO_CONTINUE.MAX_ADDED_MS)
    return {
      go: false,
      stopReason: "time-budget",
      // "threshold", not "cap", for the same reason as the spend one below: it
      // is read between resumes, so the resume already running can carry it
      // past the number. The turn as a whole IS hard-bounded — by its 4-hour
      // ceiling and by the process ceiling at the spawn boundary — and those
      // are the numbers that can actually fire mid-flight.
      message: `⏹ stopped resuming: automatic recovery has already added ${Math.round(
        state.addedMs / 60_000,
      )} minutes to this turn (threshold ${Math.round(
        AUTO_CONTINUE.MAX_ADDED_MS / 60_000,
      )}, checked between resumes). ${tried()} Send again to continue.`,
    };
  if (state.addedUsd >= AUTO_CONTINUE.MAX_ADDED_USD)
    return {
      go: false,
      stopReason: "spend-budget",
      // The overshoot is stated, not hidden. A resume can only be priced once
      // it has finished, so this threshold stops the NEXT one — it has never
      // been able to stop the one already running, and calling it a cap implied
      // otherwise while a run went $1 past it.
      message: `⏹ stopped resuming: automatic recovery has spent $${state.addedUsd.toFixed(
        2,
      )} on top of this turn, past the $${AUTO_CONTINUE.MAX_ADDED_USD.toFixed(
        2,
      )} threshold. That threshold is checked between resumes, so a resume already running can overshoot it — this one reached $${state.addedUsd.toFixed(
        2,
      )}. ${tried()} Send again to continue.`,
    };
  // The lane-appropriate ceiling. Codex reports tokens and no money at all, so
  // on that lane the USD branch above is structurally dead and this is the only
  // thing standing between a wedged turn and an unbounded loop.
  if (state.addedTokens >= AUTO_CONTINUE.MAX_ADDED_TOKENS)
    return {
      go: false,
      stopReason: "token-budget",
      message: `⏹ stopped resuming: automatic recovery has used ${state.addedTokens.toLocaleString()} tokens on top of this turn (threshold ${AUTO_CONTINUE.MAX_ADDED_TOKENS.toLocaleString()}). This lane reports tokens rather than dollars, so tokens are what bounds it. ${tried()} Send again to continue.`,
    };

  // 6. Go.
  state.resumes += 1;
  state.history.push(reason);
  const delayMs =
    AUTO_CONTINUE.BACKOFF_MS[Math.min(state.resumes - 1, AUTO_CONTINUE.BACKOFF_MS.length - 1)];
  return { go: true, attempt: state.resumes, max: AUTO_CONTINUE.MAX_RESUMES, reason, delayMs };
}

/**
 * What the resumed session is told. Short on purpose: it is prepended to a
 * transcript the model already has, and the failure modes it must not cause
 * are (a) restarting work already done and (b) retrying the step that just
 * failed forever, which is the thing loop detection is cleaning up after.
 */
export const continuationPrompt = (reason: string): string =>
  `[automatic continuation] The previous attempt at this turn stopped before it finished — ${reason}. You are resuming the SAME session on the SAME task. Do not restart, re-plan, or repeat work that the transcript shows is already done: pick up exactly where it stopped and finish. If a step failed and fails again, say so plainly and stop rather than retrying it a third time.`;
