/**
 * model-lane — one answer to "who is paying for this turn", shared by the
 * browser and the dev server.
 *
 * WHY THIS EXISTS. The model picker captured a `provider` for every entry and
 * then threw it away: every routing and billing decision in the OS was made by
 * pattern-matching the model NAME (`/^gpt-/` → Codex, `name.includes("/")` →
 * OpenRouter, everything else → Anthropic). Two things follow from that, and
 * both cost the user money on 26 Jul 2026:
 *
 *   1. `gpt-5.6-sol` appears in the catalog TWICE — once under `openai-codex`
 *      (the user's ChatGPT OAuth, already paid for) and once under a metered
 *      vendor lane. Identical name, identical row in the list, wildly different
 *      bill. Name-matching cannot tell them apart, so the picker offered a
 *      coin-flip and the user lost it.
 *   2. Anything unrecognised fell through to "Anthropic". A chat running on the
 *      user's own Grok OAuth reported "Billed to: Claude subscription" and drew
 *      Claude Max plan bars under it.
 *
 * So: the provider is now the primary key and the name is only the fallback,
 * and an unknown lane says it is unknown instead of guessing Anthropic.
 *
 * Nothing here is a heuristic dressed as a fact. `laneFromProvider` returns a
 * lane only for providers whose payer we can actually name.
 */

/**
 * The three lanes `/__claude_chat` can actually SPAWN, plus "other" for a lane
 * this code cannot identify.
 *   sub   — Claude Code on the Anthropic subscription
 *   ccr   — Claude Code through claude-code-router → OpenRouter (metered)
 *   codex — the Codex CLI on the user's ChatGPT/Codex OAuth
 *   other — recognised as none of the above; no payer may be named
 */
export type Lane = "sub" | "ccr" | "codex" | "other";

/**
 * Providers billed against a subscription/OAuth the user already pays for, so a
 * turn on them produces no per-turn charge to report. Matched case-insensitively
 * against the catalog's provider label, which carries suffixes on the Claude
 * backend ("openai · via codex").
 */
const OAUTH_PROVIDER_MARKERS = ["codex", "oauth", "claude-code"];

/**
 * Providers billed per token against a key or credit balance. Listed explicitly
 * rather than inferred, because "not obviously OAuth" is exactly the reasoning
 * that produced the wrong payer in the first place.
 */
const METERED_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "googlegemini",
  "openrouter",
  "xai",
  "mistral",
  "groq",
  "cohere",
  "deepseek",
  "minimax",
  "nvidia",
  "sakana",
]);

/** Providers that run on the user's own machine — nothing is billed at all. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp"]);

const norm = (s?: string | null): string => (s ?? "").trim().toLowerCase();

/** Is this catalog group an OAuth / subscription lane (no per-turn charge)? */
export function isOauthProvider(provider?: string | null): boolean {
  const p = norm(provider);
  if (!p) return false;
  return OAUTH_PROVIDER_MARKERS.some((m) => p.includes(m));
}

/** Is this catalog group billed per token against a key or credit balance? */
export function isMeteredProvider(provider?: string | null): boolean {
  const p = norm(provider);
  if (!p) return false;
  if (isOauthProvider(p)) return false;
  if (LOCAL_PROVIDERS.has(p)) return false;
  // The Claude backend labels its ccr group "openrouter · via claude code".
  if (p.includes("openrouter")) return true;
  return METERED_PROVIDERS.has(p);
}

/** Runs locally — no account, no bill. */
export function isLocalProvider(provider?: string | null): boolean {
  return LOCAL_PROVIDERS.has(norm(provider));
}

/**
 * The lane a provider label names outright, or null when the provider is real
 * but is not one of the three lanes this server spawns (a Hermes-only vendor,
 * say). Null means "ask the name", NOT "assume Anthropic".
 */
export function laneFromProvider(provider?: string | null): Lane | null {
  const p = norm(provider);
  if (!p) return null;
  if (p.includes("codex")) return "codex";
  if (p.includes("openrouter")) return "ccr";
  if (p === "claude-code") return "sub";
  // A provider we recognise as somebody else's — do NOT fall through to the
  // name, or "gpt-5.6-sol on the metered openai provider" reads as the free
  // Codex lane, which is the exact mix-up this module exists to stop.
  if (METERED_PROVIDERS.has(p) || LOCAL_PROVIDERS.has(p) || isOauthProvider(p)) return "other";
  return null;
}

/**
 * Last-resort lane from the model id alone. Only used when no provider came
 * with the model (an older client, a failover target grafted on mid-turn, a
 * headless caller that posts a bare model name).
 */
export function laneFromName(name?: string | null): Lane {
  const n = (name ?? "").trim();
  if (!n) return "sub";
  if (/^gpt-/.test(n)) return "codex";
  if (n.includes("/")) return "ccr";
  if (/^(claude-|opus|sonnet|haiku|fable)/i.test(n)) return "sub";
  return "other";
}

