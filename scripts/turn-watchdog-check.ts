/**
 * Drives every bound in the turn watchdog without making a single provider
 * call. `bun scripts/turn-watchdog-check.ts`
 *
 * The bounds are the dangerous part of auto-continue: an unbounded version
 * spends the user's money forever. Testing them against live models would cost
 * money to prove a cap that only matters when things are already going wrong,
 * so the decision rules live in a pure module and are exercised here instead.
 * The live failure modes (kill the child, bad model id, user abort) are
 * verified against the running server separately — this file covers what that
 * cannot: the fifth resume, the spend ceiling, the loop that never happens
 * because it was stopped at two.
 */
import {
  AUTO_CONTINUE,
  decideAutoContinue,
  emptyOutcome,
  failureSignature,
  freshAutoContinueState,
  unfinishedReason,
  type AutoContinueState,
  type TurnOutcome,
} from "../src/lib/turn-watchdog";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const outcome = (o: Partial<TurnOutcome>): TurnOutcome => ({ ...emptyOutcome(), ...o });
const go = (s: AutoContinueState, o: TurnOutcome, aborted = false, laneExhausted = false) =>
  decideAutoContinue(s, o, { aborted, laneExhausted });

/** Six unrelated failures — a turn that trips over something new every time is
    a turn worth continuing, and only the hard cap should stop it. */
const DISTINCT = [
  "socket hang up while reading the response body",
  "the editor tool reported a merge conflict it could not resolve",
  "npm install exited before writing the lockfile",
  "the sub-agent returned an empty report",
  "the transcript file was rotated mid-write",
  "the approval card timed out waiting for the operator",
];

// A turn that got cut off mid-answer: text produced, no final result line.
const killedMidTurn = () =>
  outcome({ ok: true, sawAssistantText: true, textChars: 400, toolCalls: 3, reachedResult: false });

console.log("\n— what counts as unfinished —");
check(
  "killed with only the init line emitted is unfinished",
  unfinishedReason(outcome({ ok: true, sawInit: true, reachedResult: false })) !== null,
);
check(
  "killed during the thinking phase is unfinished",
  unfinishedReason(outcome({ ok: true, thinkChars: 3200, reachedResult: false })) !== null,
);
check("killed mid-turn is unfinished", unfinishedReason(killedMidTurn()) !== null);
check(
  "is_error result is unfinished",
  unfinishedReason(outcome({ reachedResult: true, resultIsError: true })) !== null,
);
check(
  "harness error text is unfinished",
  unfinishedReason(outcome({ reachedResult: true, harnessError: true, toolCalls: 1 })) !== null,
);
check(
  "flatline with the child gone is unfinished",
  unfinishedReason(outcome({ sawAssistantText: true, flatlined: true })) !== null,
);
check(
  "a clean finish is NOT unfinished",
  unfinishedReason(
    outcome({ ok: true, sawAssistantText: true, reachedResult: true, textChars: 900 }),
  ) === null,
);
check(
  "a lane that never spoke is NOT auto-continued (failover's job)",
  unfinishedReason(outcome({ ok: false, errorText: "ECONNREFUSED 127.0.0.1:3456" })) === null,
);

console.log("\n— the user's Stop always wins —");
check("aborted turn does not continue", go(freshAutoContinueState(), killedMidTurn(), true).go === false);
check(
  "exhausted failover chain does not continue",
  go(freshAutoContinueState(), killedMidTurn(), false, true).go === false,
);

