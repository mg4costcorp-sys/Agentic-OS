import { Link, useRouterState } from "@tanstack/react-router";
import { Home, Sparkles, Brain, Activity, Waypoints, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import claudeLogo from "@/assets/claude-logo.png";
import hermesLogo from "@/assets/hermes-agent.png";
import openclawLogo from "@/assets/openclaw.png";

const AVATAR_STORAGE_KEY = "claude-os.avatar.v1";
const OPERATOR_NAME_KEY = "claude-os.operator-name.v1";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Sidebar identity block — avatar + name. Reads both from localStorage and
// listens for cross-tab + same-tab updates (the wizard fires synthetic
// StorageEvents on save so this block updates as the user types their name).
function SidebarIdentity() {
  const [avatar, setAvatar] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    setAvatar(readStorage(AVATAR_STORAGE_KEY));
    setName(readStorage(OPERATOR_NAME_KEY));
    const onStorage = (e: StorageEvent) => {
      if (e.key === AVATAR_STORAGE_KEY || e.key === null) {
        setAvatar(readStorage(AVATAR_STORAGE_KEY));
      }
      if (e.key === OPERATOR_NAME_KEY || e.key === null) {
        setName(readStorage(OPERATOR_NAME_KEY));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Initials for the placeholder avatar if no photo is set.
  const initials = (() => {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "OP";
    const parts = trimmed.split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "OP";
  })();

  const displayName = name?.trim() || "Operator";

  return (
    <div className="flex items-center gap-3">
      {avatar ? (
        <img
          src={avatar}
          alt={displayName}
          className="h-9 w-9 rounded-full object-cover ring-1"
          style={{ outline: "1px solid rgba(217, 119, 87, 0.45)", outlineOffset: 1 }}
        />
      ) : (
        <div
          aria-hidden
          className="h-9 w-9 rounded-full ring-1 ring-border flex items-center justify-center text-[11px] font-semibold tracking-wider"
          style={{
            background:
              "linear-gradient(135deg, rgba(217, 119, 87, 0.28), rgba(167, 139, 250, 0.22))",
            color: "rgba(255, 255, 255, 0.92)",
            boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
          }}
        >
          {initials}
        </div>
      )}
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-[12.5px] font-semibold tracking-tight truncate">{displayName}</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          local
        </span>
      </div>
    </div>
  );
}

const primary = [
  { to: "/", label: "Home", icon: Home },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/codegraph", label: "Knowledge Graph", icon: Waypoints },
  { to: "/activity", label: "Activity", icon: Activity },
];

const agents = [
  { to: "/agents/hermes", label: "Hermes Agent", logo: hermesLogo, tone: "#FFD21E" },
  { to: "/agents/openclaw", label: "OpenClaw", logo: openclawLogo, tone: "#EF4444" },
];

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));

  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-border bg-sidebar sticky top-0 h-screen self-start overflow-y-auto">
      {/* Brand mark — Claude logo with a soft orange halo so it reads as
          the primary identity and not just another tile. */}
      <div className="flex h-14 items-center gap-2.5 px-5">
        <div
          className="relative flex h-8 w-8 items-center justify-center rounded-lg overflow-hidden shrink-0"
          style={{
            background: "linear-gradient(135deg, #FFB071 0%, #D97757 60%, #C45A39 100%)",
            boxShadow:
              "inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 6px 16px -8px rgba(217, 119, 87, 0.7)",
          }}
        >
          <img src={claudeLogo} alt="Claude" className="h-6 w-6 object-contain drop-shadow-sm" />
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[12.5px] font-semibold tracking-tight">Claude Code OS</span>
          <span className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70">
            Operator
          </span>
        </div>
      </div>

      <nav className="flex-1 px-3 pt-3 space-y-0.5">
        {primary.map((item) => {
          const active = isActive(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "relative flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] transition-colors",
                active
                  ? "text-foreground font-medium bg-accent/80"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
            >
              {/* Active indicator: 2px orange bar on the left edge */}
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-full"
                  style={{
                    background: "linear-gradient(180deg, #FFC371, #FF7A3D)",
                    boxShadow: "0 0 8px rgba(255, 122, 61, 0.55)",
                  }}
                />
              )}
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
        {/* Faint divider */}
        <div className="my-3 mx-2.5 h-px bg-border/60" />
        <div className="px-2.5 pb-1 text-[9px] uppercase tracking-[0.2em] text-muted-foreground/70">
          Agents
        </div>
        <div className="flex flex-col gap-1 px-2.5">
          {agents.map((a) => {
            const active = isActive(a.to);
            return (
              <Link
                key={a.to}
                to={a.to}
                title={a.label}
                aria-label={a.label}
                className={cn(
                  "group relative flex h-11 w-full items-center justify-center rounded-lg border transition-all overflow-hidden",
                  active
                    ? "border-foreground/20 bg-accent"
                    : "border-border/60 hover:border-foreground/20 hover:-translate-y-px",
                )}
                style={{
                  backgroundImage: `radial-gradient(120% 90% at 50% 0%, ${a.tone}26, ${a.tone}0a 55%, transparent 80%)`,
                }}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 h-10 w-16 rounded-full blur-2xl opacity-50 group-hover:opacity-80 transition-opacity"
                  style={{ background: a.tone }}
                />
                <img
                  src={a.logo}
                  alt={a.label}
                  className="relative h-7 max-w-[78%] object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                />
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-3 pb-3">
        <div className="h-px bg-border mb-2" />
        <Link
          to="/settings"
          className={cn(
            "flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] transition-colors",
            isActive("/settings")
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground/70 hover:text-foreground hover:bg-accent/50",
          )}
        >
          <SettingsIcon className="h-4 w-4 shrink-0" />
          Settings
        </Link>
      </div>

      <div className="border-t border-border px-4 py-3">
        <SidebarIdentity />
      </div>
    </aside>
  );
}
