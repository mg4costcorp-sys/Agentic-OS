# Handoff — CRM sur mesure pour Catherine

**Date:** 2026-07-05
**État:** Planification uniquement. **Aucun code écrit, aucun repo créé.** Ceci est une proposition d'architecture à comparer avec d'autres outils IA avant de lancer le développement.
**Machine d'origine:** MacBook Air (session Claude Code sur le repo `Agentic-OS`, sans rapport avec le dashboard Claude OS lui-même — ce sera un projet séparé).

---

## Contexte

Matthieu (développeur/geek IA) veut construire, gratuitement et seul, un CRM sur mesure pour Catherine, sa conjointe. Elle est consultante indépendante à temps partiel (en plus d'un emploi à temps plein au gouvernement du Québec), 2-5 clients PME à la fois (ex. avocate en région, entrepreneur en aménagement paysager/excavation). Son travail : communications/RP, gestion de réseaux sociaux clients, préparation d'entrevues radio, coordination de projets (fournisseurs site web, graphiste, merchandising).

Elle facture chaque client quelques centaines de dollars/mois. **Son plus gros irritant : préparer et envoyer ses factures chaque mois (ou aux 3 mois).** Elle n'est pas inscrite aux taxes (TPS/TVQ) actuellement, mais ça pourrait changer.

Objectif de Matthieu : un outil de niveau professionnel, "slick", dont elle serait fière — pas un outil bricolé.

---

## Décisions prises jusqu'ici

### Stack technique
- **Frontend:** Next.js 14+ (App Router) + TypeScript + Tailwind + shadcn/ui + Framer Motion
- **Backend:** Server Actions / route handlers Next.js — pas de backend séparé
- **DB + Auth + Storage:** Supabase (Postgres, free tier) — un seul service géré pour tout
- **PDF factures:** `@react-pdf/renderer` (reste serverless)
- **Email transactionnel:** Resend (free tier ~3000/mois), SPF/DKIM à configurer sur un vrai domaine pour éviter le spam
- **Réception d'emails par client:** techniquement la partie la plus complexe (adresse de forwarding par client ou alias + webhook parsing) — **volontairement repoussée en v2**, pas dans le MVP
- **Hébergement:** Vercel (free tier), cron via Vercel Cron ou pg_cron Supabase
- **Auth:** Supabase Auth, magic link, probablement un seul compte utilisateur (Catherine)

### Facturation automatisée (priorité #1)
Table `billing_terms` par client : montant, fréquence, `next_invoice_date`, `tax_mode` (`none` | `tps_tvq`, togglable), `send_mode` (`auto` | `review`), `payment_terms_days`.

Cron quotidien : scanne les `billing_terms` actifs échus → génère facture en `draft` (calcul de taxes **toujours déterministe en code, jamais par un LLM**) → génère PDF → selon `send_mode`, envoie directement ou envoie à Catherine pour approbation (lien magique "Approuver et envoyer").

États facture : `draft → pending_review → sent → paid → overdue → cancelled`. Contrainte d'unicité `(client_id, period_start, period_end)` pour éviter les doublons si le cron tourne deux fois.

**Recommandation forte : démarrer TOUS les clients en `send_mode: review`**, même ceux visés pour l'auto éventuellement — trop risqué d'envoyer une facture erronée sans supervision dès le lancement.

### Structure de données proposée
```
clients          (id, name, company_name, contact_name, email, phone, address, status, tags[], sector, created_at)
contacts         (id, client_id, name, role, email, phone)
notes            (id, client_id, author, content, created_at, ai_summary)
documents        (id, client_id, file_name, storage_path, type, uploaded_at)
emails           (id, client_id, direction, subject, body, from, to, sent_at, thread_id)
billing_terms    (id, client_id, amount, frequency, tax_mode, send_mode, next_invoice_date, payment_terms_days, active)
invoices         (id, client_id, billing_term_id, invoice_number, period_start, period_end, subtotal, tax_tps, tax_tvq, total, status, pdf_url, sent_at, paid_at, due_date)
invoice_line_items (id, invoice_id, description, amount)
```

### Web/PWA vs app iPhone native
**Décision : PWA responsive, pas d'app native.** Volume d'usage trop faible (2-5 clients) pour justifier le double coût de maintenance d'une app native. Revisiter seulement si elle veut des notifications push pour les factures en retard (web push suffirait avant d'envisager du natif).

### IA — fonctionnalités priorisées
1. Résumé de fiche client avant un appel (agrège notes + emails + factures)
2. Rédaction de communications (emails, posts réseaux sociaux)
3. Préparation d'entrevues radio (questions/réponses selon secteur du client) — différenciateur fort, spécifique à son métier
4. Résumé automatique des notes de suivi (TL;DR + actions à faire)
5. Relances de factures en retard générées par IA
6. Idées de posts réseaux sociaux (calendrier de contenu)
7. Digest hebdomadaire ("voici ce qui a besoin d'attention")
8. Recherche sémantique dans notes/documents (v2, via embeddings)

