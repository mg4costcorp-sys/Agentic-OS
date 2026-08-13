---
name: vercel-integration
description: >-
  Use when deploying a website, an AI chat agent/chatbot, or a Next.js app to Vercel — including wiring the Vercel AI SDK, routing models through AI Gateway, setting environment variables, or shipping preview vs production deploys. Builds a Next.js App Router site with an embedded /api/chat streaming agent and ships both on a single Vercel deployment.
version: 1.0.0
author: Jack Roberts
license: MIT
metadata:
  hermes:
    tags: [vercel, deployment, ai-sdk, ai-gateway, nextjs, embedded-agent, hosting]
    related_skills: [super-frontier-routing, model-router]
---

# Vercel Integration

## Overview

This skill ships a website and an AI chat agent as one unit. The site is a Next.js App Router app. The agent is a serverless function at `app/api/chat/route.ts` that streams model output back to a client `useChat` component. There is no separate backend, no second service to host — the page and the agent live in the same repo and go out on the same `vercel` deploy.

The mental model: the website is the static/rendered UI, and `/api/chat` **is** the embedded agent — a Vercel Function that calls a model through the Vercel AI SDK and streams tokens to the browser. You deploy the whole thing with one command (`vercel`) or by connecting a Git repo so every push builds automatically.

## When to Use

- Shipping a website that has an in-page chatbot, support agent, or "ask AI" box.
- Deploying a Next.js app (with or without AI) to Vercel.
- Wiring the Vercel AI SDK (`streamText` / `useChat`) into a route.
- Routing model calls through AI Gateway (one key, many models) or a direct provider.
- Setting env vars and doing preview vs production deploys.

**Don't use for:**
- Long-running agents (minutes to hours) that must survive timeouts — use a durable workflow, not a single Function.
- Non-Vercel hosts (Cloudflare Workers, AWS Lambda, self-managed) — the deploy and env steps here are Vercel-specific.
- Pure static sites with no server logic — you don't need the `/api/chat` route at all.

## The Stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router) |
| Embedded agent | Vercel AI SDK (`streamText` + `useChat`) |
| Model access | AI Gateway (one key, 100+ models) **or** a direct provider (e.g. `@ai-sdk/anthropic`) |
| Hosting | Vercel Functions (Node.js runtime, Fluid compute) |
| Deploy | `vercel` CLI or Git integration (auto-deploy per push) |

Scaffold with `npx create-next-app@latest`, then `npm i ai @ai-sdk/react zod`.

## Build the Embedded Agent

Two files: the server route (the agent) and the client component (the UI).

**Server — `app/api/chat/route.ts`:**

```ts
import { streamText, convertToModelMessages, type UIMessage } from 'ai';

export const maxDuration = 60; // seconds; raise for longer generations (plan-capped)

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: 'anthropic/claude-sonnet-4.6', // plain string routes via AI Gateway
    system: 'You are a helpful assistant embedded on this website.',
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

**Client — `app/chat.tsx`:**

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

export function Chat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}: </strong>
          {m.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text}</span> : null))}
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendMessage({ text: input });
          setInput('');
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

Then drop `<Chat />` into `app/page.tsx`. Note the current AI SDK: `useChat` comes from `@ai-sdk/react`, no longer manages input state (use `useState` + `sendMessage`), and messages render as a `parts` array. The route returns `toUIMessageStreamResponse()` (not the older `toDataStreamResponse`). **Method names have shifted across AI SDK majors — if `convertToModelMessages`, `sendMessage`, or `toUIMessageStreamResponse` don't resolve, verify against the installed version** via `node_modules/ai/docs/` or `ai-sdk.dev`.

**Completion criteria:** `npm run dev`, open the page, send a message, and see the reply stream in token by token.

## Model Access via AI Gateway

AI Gateway gives you one key that reaches Anthropic, OpenAI, Google, Fable-class and 100+ models. Any plain `'provider/model'` string passed to `model` routes through the gateway automatically — no wrapper needed. Swap models by changing the string. Slugs use **dots** for versions: `anthropic/claude-sonnet-4.6`, not `-4-6`.

Set `AI_GATEWAY_API_KEY` (create it in the Vercel dashboard under AI Gateway). It also unlocks fallbacks and per-feature spend tracking:

```ts
import { streamText, gateway } from 'ai';

