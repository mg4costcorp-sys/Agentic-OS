import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Plugin } from "vite";
const execute = promisify(execFile);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localWebsiteURL(input: unknown, ownPort?: string): URL {
  if (typeof input !== "string" || input.length > 2048) throw new Error("Enter a localhost URL.");
  const value = input.trim();
  const url = new URL(value.includes("://") ? value : `http://${value}`);
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password)
    throw new Error(
      "Use http://localhost:PORT or http://127.0.0.1:PORT without a username or password.",
    );
  if (ownPort && (url.port || "80") === ownPort)
    throw new Error("Enter your website's port, not the Agentic OS port.");
  url.hash = "";
  return url;
}

async function previewResponse(url: URL, ownPort: string) {
  let current = url;
  for (let n = 0; n < 4; n++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      current = localWebsiteURL(
        new URL(response.headers.get("location") || "", current).href,
        ownPort,
      );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Your website returned HTTP ${response.status}. Check its development server.`,
      );
    }
    if (!response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel();
      throw new Error("That address does not return a website. Use the page URL.");
    }
    const reader = response.body?.getReader();
    let bytes = 0,
      html = "";
    const decoder = new TextDecoder();
    try {
      while (reader && bytes < 200_000) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader?.cancel();
    }
    const title = html.match(/<title[^>]*>([^<]{1,180})<\/title>/i)?.[1]?.trim() || current.host;
    const blocked = Boolean(
      response.headers.get("x-frame-options") ||
      /frame-ancestors\s+(?!\*)/i.test(response.headers.get("content-security-policy") || ""),
    );
    return {
      url: current.href,
      title,
      embeddingWarning: blocked
        ? "This site restricts embedding. Open it in a tab or ask your agent to allow this OS origin in its local preview settings."
        : null,
    };
  }
  throw new Error("Too many redirects. Use the final localhost page address.");
}

async function projectFolder(port: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execute("lsof", ["-tiTCP:" + (port || "80"), "-sTCP:LISTEN"], {
      timeout: 2000,
      maxBuffer: 4096,
    });
    const ids = [
      ...new Set(
        stdout
          .trim()
          .split(/\s+/)
          .filter((id) => /^\d+$/.test(id)),
      ),
    ];
    if (ids.length !== 1) return null;
    const result = await execute("lsof", ["-a", "-p", ids[0], "-d", "cwd", "-Fn"], {
      timeout: 2000,
      maxBuffer: 8192,
    });
    const folder = result.stdout
      .split("\n")
      .find((line) => line.startsWith("n/"))
      ?.slice(1);
    if (
      !folder ||
      folder === os.homedir() ||
      folder === "/" ||
      /(?:^|\/)(?:\.claude|\.codex|\.ssh|\.aws)(?:\/|$)/.test(folder)
    )
      return null;
    if (
      existsSync(path.join(folder, "package.json")) ||
      existsSync(path.join(folder, "index.html")) ||
      existsSync(path.join(folder, "tools/serve.py"))
    )
      return folder;
  } catch {
    /* Connection works without process discovery. */
  }
  return null;
}

export function websiteOSPlugin(): Plugin {
  return {
    name: "agentic-website-os-community",
    configureServer(server) {
      server.middlewares.use("/__website-os/connect", async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        const host = req.headers.host || "";
        if (
          !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) ||
          (req.headers.origin && req.headers.origin !== `http://${host}`) ||
          (req.headers["sec-fetch-site"] &&
            !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))
        ) {
          res.statusCode = 403;
          res.end(JSON.stringify({ message: "Local requests only." }));
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ message: "Use POST." }));
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          res.statusCode = 415;
          res.end(JSON.stringify({ message: "JSON is required." }));
          return;
        }
        let raw = "",
          tooLarge = false;
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 4096 && !tooLarge) {
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ message: "Request too large." }));
            req.destroy();
          }
        });
        req.on("end", async () => {
          if (tooLarge) return;
          try {
            const data = JSON.parse(raw);
            const ownPort = new URL(`http://${host}`).port;
            const url = localWebsiteURL(data?.url, ownPort);
            const result = await previewResponse(url, ownPort);
            const finalURL = new URL(result.url);
            const folder = await projectFolder(finalURL.port);
            let editorURL: string | null = null;
            try {
              const probe = await fetch(new URL("/__wos/model", finalURL), {
                redirect: "manual",
                signal: AbortSignal.timeout(2000),
              });
              if (
                probe.ok &&
                probe.headers.get("x-website-os") === "1" &&
                probe.headers.get("content-type")?.includes("application/json")
              )
                editorURL = finalURL.origin;
              await probe.body?.cancel();
            } catch {
              /* A normal dev server does not expose a field editor. */
            }
            res.end(JSON.stringify({ ...result, folder, editorURL }));
          } catch (error) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                message:
                  error instanceof Error && error.name === "TimeoutError"
                    ? "That website took too long to respond. Check its development server and try again."
                    : error instanceof Error && error.message !== "fetch failed"
                    ? error.message
                    : "Could not reach that localhost. Start your website first, then reconnect.",
              }),
            );
          }
        });
      });
    },
  };
}
