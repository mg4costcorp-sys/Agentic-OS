import { createFileRoute, Link } from "@tanstack/react-router";
import claudeLogo from "@/assets/claude-logo.png";
import { HermesMissionControl } from "@/components/hermes-mission-control";

// ────────────────────────────────────────────────────────────────────────────
// Claude Code agent page — mirrors the Hermes route in purpose (a dedicated
// surface for one runtime) but with its own visual identity and copy.
//
// Mission Control is the same component used on the home dashboard and the
// Hermes page; passing `agent="claude-code"` switches the Copy button to
// "Paste to Claude" and the actor pill in the briefing drawer to "Claude
// Code". The mission data, the cards, the prompts are identical across all
// three locations — you can pick any card up here or in Hermes, whichever's
// convenient.
//
// V1 reuses the existing Athena video inside Mission Control as a
// placeholder for the Claude Code visual identity until a dedicated
// asset lands. The matte/scale/grayscale chrome is identical to the
// Hermes variant so the page reads as visually consistent.
// ────────────────────────────────────────────────────────────────────────────

const CREAM = "#FFE6CB";
const CLAUDE_BLUE = "#7EB6FF";
const CLAUDE_DEEP = "#0F1B2A";

// Background — cooler blue tone vs the Hermes page's warm teal radial. Same
// pattern (radial that fades into a near-black bottom) so the page reads as
// "another room in the same house" rather than a different product.
const BG_GRADIENT =
  "radial-gradient(ellipse 90% 60% at 50% 0%, #0F1F33 0%, #08111F 50%, #050A14 100%)";

export const Route = createFileRoute("/agents/claude-code")({
  head: () => ({
    meta: [
      { title: "Claude Code — Claude Code OS" },
      {
        name: "description",
        content:
          "Mission Control for Claude Code. Same missions as Hermes — pick up any card in whichever runtime is convenient.",
      },
    ],
  }),
  component: ClaudeCodePage,
});

function ClaudeCodePage() {
  return (
    <div
      className="claude-skin relative -mx-6 md:-mx-8 -mt-6 md:-mt-8 -mb-6 md:-mb-8 min-h-screen"
      style={{
        color: CREAM,
        background: BG_GRADIENT,
      }}
    >
      <div className="relative z-10 px-6 md:px-10 py-6 md:py-8">
        {/* Breadcrumb + status pill row. Mirrors the Hermes page layout
            but with Claude-coded labelling. */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
          <Link
            to="/"
            className="hermes-mono text-[11px] uppercase tracking-[0.22em] transition-colors"
            style={{ color: "rgba(255,230,203,0.65)" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = CREAM;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "rgba(255,230,203,0.65)";
            }}
          >
            Operator{" "}
            <span style={{ color: "rgba(255,230,203,0.3)" }}>/</span> local
          </Link>
          <div
            className="hermes-mono text-[11px] uppercase tracking-[0.22em] inline-flex items-center gap-2 px-3 py-1.5 border"
            style={{
              borderColor: "rgba(126,182,255,0.55)",
              color: CREAM,
              background: "rgba(126,182,255,0.08)",
            }}
          >
            <img
              src={claudeLogo}
              alt="Claude"
              style={{
                width: 14,
                height: 14,
                opacity: 0.95,
                filter: "drop-shadow(0 0 4px rgba(126,182,255,0.4))",
              }}
            />
            <span>Claude&nbsp;Code</span>
            <span
              className="inline-block"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: CLAUDE_BLUE,
                boxShadow: `0 0 8px ${CLAUDE_BLUE}`,
              }}
            />
            <span style={{ color: CLAUDE_BLUE }}>ONLINE</span>
          </div>
        </div>

        {/* Page identity strip — a quiet header that establishes this is
            the Claude Code lane. Title-case display type matching the
            Mission Control aesthetic. */}
        <header className="mb-10">
          <div
            className="hermes-mono text-[10.5px] uppercase tracking-[0.28em] mb-2"
            style={{ color: CLAUDE_BLUE }}
          >
            Agent · Claude Code
          </div>
          <h1
            className="hermes-display"
            style={{
              color: CREAM,
              fontSize: "clamp(32px, 3.4vw, 48px)",
              lineHeight: 1.08,
              letterSpacing: "-0.01em",
              marginBottom: 8,
            }}
          >
            Claude Code
          </h1>
          <p
            className="max-w-2xl"
            style={{
              color: "rgba(255,230,203,0.65)",
              fontFamily: '"Fraunces", serif',
              fontSize: 16,
              lineHeight: 1.55,
              fontStyle: "italic",
            }}
          >
            Strategic missions you can pick up here or in Hermes — whichever's
            convenient. Same cards, same prompts. The chat session is the
            work surface; the agent figures out the rest.
          </p>
        </header>

        {/* MISSION CONTROL — same panel as the home dashboard and the
            Hermes route. Passing agent="claude-code" swaps the Copy button
            label to "Paste to Claude" and the actor pill to "Claude Code". */}
        <section className="mb-14">
          <HermesMissionControl agent="claude-code" />
        </section>
      </div>
    </div>
  );
}
