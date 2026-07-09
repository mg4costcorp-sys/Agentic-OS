import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import appCss from "../styles.css?url";
import { AppSidebar } from "@/components/app-sidebar";
// Dark mode only — no theme toggle. The html element has class="dark" permanently.
import { Bell } from "lucide-react";
import { HermesStatusPill } from "@/components/hermes-status-pill";
import { VersionPill } from "@/components/version-pill";
import { FloatingOracle } from "@/components/floating-oracle";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Claude Code OS — Operator Dashboard" },
      {
        name: "description",
        content:
          "Read-only observability dashboard for Claude Code workspaces, skills, memory, runs and outputs.",
      },
      { property: "og:title", content: "Claude Code OS — Operator Dashboard" },
      { name: "twitter:title", content: "Claude Code OS — Operator Dashboard" },
      {
        property: "og:description",
        content:
          "Read-only observability dashboard for Claude Code workspaces, skills, memory, runs and outputs.",
      },
      {
        name: "twitter:description",
        content:
          "Read-only observability dashboard for Claude Code workspaces, skills, memory, runs and outputs.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Hermes section uses Fraunces as a free, expressive stand-in for
      // Mondwest (the Nous Research site display font).
      // Fraunces is a variable serif with sharp contrast + retro-futurist
      // character — closest free Google Font to Mondwest's confident
      // display weight. Courier Prime matches the upstream's mono.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href:
          "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..900,0..100,0..1&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Dark mode is permanent — set in RootShell's <html className="dark">

  // The floating Oracle guide — mounted after hydration (localStorage-backed
  // toggle would otherwise mismatch the server render). Defaults ON so a
  // fresh install discovers it; the header orb re-enables it once hidden.
  const [oracleOn, setOracleOn] = useState(false);
  const [oracleReady, setOracleReady] = useState(false);
  useEffect(() => {
    let on = true;
    try { on = localStorage.getItem("os-oracle-on") !== "0"; } catch { /* privacy mode */ }
    setOracleOn(on);
    setOracleReady(true);
  }, []);
  const toggleOracle = (next: boolean) => {
    setOracleOn(next);
    try { localStorage.setItem("os-oracle-on", next ? "1" : "0"); } catch { /* ignore */ }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex min-h-screen w-full bg-background text-foreground">
        <AppSidebar />
        <div className="flex flex-1 min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/85 px-4 backdrop-blur-md md:px-6">
            <div className="flex items-center gap-2.5 text-sm">
              <span className="font-medium tracking-tight">Operator</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-muted-foreground tracking-tight">local</span>
              <VersionPill />
            </div>
            <div className="flex items-center gap-2.5">
              {/* Hermes online pill — visible from every route. Click goes
                  to /agents/hermes. Renders nothing when Hermes isn't
                  installed so the bar stays clean for users without it. */}
              <HermesStatusPill />
              {/* Oracle toggle — shows/hides the floating guide orb. */}
              <button
                onClick={() => toggleOracle(!oracleOn)}
                title={oracleOn ? "Hide the Oracle guide" : "Show the Oracle guide"}
                className="rounded-md p-2 transition-colors hover:bg-accent"
              >
                <span
                  aria-hidden
                  className="block h-3.5 w-3.5 rounded-full transition-all"
                  style={{
                    background: oracleOn
                      ? "radial-gradient(circle at 35% 35%, #d8fff3, #7be0c8 55%, #0d5c4a)"
                      : "radial-gradient(circle at 35% 35%, #6b7280, #374151 60%, #111827)",
                    boxShadow: oracleOn ? "0 0 10px rgba(123,224,200,0.75)" : "none",
                  }}
                />
              </button>
              <button className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <Bell className="h-4 w-4" />
              </button>
              {/* Dark mode only — no theme toggle */}
            </div>
          </header>
          <main className="flex-1 overflow-x-hidden p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>
      {oracleReady && <FloatingOracle enabled={oracleOn} onDisable={() => toggleOracle(false)} />}
    </QueryClientProvider>
  );
}
