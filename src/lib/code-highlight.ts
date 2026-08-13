/**
 * code-highlight — a tiny, dependency-free tokenizer for chat code blocks.
 *
 * Deliberately NOT a parser. It is a single left-to-right regex scan per
 * language that classifies comments, strings, numbers, keywords, types and
 * punctuation. That is enough to make a pasted config or snippet readable and
 * cheap enough to run on every render. An unknown language (or a pattern this
 * scanner doesn't understand) degrades to one plain token — never a crash and
 * never mangled text: concatenating every token's `text` always reproduces the
 * input byte for byte.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "prop"
  | "punct";

export interface CodeToken {
  kind: TokenKind;
  text: string;
}

/** Canonical language id for a fence tag, or null when we don't highlight it. */
export function normalizeLang(raw: string): string | null {
  const l = (raw || "").toLowerCase();
  if (!l) return null;
  if (["json", "json5", "jsonc"].includes(l)) return "json";
  if (["js", "jsx", "javascript", "ts", "tsx", "typescript", "mjs", "cjs"].includes(l)) return "js";
  if (["sh", "bash", "zsh", "shell", "console", "shellscript"].includes(l)) return "bash";
  if (["html", "xml", "svg", "vue"].includes(l)) return "html";
  if (["css", "scss", "less"].includes(l)) return "css";
  if (["py", "python"].includes(l)) return "python";
  if (["yml", "yaml"].includes(l)) return "yaml";
  return null;
}

const JS_KEYWORDS =
  "await|async|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|of|return|static|super|switch|this|throw|try|type|typeof|var|void|while|yield|as|satisfies";
const JS_LITERALS = "true|false|null|undefined|NaN|Infinity";
const PY_KEYWORDS =
  "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield";
const PY_LITERALS = "True|False|None|self|cls";
const BASH_KEYWORDS =
  "if|then|elif|else|fi|for|while|until|do|done|case|esac|function|return|export|local|source|set|unset";

// Each language is one ordered alternation. Order inside the array IS the
// precedence — comments before strings before everything else.
const RULES: Record<string, Array<[TokenKind, string]>> = {
  json: [
    ["string", `"(?:[^"\\\\]|\\\\.)*"\\s*(?=:)`], // key
    ["string", `"(?:[^"\\\\]|\\\\.)*"`],
    ["keyword", `\\b(?:true|false|null)\\b`],
    ["number", `-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b`],
    ["punct", `[{}\\[\\],:]`],
  ],
  js: [
    ["comment", `//[^\\n]*|/\\*[\\s\\S]*?\\*/`],
    ["string", `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\``],
    ["keyword", `\\b(?:${JS_KEYWORDS})\\b`],
    ["type", `\\b(?:${JS_LITERALS})\\b`],
    ["number", `\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?\\b`],
    ["prop", `\\b[A-Za-z_$][\\w$]*(?=\\s*\\()`],
    ["punct", `[{}()\\[\\];,.:?!<>=+\\-*/%&|^~]`],
  ],
  python: [
    ["comment", `#[^\\n]*`],
    ["string", `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`],
    ["keyword", `\\b(?:${PY_KEYWORDS})\\b`],
    ["type", `\\b(?:${PY_LITERALS})\\b`],
    ["number", `\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b`],
    ["prop", `\\b[A-Za-z_][\\w]*(?=\\s*\\()`],
    ["punct", `[{}()\\[\\];,.:?=+\\-*/%<>!&|^~]`],
  ],
  bash: [
    ["comment", `#[^\\n]*`],
    ["string", `"(?:[^"\\\\]|\\\\.)*"|'[^']*'`],
    ["type", `\\$\\{[^}]*\\}|\\$[A-Za-z_][\\w]*|\\$\\d`],
    ["keyword", `(?:^|(?<=[\\s;|&]))(?:${BASH_KEYWORDS})(?=[\\s;|&]|$)`],
    ["prop", `(?:^|(?<=[\\n;|&]\\s*))\\s*[A-Za-z_][\\w.-]*(?=\\s)`],
    ["number", `\\b\\d+\\b`],
    ["punct", `[|&;()<>{}\\[\\]$]`],
  ],
  html: [
    ["comment", `<!--[\\s\\S]*?-->`],
    ["string", `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`],
    ["keyword", `<\\/?[A-Za-z][\\w:-]*|\\/?>`],
    ["prop", `\\b[A-Za-z-][\\w:-]*(?==)`],
    ["punct", `[=]`],
  ],
  css: [
    ["comment", `/\\*[\\s\\S]*?\\*/`],
    ["string", `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`],
    ["prop", `[-a-zA-Z]+(?=\\s*:)`],
    ["type", `[.#][-\\w]+|@[-\\w]+|::?[-\\w]+`],
    ["number", `-?\\b\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\\b|#[0-9a-fA-F]{3,8}\\b`],
    ["punct", `[{}();:,>~+]`],
  ],
  yaml: [
    ["comment", `#[^\\n]*`],
    ["string", `"(?:[^"\\\\]|\\\\.)*"|'[^']*'`],
    ["prop", `^[ \\t]*[-\\w.]+(?=\\s*:)`],
    ["type", `\\b(?:true|false|null|yes|no)\\b`],
    ["number", `\\b-?\\d+(?:\\.\\d+)?\\b`],
    ["punct", `[:\\-|>{}\\[\\],]`],
  ],
};