console.log("\n— an interruption is never resumed —");
{
  // Codex 0.144.1 emits no terminal event when it is interrupted, so from the
  // stream an interrupted turn looks exactly like one that died mid-thought.
  // The process-level flag is the only thing that can tell them apart, and it
  // must win over every "this looks unfinished, resume it" rule below.
  const s = freshAutoContinueState();
  const d = go(s, outcome({ ...killedMidTurn(), interrupted: true, interruptedBy: "SIGKILL" }));
  check("interrupted turn does not resume", d.go === false && d.stopReason === "interrupted");
  check("and says what ended it", !d.go && /SIGKILL/.test(d.message), !d.go ? d.message : "");
  check("no resume was charged to the ledger", s.resumes === 0, `resumes=${s.resumes}`);
}
check(
  "an interruption is still classified unfinished (so it is reported, not hidden)",
  unfinishedReason(outcome({ ...killedMidTurn(), interrupted: true })) !== null,
);
check(
  "a turn our own idle watchdog killed is NOT an interruption, so it still recovers",
  go(freshAutoContinueState(), killedMidTurn()).go === true,
);

console.log("\n— resume cap —");
{
  // Every attempt fails differently, so only the hard cap can stop this.
  const s = freshAutoContinueState();
  let n = 0;
  for (let i = 0; i < 50; i += 1) {
    // Genuinely different failures — different WORDS, not the same sentence
    // with a different number in it. (A numbered variant of one message is the
    // same failure, and the signature is right to say so: that is what the
    // "signatures ignore ids and counts" check below is asserting.)
    const d = go(s, outcome({ ...killedMidTurn(), errorText: DISTINCT[i % DISTINCT.length] }));
    if (!d.go) {
      check(`stops at the cap with a plain message`, d.stopReason === "max-resumes", d.stopReason);
      check("the message says what was tried", /Tried 5 automatic resumes/.test(d.message), d.message);
      break;
    }
    n += 1;
  }
  check(`never exceeds ${AUTO_CONTINUE.MAX_RESUMES} resumes`, n === AUTO_CONTINUE.MAX_RESUMES, `got ${n}`);
}

console.log("\n— backoff grows —");
{
  const s = freshAutoContinueState();
  const delays: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const d = go(s, outcome({ ...killedMidTurn(), errorText: DISTINCT[i] }));
    if (d.go) delays.push(d.delayMs);
  }
  check(
    "each wait is longer than the last",
    delays.every((d, i) => i === 0 || d > delays[i - 1]),
    delays.join(","),
  );
}

console.log("\n— loop detection stops EARLY —");
{
  // The identical failure, every time. This is the shape that killed the
  // codex-sparring build, and it must not burn all five attempts.
  const s = freshAutoContinueState();
  const same = () =>
    outcome({
      ...killedMidTurn(),
      errorText: "API Error: 400 model not found (request id 8f2a91cc)",
    });
  let n = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = go(s, same());
    if (!d.go) {
      check("stops for same-failure", d.stopReason === "same-failure", d.stopReason);
      break;
    }
    n += 1;
  }
  check(`same failure stops at ${n} resumes, well under the cap`, n < AUTO_CONTINUE.MAX_RESUMES, `n=${n}`);
}
{
  // Request ids / byte counts differ every time; it is still the same failure.
  const a = outcome({ ...killedMidTurn(), errorText: "API Error: 400 (req 1a2b3c4d5e) after 1234 bytes" });
  const b = outcome({ ...killedMidTurn(), errorText: "API Error: 400 (req 99887766ff) after 9871 bytes" });
  check("signatures ignore ids and counts", failureSignature(a) === failureSignature(b));
}
{
  // No new text, no new tools — the resume achieved literally nothing.
  const s = freshAutoContinueState();
  const stuck = () =>
    outcome({ ok: true, reachedResult: true, resultIsError: true, toolCalls: 0, textChars: 0 });
  let n = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = go(s, stuck());
    if (!d.go) {
      check(
        "stops for no-progress or same-failure",
        d.stopReason === "no-progress" || d.stopReason === "same-failure",
        d.stopReason,
      );
      break;
    }
    n += 1;
  }
  check(`no-progress stops at ${n} resumes`, n <= 2, `n=${n}`);
}
{
  // The identical failing TOOL CALL repeating, with fresh text each time so
  // neither the progress nor the signature check would catch it.
  const s = freshAutoContinueState();
  let n = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = go(
      s,
      outcome({
        ok: true,
        sawAssistantText: true,
        textChars: 200 + i,
        toolCalls: 2,
        reachedResult: false,
        errorText: `unrelated wording ${i}`,
        lastFailedTool: "Bash: codex exec --json",
      }),
    );
    if (!d.go) {
      check("stops for tool-loop", d.stopReason === "tool-loop", d.stopReason);
      check("names the repeating call", /codex exec/.test(d.message), d.message);
      break;
    }
    n += 1;
  }
  check(`tool loop stops at ${n} resumes`, n <= 2, `n=${n}`);
}

