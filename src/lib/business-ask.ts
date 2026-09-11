// business-ask — the Business page's composer, routed through the OS's own
// model lanes. Nothing new is wired: it reads the same catalogs the home chat
// reads (`/__hermes_models`, `/__claude_models`) and posts to the same two
// endpoints (`/__hermes_chat`, `/__claude_chat`), which already speak one SSE
// protocol (chunk / info / error / done) and already decide who pays for a
// turn (Hermes' configured default, ChatGPT/Codex OAuth, OpenRouter via ccr,
// or the Claude subscription). The page only adds the numbers as context.

export type AskBackend = "hermes" | "claude";

export interface AskModel {
  /** Stable key: "<backend>|<provider>|<name>". */
  key: string;
  /** What the picker shows, e.g. "Hermes · gpt-5.6" or "Codex · gpt-5.6". */
  label: string;
  backend: AskBackend;
  name: string;
  provider?: string;
}

export const ASK_MODEL_KEY = "claude-os.business.ask-model.v1";

const ENDPOINT: Record<AskBackend, string> = {
  hermes: "/__hermes_chat",
  claude: "/__claude_chat",
};

/** Human label for a catalog provider group. */
function laneLabel(backend: AskBackend, provider: string): string {
  const p = provider.toLowerCase();
  if (backend === "hermes") return "Hermes";
  if (p.includes("codex")) return "Codex";
  if (p.includes("openrouter")) return "OpenRouter";
  if (p.includes("claude")) return "Claude Code";
  return provider;
}

type Catalog = {
  default?: { name?: string; provider?: string } | null;
  catalog?: Array<{ provider?: string; models?: Array<{ name?: string }> }>;
};

async function readCatalog(url: string): Promise<Catalog | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as Catalog;
  } catch {
    return null;
  }
}

function fromCatalog(backend: AskBackend, data: Catalog | null): AskModel[] {
  if (!data) return [];
  const out: AskModel[] = [];
  for (const group of data.catalog ?? []) {
    const provider = String(group.provider ?? "");
    for (const m of group.models ?? []) {
      if (!m?.name) continue;
      const name = String(m.name);
      out.push({
        key: `${backend}|${provider}|${name}`,
        label: `${laneLabel(backend, provider)} · ${name}`,
        backend,
        name,
        provider: provider || undefined,
      });
    }
  }
  // The configured default leads, exactly as the home chat orders it.
  const dn = data.default?.name;
  const dp = data.default?.provider;
  const di = out.findIndex((o) => o.name === dn && (!dp || o.provider === dp));
  if (di > 0) out.unshift(...out.splice(di, 1));
  return out;
}

/**
 * Every model this machine can run a turn on, Hermes first (it is the lane
 * most operators set up first), then the Claude Code catalog. The remembered
 * pick, if it still exists, is moved to the front so the composer opens on it.
 */
export async function loadAskModels(): Promise<AskModel[]> {
  const [hermes, claude] = await Promise.all([
    readCatalog("/__hermes_models"),
    readCatalog("/__claude_models"),
  ]);
  const list = [...fromCatalog("hermes", hermes), ...fromCatalog("claude", claude)];
  // De-duplicate on key; keep first occurrence.
  const seen = new Set<string>();
  const unique = list.filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(ASK_MODEL_KEY);
  } catch {
    /* storage unavailable — open on the default */
  }
  const ri = remembered ? unique.findIndex((m) => m.key === remembered) : -1;
  if (ri > 0) unique.unshift(...unique.splice(ri, 1));
  return unique;
}

export function rememberAskModel(model: AskModel) {
  try {
    window.localStorage.setItem(ASK_MODEL_KEY, model.key);
  } catch {
    /* fine */
  }
}

/**
 * One turn on the chosen lane. Streams text through `onChunk` and resolves
 * with the full reply. Throws when the lane is unreachable so the caller can
 * fall back to the page's local answers.
 */
export async function askModel(
  model: AskModel,
  prompt: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const token = (await (await fetch("/__token")).json()).token as string;
  const body: Record<string, unknown> = { prompt, model: model.name };
  if (model.provider) body.provider = model.provider;
  if (model.backend === "claude") {
    // Read-only: plan mode lets the CLI read but never write or run tools
    // that need an approval card this page does not render.
    body.permissionMode = "plan";
    body.origin = "business";
    body.title = `Business: ${prompt.slice(-60)}`;
  }
  const r = await fetch(ENDPOINT[model.backend], {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`lane returned ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let sawError: string | null = null;
  let terminal = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      let name = "chunk";
      const dataLines: string[] = [];
      for (const line of evt.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      const data = dataLines.join("\n");
      if (name === "chunk") {
        text += text && !text.endsWith("\n") && !data.startsWith(" ") ? " " + data : data;
        onChunk(text);
      } else if (name === "error") {
        sawError = data || "the run failed";
        terminal = true;
      } else if (name === "done") terminal = true;
    }
  }
  if (sawError) throw new Error(sawError);
  if (!terminal && !text.trim()) throw new Error("the lane closed before answering");
  return text.trim();
}