const result = streamText({
  model: gateway('anthropic/claude-sonnet-4.6'),
  providerOptions: {
    gateway: {
      order: ['anthropic', 'bedrock'],        // failover order
      models: ['openai/gpt-5.4'],             // fallback model
      tags: ['feature:site-chat'],            // spend attribution
    },
  },
  messages: convertToModelMessages(messages),
});
```

**Direct provider instead:** install `@ai-sdk/anthropic`, set `ANTHROPIC_API_KEY`, and use `anthropic('claude-sonnet-4.6')` — simpler when you're on one provider and don't need failover or cross-provider cost tracking.

**Completion criteria:** a call succeeds with the gateway key set and no provider-specific key present.

## Environment Variables

Never commit keys. Keep `.env*` in `.gitignore`. Add secrets to Vercel per environment:

```bash
vercel env add AI_GATEWAY_API_KEY production   # prompts for the value
vercel env add AI_GATEWAY_API_KEY preview       # repeat per environment you use
vercel env pull .env.local                       # sync into local dev
```

You can also add them in the dashboard: **Project → Settings → Environment Variables**, scoped to Production / Preview / Development. Env vars are read at build/run time, so **redeploy after adding or changing them** — a running production deployment won't pick up a new value on its own.

**Completion criteria:** `vercel env ls` lists the key under Production, and `.env.local` exists locally (gitignored).

## Deploy

Two paths, pick one:

**CLI:**
```bash
vercel          # builds and ships a PREVIEW deployment (unique URL)
vercel --prod   # promotes to PRODUCTION (your main domain)
```

**Git integration (recommended for a demo you'll iterate on):** connect the repo in the Vercel dashboard. Then every push builds automatically — each branch and pull request gets its own preview URL, and merges to the production branch (usually `main`) deploy to production. No CLI needed after the first link.

Streaming works on Vercel Functions out of the box — the Node.js runtime (the default, on Fluid compute) streams responses fine; you do **not** need the Edge runtime for it. Long generations are bounded by the function timeout, so set `maxDuration` (seconds, plan-capped) and rely on streaming to flush bytes early.

**Completion criteria:** the preview URL loads the site, the embedded chat streams a reply, and `vercel --prod` (or a merge to `main`) puts it live.

## Common Pitfalls

1. **Missing env vars in production.** Adding a key to Development or Preview does not set it for Production — add it to Production explicitly, then redeploy. A working preview + broken prod almost always means this.
2. **Forcing the Edge runtime for streaming.** Unnecessary on Vercel and it breaks Node-only dependencies. Leave the default Node.js runtime unless you have a specific Edge reason; both stream.
3. **Forgetting the provider/gateway key.** A 401 from the model call means `AI_GATEWAY_API_KEY` (or a direct `ANTHROPIC_API_KEY`) is unset or typo'd for the current environment.
4. **CORS when embedded cross-origin.** If the chat widget lives on a different origin than `/api/chat`, the browser blocks it — add `Access-Control-*` headers and an `OPTIONS` handler on the route. Same-origin (widget in the same Next.js app) needs nothing.
5. **Function timeout on long generations.** The default cap can be short; a slow completion gets cut off. Raise `maxDuration` and always stream so partial output reaches the client before the limit.

## Verification Checklist

- [ ] `npm run build` (or `next build`) completes clean locally.
- [ ] `npm run dev` serves the page and `/api/chat` streams tokens (Network tab shows a streaming response, not one JSON blob).
- [ ] `vercel` preview deployment is green and the preview URL loads.
- [ ] `AI_GATEWAY_API_KEY` (or the direct provider key) is set for **Production**, and the project was redeployed after setting it.
- [ ] `/api/chat` streams correctly on the deployed URL, not just locally.
- [ ] `vercel --prod` (or a merge to the production branch) is live.
- [ ] (Optional) custom domain attached under **Settings → Domains**.
