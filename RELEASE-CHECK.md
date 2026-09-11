# Community release checks

Prepared 10 September 2026. This package includes Agentic OS with Website OS in its sidebar and the portable Website OS skill.

## Verified locally

A fresh frozen-lockfile Bun install, TypeScript check and production build passed on macOS. The editor runtime passed 17 source persistence and validation tests; media drafts passed 6 boundary and job idempotency tests. The skill manifest validates.

Eleven HTTP connection checks passed, covering a real local HTML page, blocked public and file URLs, rejected self-connection, external redirects, non-HTML responses, embedding restrictions, foreign origins, cross-site requests, content type and unreachable servers.

Browser checks verified the empty connection screen, actual local page rendering, desktop 1440 × 900, tablet 768 × 1024, mobile 390 × 844, full screen and return, model disclosure, and the unsent agent setup draft. A separate anonymous source editor was connected inside the OS: a headline was previewed, saved to the real source file, then restored with Undo.

No paid generation was submitted during this release audit. Generation command wiring and model names were inspected. Media uploads/regeneration require ffmpeg and ffprobe plus a working OpenArt CLI/account for generation. They use the recipient's own credits.

## Privacy and distribution

The package excludes the original personal website, its media and generated videos, account credentials, environment secrets, local conversations, private knowledge graphs, generated live-data, Git history, dependencies, build output, caches and temporary test fixtures. Empty data seeds are supplied for first run. Personal Colour Lab footage and licensed Transition Lab demo packs were removed. The remaining raster artwork was visually inspected; media metadata was checked for personal attribution and GPS fields. Public creator/licence attribution remains.

## Compatibility limits

A localhost URL connects a preview. Real source editing requires the one-time agent integration described in README.md. This is a local development tool, not a hosted multi-user client CMS. Only HTTP localhost/loopback URLs are accepted. Sites that restrict embedding need their own development configuration adjusted.

Fresh install and browser checks were performed on macOS. Windows and Linux were not separately exercised; source-folder detection falls back to manual entry when unavailable. Provider accounts and model availability remain external dependencies.

The actual ZIP was extracted into a separate directory. Frozen-lockfile installation, type checking, production build and all 23 runtime/media tests passed there. Archive paths, symlinks and prohibited runtime files were checked; the extracted application started locally. See CLAUDE-REVIEW.md for the independent review and resolved findings.


## Version 3.5 packaging update

The dashboard changelog reports V3.5 and package metadata reports 3.5.0. This update changes release labels and documentation only. The release code and assets remain the previously reviewed community edition. The new archive is independently checked for integrity, private-data exclusions and matching extracted files.
