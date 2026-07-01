import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type React from "react";

// The running build's version + changelog, served by the loopback-only
// `/__app_version` endpoint (parsed from CHANGELOG.md, so it works for plain
// file downloads with no git). The pill self-reports which build you're on —
// so a download whose folder/zip name lags the real contents still tells the
// truth — and the "What's new" panel shows what changed, so anyone who has
// layered their own edits can see each update before merging it in.
type AppVersion = {
  version: string;
  date: string;
  hash: string;
  markdown: string;
};

function useAppVersion() {
  return useQuery<AppVersion>({
    queryKey: ["app-version"],
    queryFn: async () => {
      const res = await fetch("/__app_version");
      if (!res.ok) throw new Error("version unavailable");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function VersionPill() {
  const { data } = useAppVersion();
  const [open, setOpen] = useState(false);

  if (!data?.version) return null;
  const label = data.hash ? `${data.version} · ${data.hash}` : data.version;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="What's new — view the changelog"
        className="rounded-full border border-border/70 bg-accent/40 px-2 py-0.5 text-[10px] font-medium tracking-tight text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        {label}
      </button>
      {open && <ChangelogModal data={data} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChangelogModal({ data, onClose }: { data: AppVersion; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const meta = [data.version, data.date, data.hash].filter(Boolean).join(" · ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm md:p-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">What's new</h2>
            <span className="truncate text-[11px] text-muted-foreground">{meta}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <Markdown text={data.markdown} />
        </div>
      </div>
    </div>
  );
}

// Minimal, dependency-free renderer for the CHANGELOG subset (headings,
// bullets + sub-bullets, rules, blockquotes, inline bold + code).
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold text-foreground">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={`${keyPrefix}-c${i}`}
          className="rounded bg-accent/60 px-1 py-0.5 font-mono text-[11px] text-foreground"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  text.split("\n").forEach((line, idx) => {
    const key = `l${idx}`;
    if (/^#\s+/.test(line)) {
      out.push(
        <h1 key={key} className="mb-2 mt-1 text-base font-semibold tracking-tight">
          {renderInline(line.replace(/^#\s+/, ""), key)}
        </h1>,
      );
    } else if (/^##\s+/.test(line)) {
      out.push(
        <h2 key={key} className="mb-1.5 mt-5 text-sm font-semibold tracking-tight text-foreground">
          {renderInline(line.replace(/^##\s+/, ""), key)}
        </h2>,
      );
    } else if (/^###\s+/.test(line)) {
      out.push(
        <h3
          key={key}
          className="mb-1 mt-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
        >
          {renderInline(line.replace(/^###\s+/, ""), key)}
        </h3>,
      );
    } else if (/^---+\s*$/.test(line)) {
      out.push(<hr key={key} className="my-4 border-border/60" />);
    } else if (/^\s*[-*]\s+/.test(line)) {
      const indented = (line.match(/^(\s*)/)?.[1].length ?? 0) >= 2;
      out.push(
        <div
          key={key}
          className={`flex gap-2 text-[12.5px] leading-relaxed text-muted-foreground ${
            indented ? "ml-5" : "ml-1"
          }`}
        >
          <span className="mt-[2px] text-muted-foreground/50">•</span>
          <span>{renderInline(line.replace(/^\s*[-*]\s+/, ""), key)}</span>
        </div>,
      );
    } else if (/^>\s+/.test(line)) {
      out.push(
        <blockquote
          key={key}
          className="my-2 border-l-2 border-border pl-3 text-[12.5px] italic text-muted-foreground"
        >
          {renderInline(line.replace(/^>\s+/, ""), key)}
        </blockquote>,
      );
    } else if (line.trim() === "") {
      out.push(<div key={key} className="h-2" />);
    } else {
      out.push(
        <p key={key} className="text-[12.5px] leading-relaxed text-muted-foreground">
          {renderInline(line, key)}
        </p>,
      );
    }
  });
  return <div>{out}</div>;
}
