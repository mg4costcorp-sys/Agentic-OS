import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ScanSearch, Square } from "lucide-react";
import { cn } from "@/lib/utils";

type GenerationJob = {
  id: string;
  total: number;
  prompt: string;
  engineLabel: string;
  modelLabel: string;
};

type LedgerItem = { jobId?: string | null };

type IndexJob = {
  running: boolean;
  done: number;
  total: number;
  mode: "ocr" | "vision";
} | null;

type VisibleJob = GenerationJob & { completed: number };

export function OperatorJobs() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<VisibleJob[]>([]);
  const [scan, setScan] = useState<IndexJob>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [jobsResponse, ledgerResponse, indexResponse] = await Promise.all([
        fetch("/__design_jobs"),
        fetch("/__design_ledger"),
        fetch("/__design_index_status"),
      ]);
      const [jobData, ledgerData, indexData] = await Promise.all([
        jobsResponse.json() as Promise<{ ok?: boolean; jobs?: GenerationJob[] }>,
        ledgerResponse.json() as Promise<{ ok?: boolean; items?: LedgerItem[] }>,
        indexResponse.json() as Promise<{ ok?: boolean; job?: IndexJob }>,
      ]);
      const ledgerItems = ledgerData.ok && Array.isArray(ledgerData.items) ? ledgerData.items : [];
      setJobs(
        jobData.ok && Array.isArray(jobData.jobs)
          ? jobData.jobs.map((job) => ({
              ...job,
              completed: ledgerItems.filter((item) => item.jobId === job.id).length,
            }))
          : [],
      );
      setScan(indexData.ok ? (indexData.job ?? null) : null);
    } catch {
      // The local OS can restart while this is mounted. The next poll reconnects.
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(
      () => void load(),
      open || jobs.length > 0 || scan?.running ? 1_500 : 5_000,
    );
    return () => window.clearInterval(interval);
  }, [jobs.length, load, open, scan?.running]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOutside = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("mousedown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("mousedown", closeOutside);
    };
  }, [open]);

  const cancelGeneration = async (jobId: string) => {
    const csrf = (await (await fetch("/__token")).json()).token as string;
    await fetch("/__design_cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": csrf },
      body: JSON.stringify({ jobId }),
    });
    void load();
  };

  const stopScan = async () => {
    const csrf = (await (await fetch("/__token")).json()).token as string;
    await fetch("/__design_index_stop", {
      method: "POST",
      headers: { "X-Claude-OS-Token": csrf },
    });
    void load();
  };

  const activeCount = jobs.length + (scan?.running ? 1 : 0);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${activeCount} active jobs`}
        title="Background jobs"
        className={cn(
          "relative grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <Activity className="h-4 w-4" />
        {activeCount > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full border border-background bg-emerald-400 px-1 text-[8px] font-bold tabular-nums text-emerald-950">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Background jobs"
          className="absolute right-0 top-full z-[120] mt-2 w-[340px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3.5 py-3">
            <div>
              <div className="text-xs font-semibold">Background jobs</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                Keep working while the OS finishes the rest.
              </div>
            </div>
            <span className="rounded-full border border-border px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
              {activeCount} active
            </span>
          </div>
          <div className="max-h-[340px] space-y-1.5 overflow-y-auto p-2">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl border border-border/70 bg-muted/30 p-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium">{job.prompt}</div>
                    <div className="mt-1 text-[9px] text-muted-foreground">
                      {job.engineLabel} · {job.modelLabel} · {job.completed}/{job.total} ready
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void cancelGeneration(job.id)}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-rose-300/40 hover:bg-rose-400/10 hover:text-rose-500"
                    aria-label={`Cancel ${job.prompt}`}
                    title="Cancel job"
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </button>
                </div>
              </div>
            ))}
            {scan?.running && (
              <div className="rounded-xl border border-border/70 bg-muted/30 p-2.5">
                <div className="flex items-start gap-2">
                  <ScanSearch className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium">
                      {scan.mode === "vision" ? "Understanding visuals" : "Reading image text"}
                    </div>
                    <div className="mt-1 text-[9px] tabular-nums text-muted-foreground">
                      {scan.done.toLocaleString()} / {scan.total.toLocaleString()} complete
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void stopScan()}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-rose-300/40 hover:bg-rose-400/10 hover:text-rose-500"
                    aria-label="Stop scan"
                    title="Stop scan"
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </button>
                </div>
              </div>
            )}
            {activeCount === 0 && (
              <div className="px-4 py-8 text-center">
                <div className="text-[11px] text-foreground/70">Nothing running</div>
                <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  Generations and scans appear here without blocking your workspace.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
