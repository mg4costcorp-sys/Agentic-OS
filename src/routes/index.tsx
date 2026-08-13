import { createFileRoute } from "@tanstack/react-router";
import { HomeCommand } from "@/components/home-command";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Claude Code OS" },
      {
        name: "description",
        content: "One conversation surface for Hermes and Claude Code, with your memory brain a keystroke away.",
      },
    ],
  }),
  component: CommandHome,
});

function CommandHome() {
  // Full-bleed: cancel the root <main> padding so the conversation surface
  // owns everything under the header.
  return (
    <div className="-m-4 md:-m-6 h-[calc(100vh-3.5rem)]">
      <HomeCommand />
    </div>
  );
}
