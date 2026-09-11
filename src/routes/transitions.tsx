import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/transitions")({
  component: TransitionsPage,
});

// ── Transition Lab, embedded whole ─────────────────────────────────────────
// The lab is a static page under public/transitions: a 68-clip transition
// library previewed on real footage, plus a client-side cut scanner that
// finds hard cuts in an uploaded clip by frame differencing. It ships as one
// self-contained folder so it survives OS rebuilds untouched.
function TransitionsPage() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(true), []);
  return (
    <div className="p-4 md:p-6">
      <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#100f0f]">
        {loaded ? (
          <iframe
            title="Transition Lab"
            src="/transitions/index.html"
            allow="fullscreen"
            allowFullScreen
            className="h-[calc(100vh-120px)] min-h-[640px] w-full border-0"
          />
        ) : (
          <div className="grid h-[640px] place-items-center text-[12px] text-white/40">
            Opening the lab…
          </div>
        )}
      </div>
    </div>
  );
}
