# Handoff — Configuration accès distant Mac Studio (Tailscale)

## Contexte

Matthieu veut pouvoir contrôler son Mac Studio à distance (lancer des tâches Claude Code, approuver les prompts de permission) depuis son MacBook Air, son iPad ou son iPhone, peu importe où il se trouve physiquement. Objectif : ne pas avoir à être assis devant le Mac Studio pour démarrer ou superviser une session Claude Code.

Un sujet connexe a aussi été discuté (synchroniser les skills `~/.claude/` entre le MacBook Air et le Mac Studio) mais **n'a pas encore été mis en œuvre** — c'est un projet séparé, à faire après celui-ci.

## Décisions prises

- **Solution retenue : Tailscale + Partage d'écran/SSH natifs de macOS**, plutôt que:
  - Le mode "auto-accept toutes les permissions" de Claude Code (`--dangerously-skip-permissions` ou équivalent) — rejeté car ça enlève le filet de sécurité peu importe d'où on pilote. Matthieu préfère rester la main qui clique "oui", juste à distance.
  - `RemoteTrigger` (routines cloud claude.ai) — rejeté car ça tourne sur les serveurs Anthropic, pas sur le Mac Studio ; pas d'accès aux fichiers/skills locaux, pas de prompts à approuver (tourne en autonome).
  - La skill `dispatching-parallel-agents` — écartée car ça sert à paralléliser des sous-tâches dans une même session locale, aucun rapport avec le contrôle à distance entre machines.
- **Anti-veille** : le Mac Studio doit rester allumé et joignable en tout temps. Décision : désactiver la mise en veille système (pas l'écran, juste le système) via `sudo pmset -a sleep 0 disksleep 0`, ou via Réglages système → Économiseur d'énergie.
  - Impact électricité jugé négligeable (~15-30$ CAD/an de plus).
  - Impact durée de vie jugé nul — le Mac Studio est conçu pour tourner 24/7 (pas de pièces mécaniques fragiles).
  - Risque résiduel : panne de courant ou redémarrage macOS (mise à jour) qui éteint la machine → activer aussi "Redémarrer automatiquement après une panne de courant" dans les options d'économie d'énergie.
- **iOS (iPad/iPhone)** : Tailscale seul ne suffit pas, il faut en plus une app cliente VNC (ex: Screens, RealVNC Viewer) ou SSH (ex: Termius, Blink) — iOS n'a rien de natif pour ça, contrairement à macOS qui a Screen Sharing et SSH intégrés.

## Architecture / code proposé

Plan en 2 phases :

**Phase A — MacBook Air (fait)**
1. Téléchargé `Tailscale.pkg` (18,8 Mo) via curl vers `~/Downloads/Tailscale.pkg` depuis `https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg`.
2. Matthieu a installé le .pkg manuellement (mot de passe admin requis, action que l'agent ne peut pas faire).
3. Connecté à Tailscale avec le compte `mg4costcorp@gmail.com` → tailnet créé, device "MacBook Air de Matthieu (2)" ajouté avec succès (confirmé par capture d'écran "Login successful").

**Phase B — Mac Studio (à faire, prochaine session)**
1. Télécharger et installer Tailscale sur le Mac Studio, se connecter avec **le même compte** `mg4costcorp@gmail.com` (essentiel — même tailnet).
2. Activer sur le Mac Studio : Réglages système → Général → Partage → cocher "Partage d'écran" ET "Connexion à distance" (SSH).
3. Appliquer l'anti-veille : `sudo pmset -a sleep 0 disksleep 0`.
4. Vérifier "Redémarrer automatiquement après une panne de courant" dans les options d'alimentation.
5. Tester la connexion depuis le MacBook Air : Finder → "Se connecter au serveur" → `vnc://<adresse-tailscale-du-mac-studio>` (l'adresse Tailscale se trouve dans l'app Tailscale ou sur `login.tailscale.com` → liste des devices).
6. Une fois validé sur Mac ↔ Mac, installer Tailscale + une app VNC/SSH sur iPad et iPhone pour le même accès.

## État d'avancement

- ✅ Tailscale installé et connecté sur le MacBook Air.
- ⬜ Tailscale pas encore installé sur le Mac Studio (Matthieu est en train de s'y rendre — "2e étage").
- ⬜ Screen Sharing / SSH pas encore activés sur le Mac Studio.
- ⬜ Anti-veille (`pmset`) pas encore appliqué sur le Mac Studio.
- ⬜ Rien testé encore de bout en bout (pas de connexion distante réussie).
- ⬜ iPad/iPhone : rien installé.
- ⬜ Sync des skills `~/.claude/` entre les deux machines : discuté mais pas commencé — projet séparé à reprendre après celui-ci.

## Prochaines étapes

1. Reprendre la session sur le Mac Studio, installer Tailscale, se connecter avec `mg4costcorp@gmail.com`.
2. Activer Partage d'écran + SSH dans Réglages système → Partage.
3. Appliquer la commande anti-veille.
4. Retourner sur le MacBook Air (ou demander à Matthieu de confirmer) pour tester la connexion à distance de bout en bout.
5. Une fois Mac↔Mac validé, passer à iPad/iPhone (Tailscale + app cliente VNC/SSH).
6. Ensuite seulement : projet séparé de sync des skills `~/.claude/` via repo Git privé (attention : certains fichiers de `~/.claude/` peuvent contenir des clés API ou données de session — prévoir un `.gitignore` avant de tout commit).

## Questions ouvertes

- Quel compte/méthode de connexion Matthieu veut utiliser pour Tailscale sur Mac Studio — a priori le même `mg4costcorp@gmail.com`, à confirmer.
- Quelle app VNC/SSH il préfère pour iPad/iPhone (Screens vs RealVNC Viewer vs Termius vs Blink) — pas encore choisi.
