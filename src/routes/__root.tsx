import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { AppSidebar, MobileNav } from "@/components/app-sidebar";
import { HermesStatusPill } from "@/components/hermes-status-pill";
import { VersionPill } from "@/components/version-pill";
import { ThemeToggle } from "@/components/theme-toggle";
import { OperatorJobs } from "@/components/operator-jobs";

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
        href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,400..900,0..100,0..1&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap",
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
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint — light is the default. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("theme")==="dark")document.documentElement.classList.add("dark")}catch(e){}',
          }}
        />
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

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex min-h-screen w-full bg-background text-foreground">
        <AppSidebar />
        <div className="flex flex-1 min-w-0 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/85 px-4 backdrop-blur-md md:px-6">
            <div className="flex items-center gap-2 text-sm min-w-0">
              <MobileNav />
              {/* On mobile the sidebar drawer already shows Operator/local
                  in its identity block, so we hide this redundant crumb
                  to keep room for the right-side pills. */}
              <span className="hidden sm:inline font-medium tracking-tight">Operator</span>
              <span className="hidden sm:inline text-muted-foreground/50">/</span>
              <span className="hidden sm:inline text-muted-foreground tracking-tight">local</span>
              <VersionPill />
            </div>
            <div className="flex items-center gap-2.5">
              {/* Hermes online pill — visible from every route. Click goes
                  to /agents/hermes. Renders nothing when Hermes isn't
                  installed so the bar stays clean for users without it. */}
              <HermesStatusPill />
              <OperatorJobs />
              <ThemeToggle />
            </div>
          </header>
          <main className="flex-1 overflow-x-hidden p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </QueryClientProvider>
  );
}
