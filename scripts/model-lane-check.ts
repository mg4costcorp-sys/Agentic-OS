/**
 * Drives the lane/billing rules without a browser or a provider call.
 * `bun scripts/model-lane-check.ts`
 *
 * Same reasoning as turn-watchdog-check.ts: the branches here decide WHOSE
 * MONEY a turn spends, and the only way to be sure a rule holds is to run it
 * over the cases that cost real money on 26 Jul 2026 — `gpt-5.6-sol` listed
 * twice with the same id and two different bills, and an unrecognised lane
 * reporting "Claude subscription" under a chat Anthropic was not paying for.
 *
 * The catalog rows below are copied from the real /__hermes_models and
 * /__claude_models responses in vite.config.ts.
 */
import {
  laneFor,
  markMeteredDuplicates,
  modelIdentity,
  payerLabel,
  supersededNote,
  type LaneHealth,
} from "../src/lib/model-lane";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The Hermes catalog, trimmed to the rows that collide. Order matters: the
    metered `openai` group really is first, which is why it was the default. */
const HERMES = [
  { name: "gpt-5.6-sol", provider: "openai" },
  { name: "gpt-5.5", provider: "openai" },
  { name: "claude-fable-5", provider: "anthropic" },
  { name: "openai/gpt-5.6-sol", provider: "openrouter" },
  { name: "z-ai/glm-5.2", provider: "openrouter" },
  { name: "gpt-5.6-sol", provider: "openai-codex" },
  { name: "gpt-5.5", provider: "openai-codex" },
  { name: "grok-4.5", provider: "xai" },
  { name: "grok-4.5", provider: "xai-oauth" },
  { name: "llama3.3", provider: "ollama" },
];

const CODEX_UP: LaneHealth = { "openai-codex": { ok: true }, "xai-oauth": { ok: true } };
const CODEX_DOWN: LaneHealth = {
  "openai-codex": { ok: false, reason: "not signed in — run `codex login`" },
  "xai-oauth": { ok: true },
};

const hiddenNames = (rows: Array<{ name: string; provider?: string; supersededBy?: string }>) =>
  rows.filter((r) => r.supersededBy).map((r) => `${r.provider}/${r.name}`);

console.log("\n— the lane comes from the provider, not the name —");
check("gpt-5.6-sol on the OAuth group is the codex lane", laneFor("gpt-5.6-sol", "openai-codex") === "codex");
check(
  "the SAME id on the metered vendor is NOT the codex lane",
  laneFor("gpt-5.6-sol", "openai") === "other",
  laneFor("gpt-5.6-sol", "openai"),
);
check("openrouter is the metered ccr lane", laneFor("openai/gpt-5.6-sol", "openrouter") === "ccr");
check(
  "no provider falls back to the name (headless callers, failover targets)",
  laneFor("gpt-5.6-sol", "") === "codex" && laneFor("vendor/model", "") === "ccr",
);
check("an unknown model claims no lane", laneFor("some-new-thing", "") === "other");

console.log("\n— a payer is named only when it is known —");
check("codex lane says ChatGPT plan", payerLabel("codex", "openai-codex") === "ChatGPT plan");
check("ccr lane says OpenRouter credit", payerLabel("ccr", "openrouter") === "OpenRouter credit");
check(
  "someone else's OAuth is NOT reported as the Claude subscription",
  !/Claude subscription/.test(payerLabel("other", "xai-oauth")),
  payerLabel("other", "xai-oauth"),
);
check(
  "a local model says nothing is billed",
  /nothing billed/.test(payerLabel("other", "ollama")),
  payerLabel("other", "ollama"),
);
check(
  "an unrecognised lane admits it does not know",
  /unknown/.test(payerLabel("other", "")),
  payerLabel("other", ""),
);

