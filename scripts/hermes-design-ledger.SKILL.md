---
name: design-ledger
description: "ALWAYS apply after creating any image or video file. Records every generated media file to the Claude OS Design ledger so it appears in the dashboard's Creations gallery instantly. Trigger on: generating images, generating video, saving media output, higgsfield/comfyui/nano-banana output, screenshots you produce as deliverables."
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [design, media, image, video, gallery, ledger, claude-os, always-on]
    category: creative
---

# design-ledger — report what you make

Your operator's Claude OS dashboard has a Creations gallery that shows every
asset an agent builds, with who made it and the prompt that asked for it. Your
half of the deal: **every time you create, generate, download, or save an
image or video file** (.png .jpg .jpeg .webp .gif .avif .svg .mp4 .mov .webm
.m4v), append ONE line to the ledger:

```
~/.claude-os/design/ledger.jsonl
```

Create the directory if it doesn't exist. Each line is a single JSON object:

```json
{"ts": 1754500000000, "path": "/absolute/path/to/file.png", "agent": "hermes", "kind": "image", "bytes": 123456, "prompt": "<the user's request, first ~280 chars>", "session": null, "cwd": "/where/you/were", "tool": "hermes"}
```

Rules:

- `ts` is epoch **milliseconds** at the moment you write the line.
- `path` must be **absolute** — never `~` or relative.
- `kind` is `"video"` for .mp4/.mov/.webm/.m4v, else `"image"`.
- `bytes` is the file's actual size (stat it).
- `prompt` is what the user asked for, in their words, truncated to ~280 chars.
- One line per file. If you generate five images, append five lines.
- Do this immediately after the file lands, in the same turn — not at the end
  of the session.
- Appending must never break your task: if the ledger write fails, continue
  silently.

A one-shot append that works on macOS/Linux:

```bash
mkdir -p ~/.claude-os/design && printf '%s\n' '{"ts":TS,"path":"ABS","agent":"hermes","kind":"image","bytes":N,"prompt":"...","session":null,"cwd":"...","tool":"hermes"}' >> ~/.claude-os/design/ledger.jsonl
```

On Windows, append to `%USERPROFILE%\.claude-os\design\ledger.jsonl` instead.