console.log("\n— context overflow gets one try, not five —");
{
  const s = freshAutoContinueState();
  const over = (i: number) =>
    outcome({
      ...killedMidTurn(),
      errorText: `prompt is too long: ${200000 + i} tokens > 199999 maximum`,
    });
  let n = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = go(s, over(i));
    if (!d.go) {
      check(
        "stops on the second overflow",
        d.stopReason === "context-overflow" || d.stopReason === "same-failure",
        d.stopReason,
      );
      break;
    }
    n += 1;
  }
  check(`overflow stops at ${n} resumes`, n <= AUTO_CONTINUE.MAX_CONTEXT_OVERFLOW + 1, `n=${n}`);
}

console.log("\n— spend, token and time ceilings —");
{
  const s = freshAutoContinueState();
  s.addedUsd = AUTO_CONTINUE.MAX_ADDED_USD;
  const d = go(s, killedMidTurn());
  check("spend threshold stops it", d.go === false && d.stopReason === "spend-budget");
  check("and says the number", !d.go && /\$2\.00/.test(d.message), !d.go ? d.message : "");
  // It is a threshold, not a cap: it is read between resumes, so a resume that
  // is already running can pass it. Saying so is the difference between a
  // number that is honest and a number that is a lie the moment it overshoots.
  check(
    "and admits it is checked between resumes",
    !d.go && /between resumes/.test(d.message),
    !d.go ? d.message : "",
  );
}
{
  // The Codex lane reports no USD at all, so without this the ONLY bounds on it
  // were the resume count and the clock.
  const s = freshAutoContinueState();
  s.addedTokens = AUTO_CONTINUE.MAX_ADDED_TOKENS;
  const d = go(s, killedMidTurn());
  check("token ceiling stops the lane that reports no money", d.go === false && d.stopReason === "token-budget");
  check(
    "and says the number",
    !d.go && /2,000,000/.test(d.message),
    !d.go ? d.message : "",
  );
}
{
  const s = freshAutoContinueState();
  s.addedMs = AUTO_CONTINUE.MAX_ADDED_MS;
  const d = go(s, killedMidTurn());
  check("time threshold stops it", d.go === false && d.stopReason === "time-budget");
  // Same overshoot as the money one — read between resumes, so a resume that is
  // already running can pass it. Nothing checked between resumes may be called
  // a cap: a number named "cap" that cannot fire mid-flight is the habit this
  // whole file exists to stop.
  check(
    "and does not call itself a cap",
    !d.go && /threshold/.test(d.message) && !/\bcap\b/.test(d.message),
    !d.go ? d.message : "",
  );
}
{
  // The one number here that IS hard: no resume is granted past it, and the
  // spawn boundary in vite.config.ts refuses the child besides.
  const s = freshAutoContinueState();
  s.resumes = AUTO_CONTINUE.MAX_RESUMES;
  const d = go(s, killedMidTurn());
  check("the resume ceiling is absolute", d.go === false && d.stopReason === "max-resumes");
  check("and is not charged another resume", s.resumes === AUTO_CONTINUE.MAX_RESUMES);
}

console.log(failures === 0 ? "\nall watchdog bounds hold\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