console.log("\n— the metered duplicate is hidden while the paid lane is up —");
{
  const rows = markMeteredDuplicates(HERMES, CODEX_UP);
  const hidden = hiddenNames(rows);
  check(
    "the metered gpt-5.6-sol is hidden",
    hidden.includes("openai/gpt-5.6-sol"),
    hidden.join(", "),
  );
  check(
    "so is the OpenRouter-prefixed copy of the same model",
    hidden.includes("openrouter/openai/gpt-5.6-sol"),
    hidden.join(", "),
  );
  check("gpt-5.5 too", hidden.includes("openai/gpt-5.5"), hidden.join(", "));
  check("and the xAI metered twin of the OAuth grok", hidden.includes("xai/grok-4.5"), hidden.join(", "));
  check(
    "the OAuth entries themselves are never hidden",
    !hidden.some((h) => h.startsWith("openai-codex/") || h.startsWith("xai-oauth/")),
    hidden.join(", "),
  );
  check(
    "a model with no paid twin is untouched",
    !hidden.includes("openrouter/z-ai/glm-5.2") && !hidden.includes("anthropic/claude-fable-5"),
    hidden.join(", "),
  );
  check("a local model is never called a metered duplicate", !hidden.includes("ollama/llama3.3"));
  check("nothing is dropped from the list", rows.length === HERMES.length, `${rows.length}`);
}

console.log("\n— …and comes back the moment that lane cannot be used —");
{
  const rows = markMeteredDuplicates(HERMES, CODEX_DOWN);
  const hidden = hiddenNames(rows);
  check(
    "an unhealthy codex lane hides nothing of its own",
    !hidden.some((h) => h.includes("gpt-5")),
    hidden.join(", "),
  );
  check(
    "a different lane that IS healthy still de-duplicates",
    hidden.includes("xai/grok-4.5"),
    hidden.join(", "),
  );
}
{
  // An older server, or one that could not check: no report at all.
  const hidden = hiddenNames(markMeteredDuplicates(HERMES, undefined));
  check("no health report hides nothing at all", hidden.length === 0, hidden.join(", "));
}
{
  const hidden = hiddenNames(markMeteredDuplicates(HERMES, { "openai-codex": { ok: false } }));
  check("an explicit not-ok hides nothing", hidden.length === 0, hidden.join(", "));
}

console.log("\n— the claude backend's own duplicate —");
{
  const CLAUDE = [
    { name: "claude-opus-5", provider: "claude-code" },
    { name: "claude-fable-5", provider: "claude-code" },
    { name: "anthropic/claude-fable-5", provider: "openrouter · via claude code" },
    { name: "moonshotai/kimi-k3", provider: "openrouter · via claude code" },
    { name: "gpt-5.6-sol", provider: "openai · via codex" },
  ];
  const hidden = hiddenNames(
    markMeteredDuplicates(CLAUDE, {
      "claude-code": { ok: true },
      "openai · via codex": { ok: true },
    }),
  );
  check(
    "Fable through OpenRouter is hidden while the subscription covers it",
    hidden.includes("openrouter · via claude code/anthropic/claude-fable-5"),
    hidden.join(", "),
  );
  check(
    "a model the subscription does NOT cover stays listed",
    !hidden.includes("openrouter · via claude code/moonshotai/kimi-k3"),
    hidden.join(", "),
  );
}

console.log("\n— the line that explains the absence —");
{
  const note = supersededNote(3, "openai-codex");
  check("says the count", /3/.test(note), note);
  check("names the payer", /openai-codex/.test(note), note);
  check("says hidden, never removed", /hidden/.test(note) && !/removed|deleted/.test(note), note);
  check("nothing hidden means nothing said", supersededNote(0, "openai-codex") === "");
}

console.log("\n— identity —");
check("a vendor prefix is not a different model", modelIdentity("openai/gpt-5.6-sol") === "gpt-5.6-sol");
check("case and padding do not make a new model", modelIdentity("  GPT-5.6-Sol ") === "gpt-5.6-sol");

console.log(failures === 0 ? "\nall lane rules hold\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