// One compiled scanner per language, built lazily and cached.
const scanners = new Map<string, { re: RegExp; kinds: TokenKind[] } | null>();
function scannerFor(lang: string) {
  if (scanners.has(lang)) return scanners.get(lang)!;
  const rules = RULES[lang];
  if (!rules) {
    scanners.set(lang, null);
    return null;
  }
  let built: { re: RegExp; kinds: TokenKind[] } | null = null;
  try {
    // Lookbehind (used by the bash rules) is unsupported on some older
    // engines — if the pattern won't compile, this language just renders
    // plain rather than throwing inside a render pass.
    built = {
      re: new RegExp(rules.map(([, src]) => `(${src})`).join("|"), "gm"),
      kinds: rules.map(([k]) => k),
    };
  } catch {
    built = null;
  }
  scanners.set(lang, built);
  return built;
}

/**
 * Above this size a block renders unhighlighted rather than being scanned.
 *
 * The lazy comment rules — `/\*[\s\S]*?\*\/` (css/js) and `<!--[\s\S]*?-->`
 * (html) — are LINEAR per start position but there is one start position per
 * character, so an UNTERMINATED comment marker makes the scan quadratic. The
 * `guard` below does not catch it: guard counts successful matches, and this
 * input produces none, because `/` and `*` are not in the css/html `punct`
 * classes. Measured on this machine with a `css` fence of `/*a` repeated:
 *   25KB → 26ms · 50KB → 104ms · 100KB → 410ms · 200KB → 1.7s · 500KB → 10.3s
 * — ten seconds of frozen main thread from one pasted code fence, in a pane
 * that also renders model output nobody typed.
 *
 * 32K characters is ~1,000 lines, past any code block a chat can usefully
 * show, and bounds the adversarial worst case at ~80ms (measured) — a single
 * frame's hitch on a payload nobody sends by accident, and it is memoised per
 * block, so it happens once.
 */
export const MAX_HIGHLIGHT_CHARS = 32_000;

/**
 * Split `code` into tokens. Concatenating the result always reproduces `code`.
 * Unknown/unsupported languages return a single plain token.
 */
export function tokenizeCode(code: string, langRaw: string): CodeToken[] {
  const lang = normalizeLang(langRaw);
  const scanner = lang ? scannerFor(lang) : null;
  if (!scanner || !code || code.length > MAX_HIGHLIGHT_CHARS)
    return [{ kind: "plain", text: code }];
  const out: CodeToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  scanner.re.lastIndex = 0;
  let guard = 0;
  while ((m = scanner.re.exec(code))) {
    // A zero-length match would spin forever — bail to plain text.
    if (m[0].length === 0) {
      scanner.re.lastIndex++;
      continue;
    }
    if (++guard > 20_000) break;
    if (m.index > last) out.push({ kind: "plain", text: code.slice(last, m.index) });
    let kind: TokenKind = "plain";
    for (let g = 1; g < m.length; g++)
      if (m[g] !== undefined) {
        kind = scanner.kinds[g - 1];
        break;
      }
    out.push({ kind, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push({ kind: "plain", text: code.slice(last) });
  return out;
}