MVP IA = items 1 à 4.

### Architecture IA multi-fournisseurs — pivot important
**Le compte ChatGPT Plus de Catherine ne donne PAS de crédits API OpenAI** (facturation séparée). Plutôt que de payer OpenAI à l'usage, on utilise plusieurs offres API **gratuites** en parallèle avec bascule automatique — objectif : coût réel de 0$, pas juste "presque zéro".

Offres gratuites vérifiées (juillet 2026, ça change vite) :
- **Google Gemini** (Flash/Flash-Lite) : ~1 500 req/jour, 1M TPM, sans carte. ⚠️ Piège : si la facturation est activée sur le projet GCP (même une fois), le tier gratuit disparaît complètement pour ce projet → utiliser un projet GCP dédié, jamais relié à une carte. Modèles Pro plus gratuits depuis avril 2026.
- **Groq** : ~30 req/min, ~1000 req/jour, modèles open-weight (Llama 3.3 70B, gpt-oss-120b, Gemma 2) sur hardware très rapide, aucune carte requise.
- **Cloudflare Workers AI** : 10 000 "neurones"/jour, gratuit sans limite de temps, modèles open-source. Cohérent avec l'écosystème Cloudflare déjà utilisé par Matthieu pour son autre projet client.
- **Ollama auto-hébergé** (sur le Mac Studio de Matthieu) : illimité, 0$, mais dépend que le Mac Studio soit allumé/joignable (ex. Cloudflare Tunnel) — traité comme tier d'appoint, pas comme dépendance critique.
- **OpenAI** : gardé dans le code comme fallback, **désactivé par défaut** (`ENABLE_OPENAI_FALLBACK=false`).

Ordre par défaut recommandé : `gemini,groq,cloudflare` (Ollama et OpenAI optionnels).

**Architecture du code (référence, pas encore implémentée) :**
```
lib/ai/
  types.ts          # interface commune AIProvider
  providers/
    gemini.ts
    groq.ts
    cloudflare.ts
    ollama.ts
    openai.ts        # désactivé par défaut
  router.ts          # bascule/fallback ordonnée, configurable via AI_PROVIDER_ORDER
  prompts/           # templates centralisés, testés sur chaque fournisseur
```

Interface commune :
```typescript
export interface AIMessage { role: "system" | "user"; content: string }
export interface AICompletionRequest { messages: AIMessage[]; maxTokens?: number; temperature?: number }
export interface AICompletionResult { text: string; provider: string; model: string }
export interface AIProvider { name: string; enabled: boolean; complete(req: AICompletionRequest): Promise<AICompletionResult> }
```

Le router essaie chaque provider activé dans l'ordre (`AI_PROVIDER_ORDER` env var), catch les erreurs (quota/timeout), passe au suivant silencieusement — Catherine ne voit jamais l'échec, au pire une réponse d'un fournisseur moins prioritaire. Voir la session d'origine pour le code complet des adaptateurs Gemini/Groq (implémentations REST directes, pas de SDK lourd).

---

## Risques identifiés (à ne pas oublier)

- Clés API : jamais côté client, env vars uniquement, jamais commit
- Calculs monétaires : toujours déterministes en code, jamais générés par un LLM
- Conformité légale des factures québécoises pour travailleur autonome non inscrit aux taxes : **à valider avec un comptable ou Revenu Québec**, pas seulement sur la base de cette conversation
- Idempotence du cron de facturation (contrainte unique sur la période facturée)
- Délivrabilité email (SPF/DKIM) pour que les factures n'atterrissent pas en spam
- Réception d'emails par client = la pièce la plus complexe techniquement, repoussée en v2
- Les tiers gratuits IA changent leurs conditions sans préavis (Gemini l'a resserré en avril 2026) — d'où l'intérêt de l'abstraction multi-fournisseurs
- Scope creep : MVP v1 = fiche client + facturation automatisée seulement, IA et emails intégrés en v2

---

## Prochaines étapes

1. Comparer cette proposition avec d'autres outils IA (c'est l'intention explicite de Matthieu — ne pas encore coder)
2. Une fois la stack validée : créer le repo séparé (pas dans `Agentic-OS`)
3. Scaffolding Next.js + Supabase, schéma DB des tables ci-dessus
4. Construire le moteur de facturation en premier (priorité #1 de Catherine), avec `send_mode: review` partout au départ
5. Ajouter la couche IA multi-fournisseurs une fois le CRM de base + facturation stables
6. Revisiter web push / app native seulement si un besoin concret apparaît

## Questions encore ouvertes

- Domaine email à utiliser pour Resend (SPF/DKIM) — Catherine a-t-elle un domaine ?
- Faut-il un paiement en ligne (Stripe) ou "marqué payé manuellement" suffit pour l'instant ?
- Design exact ("slick, haut de gamme") — pas encore exploré visuellement, à faire avec `frontend-design` quand on passera à l'implémentation
