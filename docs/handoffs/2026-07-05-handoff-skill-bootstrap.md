# Handoff — Le skill /handoff lui-même (bootstrap)

**Date:** 2026-07-05
**État:** Terminé et poussé. Rien en attente.
**Machine d'origine:** MacBook Air.

---

## Contexte

Suite de la session CRM-pour-Catherine (voir [`2026-07-05-crm-catherine.md`](2026-07-05-crm-catherine.md) — lis-le aussi, c'est le vrai sujet de fond). Matthieu a fait remarquer que son prompting d'hier soir était resté coincé sur le MacBook Air et qu'il voulait reprendre sur le Mac Studio — "comme tout est local, c'est un peu tannant." Il a demandé (1) un document complet à donner à Claude Code sur le Mac Studio, et (2) une automatisation pour que les sessions soient accessibles d'un ordi ou l'autre.

## Décisions prises

- Claude Code (ce client) ne synchronise pas l'historique de session entre machines — confirmé en interrogeant `list_sessions`/`search_session_transcripts` : tous les IDs sont préfixés `local_`, aucun signe de sync cross-device natif.
- `CLAUDE.md` du repo interdit explicitement de lire/écrire `~/.claude/` directement (sauf via l'agrégateur) — donc pas question de bricoler du rsync/Syncthing/iCloud sur le dossier de sessions brut. Trop fragile de toute façon (format interne, risque de corruption si les deux machines écrivent en même temps).
- Le repo Git est déjà cloné sur les deux machines (`scripts/bootstrap-mac-studio.sh` le fait). C'est donc le mécanisme de sync le plus sûr disponible : écrire des handoffs markdown dans `docs/handoffs/`, commit+push, `git pull` de l'autre côté.
- Pattern calqué sur celui déjà en place pour les skills `/dream` et `personas` dans `scripts/setup.ts` (fonction `copyDreamSkill`/`copyPersonasSkill` → même chose pour `copyHandoffSkill`).

## Architecture / code livré

- **`skills/handoff/SKILL.md`** — le skill lui-même (celui que tu es en train d'exécuter). Instructions : écrire un handoff structuré dans `docs/handoffs/{date}-{slug}.md`, commit, push, puis dire à l'opérateur exactement quoi taper sur l'autre machine.
- **`scripts/setup.ts`** — nouvelle fonction `copyHandoffSkill()` (calquée sur `copyPersonasSkill`, avec `force: true` pour rafraîchir à chaque run) + un step `"Install the /handoff skill"` dans `main()`, entre l'install de `personas` et le cron `/dream`. Donc `bun run scripts/setup.ts` (que `bootstrap-mac-studio.sh` appelle déjà) installe `/handoff` automatiquement — aucune étape manuelle requise sur le Mac Studio au-delà du `git pull`.
- Skill installé manuellement sur ce MacBook Air via `cp -r skills/handoff ~/.claude/skills/handoff` pour le rendre utilisable immédiatement dans cette session (sans attendre un `bun run setup` complet, qui relance aussi l'agrégateur et peut redemander l'accès au trousseau macOS).
- **`docs/handoffs/2026-07-05-crm-catherine.md`** — premier handoff réel, capture toute la proposition d'architecture CRM.

## État d'avancement

Tout est **commité et poussé** sur `origin/main` (commit `aa959c3`, mergé avec des changements distants non liés — upgrade dashboard v2.10.1 et fix du timeout cron Dream — sans conflit, dans `cd1ecca`).

## Prochaines étapes

1. Sur le Mac Studio : `cd ~/Agentic-OS && git pull`, puis soit relancer `bootstrap-mac-studio.sh` (il appelle `setup.ts`, qui installe `/handoff` au passage), soit juste `cp -r skills/handoff ~/.claude/skills/handoff` si tu veux l'avoir tout de suite sans relancer tout le setup.
2. Ouvrir Claude Code sur le Mac Studio et dire : `Lis docs/handoffs/2026-07-05-crm-catherine.md au complet et continue à partir de là.`
3. Reprendre le vrai sujet : comparer la proposition CRM avec d'autres outils IA, puis décider du repo séparé quand il sera temps de coder.

## Questions ouvertes

Aucune côté infrastructure du skill — il est fonctionnel de bout en bout (testé dans cette session même). Les questions ouvertes restent celles du fond de dossier CRM (domaine email pour Resend, paiement en ligne ou non, design visuel) — voir l'autre handoff.
