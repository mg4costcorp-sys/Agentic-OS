/**
 * Cross-platform helpers — one place for every OS branch so the rest of the
 * codebase stays declarative. macOS remains first-class; Windows and Linux are
 * supported alongside it. Phase 1 uses toPosix()/whichCommand()/IS_WIN; the
 * appData() helpers are here for the Phase 2 scanner ports.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const IS_WIN = platform() === "win32";
export const IS_MACOS = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

const HOME = homedir();

/**
 * Normalize a filesystem path to forward-slash ("posix") separators so that
 * `.split("/")` and `.replace(dir + "/", "")` logic works identically on
 * Windows (where node's path.join yields "\") and on macOS/Linux. Pure string
 * rewrite — does not touch the disk.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * The shell builtin that resolves a command name to its path: `where` on
 * Windows, `which` elsewhere. Both print one match per line (Windows may emit
 * several), so callers should take the first line.
 */
export function whichCommand(): string {
  return IS_WIN ? "where" : "which";
}

/**
 * Windows %APPDATA% (Roaming app data — where Claude, Notion, JetBrains, etc.
 * keep per-user state). On macOS/Linux there is no exact equivalent; the
 * home-relative fallback keeps a stray call from throwing, but callers should
 * branch on IS_WIN before relying on this.
 */
export function appData(): string {
  return process.env.APPDATA || join(HOME, "AppData", "Roaming");
}

/** Windows %LOCALAPPDATA% (Local app data — where per-user app binaries live). */
export function localAppData(): string {
  return process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");
}

/**
 * Per-user application-support directory for a named app:
 *   macOS:   ~/Library/Application Support/<name>
 *   Windows: %APPDATA%\<name>            (Roaming)
 *   Linux:   ~/.config/<name>
 * Used to locate Claude (Cowork tasks), JetBrains, Notion, Obsidian, etc.
 */
export function appSupportDir(name: string): string {
  if (IS_WIN) return join(appData(), name);
  if (IS_MACOS) return join(HOME, "Library", "Application Support", name);
  return join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), name);
}

/**
 * Path to an executable inside a Python venv, accounting for layout:
 *   POSIX:   <root>/bin/<name>
 *   Windows: <root>\Scripts\<name>.exe
 */
export function venvBin(root: string, name: string): string {
  return IS_WIN ? join(root, "Scripts", `${name}.exe`) : join(root, "bin", name);
}