/** Provider first, name second. The single lane answer for the whole OS. */
export function laneFor(name?: string | null, provider?: string | null): Lane {
  return laneFromProvider(provider) ?? laneFromName(name);
}

/**
 * "openai/gpt-5.6-sol" and "gpt-5.6-sol" are the SAME model reached two ways.
 * Used to spot the metered duplicate of something the user already has on a
 * subscription.
 */
export function modelIdentity(name?: string | null): string {
  return norm(name).split("/").pop() ?? "";
}

/**
 * Does this lane bill per turn? Subscription/OAuth lanes do not — showing them
 * "$0.0000" states a measurement that was never taken.
 */
export function laneBillsPerTurn(lane: Lane, provider?: string | null): boolean {
  if (lane === "ccr") return true;
  if (lane === "sub" || lane === "codex") return false;
  if (isOauthProvider(provider) || isLocalProvider(provider)) return false;
  return isMeteredProvider(provider);
}

/**
 * Exactly who pays, in words, or an admission that we don't know. Never guesses.
 */
export function payerLabel(lane: Lane, provider?: string | null): string {
  if (lane === "ccr") return "OpenRouter credit";
  if (lane === "codex") return "ChatGPT plan";
  if (lane === "sub") return "Claude subscription";
  if (isLocalProvider(provider)) return "runs locally — nothing billed";
  if (isOauthProvider(provider)) return `${provider} subscription`;
  if (isMeteredProvider(provider)) return `your ${provider} credentials (metered)`;
  return "unknown — this lane does not report a payer";
}

// ── Hiding the metered twin of a model the user already pays for ───────────
// `gpt-5.6-sol` ships in the catalog twice: once under an OAuth group the
// user's ChatGPT plan already covers, once under a metered vendor group.
// Identical id, identical row, wildly different bill — and the user was charged
// on OpenRouter for a model his subscription covers.
//
// The rule: when a model is reachable on a lane that is ALREADY PAID FOR, the
// metered twin is not shown. The rule that keeps it honest: it is only applied
// when the paid lane is POSITIVELY KNOWN to work. No health report → nothing is
// hidden, because hiding the only reachable copy of a model is a worse failure
// than showing two.

/** What the server can tell us about a paid lane, keyed by provider label. */
export interface LaneHealthReport {
  /** True only when the lane was checked AND found usable. */
  ok: boolean;
  /** Why it is unusable, in words, when `ok` is false. */
  reason?: string;
}
export type LaneHealth = Record<string, LaneHealthReport | undefined>;

/** Minimum shape the dedupe needs — the real catalog rows carry more. */
export interface LaneCatalogEntry {
  name: string;
  provider?: string;
}

/**
 * A metered entry that a paid lane makes redundant, and the lane that does it.
 * Attached to the entry rather than deleting it: the picker hides these behind
 * one line the user can expand, so nothing ever becomes unreachable.
 */
export interface SupersededMark {
  /** The paid provider that already covers this model. */
  supersededBy?: string;
}

const healthOf = (health: LaneHealth | null | undefined, provider?: string | null) =>
  health?.[norm(provider)];

/**
 * Mark every metered entry whose model is also available on a healthy paid
 * lane. Pure and total: returns a new array, same order, same length.
 *
 * `health` must positively report `ok: true` for the paid provider before
 * anything is marked. An unhealthy lane (expired OAuth, a 401) marks nothing,
 * so the metered twin reappears exactly when it is the only way through.
 */
export function markMeteredDuplicates<T extends LaneCatalogEntry>(
  options: readonly T[],
  health?: LaneHealth | null,
): Array<T & SupersededMark> {
  /** identity → the healthy paid provider that serves it. */
  const paid = new Map<string, string>();
  for (const o of options) {
    if (!isOauthProvider(o.provider)) continue;
    if (healthOf(health, o.provider)?.ok !== true) continue;
    const id = modelIdentity(o.name);
    if (id && !paid.has(id)) paid.set(id, o.provider ?? "");
  }
  if (!paid.size) return options.map((o) => ({ ...o }));
  return options.map((o) => {
    if (!isMeteredProvider(o.provider)) return { ...o };
    const by = paid.get(modelIdentity(o.name));
    return by ? { ...o, supersededBy: by } : { ...o };
  });
}

/**
 * The one quiet line the picker shows in place of what it hid. Says the count,
 * names the payer, and never implies the entries were deleted.
 */
export function supersededNote(count: number, provider: string): string {
  if (count < 1) return "";
  return `${count} metered ${count === 1 ? "copy" : "copies"} hidden — already covered by ${provider}`;
}

/**
 * The server-side lane label carried on ctx_usage / cost_unreported. Kept as
 * its own vocabulary because it is what the user reads in the usage panel, and
 * "anthropic" there means the Anthropic API specifically.
 */
export function usageLaneLabel(lane: Lane): "codex" | "openrouter" | "anthropic" | "other" {
  if (lane === "codex") return "codex";
  if (lane === "ccr") return "openrouter";
  if (lane === "sub") return "anthropic";
  return "other";
}
