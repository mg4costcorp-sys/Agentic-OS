import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { TrendingUp, TrendingDown, Minus, LineChart } from "lucide-react";
import { useLiveData } from "@/lib/use-live-data";
import { useCurrency } from "@/lib/currency";

// Each tile reads one numeric series out of the daily history snapshots
// (~/.claude-os/history.jsonl, embedded into live-data.json as `history`).
type Metric = {
  key: "value7d" | "messages7d" | "claudeWeeklyPct" | "skillRuns7d";
  label: string;
  color: string;
  fmt: (v: number) => string;
  /** Money metrics format through the display-currency hook instead of fmt. */
  money?: boolean;
};

const METRICS: Metric[] = [
  { key: "value7d", label: "Value extracted · 7d", color: "#10D49C", money: true, fmt: (v) => `$${Math.round(v)}` },
  { key: "messages7d", label: "Messages · 7d", color: "#7C8CFF", fmt: (v) => v.toLocaleString() },
  { key: "claudeWeeklyPct", label: "Weekly window", color: "#FF8A4C", fmt: (v) => `${v}%` },
  { key: "skillRuns7d", label: "Skill runs · 7d", color: "#B991FF", fmt: (v) => v.toLocaleString() },
];

interface HistoryRecord {
  date: string;
  value7d: number;
  messages7d: number;
  claudeWeeklyPct: number;
  skillRuns7d: number;
}

export function TrendsPanel() {
  const liveData = useLiveData();
  const history = useMemo<HistoryRecord[]>(
    () => (Array.isArray(liveData?.history) ? liveData.history : []),
    [liveData],
  );

  // Nothing to chart until at least one snapshot exists. The aggregator writes
  // the first row on its next run, so a fresh install simply hides the panel
  // rather than showing an empty frame.
  if (history.length === 0) return null;

  const days = history.length;

  return (
    <section className="relative mb-12">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground mb-1.5">
            History
          </div>
          <h2 className="text-lg font-semibold tracking-tight">Trends over time</h2>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          {days === 1 ? "Tracking started today" : `${days} days tracked`}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {METRICS.map((m) => (
          <MetricTile key={m.key} metric={m} history={history} />
        ))}
      </div>

      <div className="mt-2 text-[10px] text-muted-foreground/60 flex items-center gap-3">
        <LineChart className="h-3 w-3" />
        Daily snapshots from ~/.claude-os/history.jsonl. One row per day, aggregate numbers only —
        no session content stored.
      </div>
    </section>
  );
}

function MetricTile({ metric, history }: { metric: Metric; history: HistoryRecord[] }) {
  const { format: fmtMoney } = useCurrency();
  const fmt = (v: number) => (metric.money ? fmtMoney(v) : metric.fmt(v));
  const series = history.map((h) => ({
    date: h.date,
    value: typeof h[metric.key] === "number" ? (h[metric.key] as number) : 0,
  }));

  const current = series[series.length - 1]?.value ?? 0;
  const prev = series.length >= 2 ? series[series.length - 2].value : null;
  const delta = prev === null ? null : current - prev;

  const gradientId = `trend-grad-${metric.key}`;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 overflow-hidden">
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground truncate">
        {metric.label}
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums tracking-tight" style={{ color: metric.color }}>
          {fmt(current)}
        </span>
        <DeltaBadge delta={delta} color={metric.color} fmt={fmt} />
      </div>

      <div className="mt-3 h-12 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={metric.color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={metric.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip
              cursor={{ stroke: metric.color, strokeOpacity: 0.3 }}
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 11,
              }}
              labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              formatter={(v: number) => [fmt(v), ""]}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={metric.color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={series.length === 1 ? { r: 3, fill: metric.color } : false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DeltaBadge({
  delta,
  color,
  fmt,
}: {
  delta: number | null;
  color: string;
  fmt: (v: number) => string;
}) {
  if (delta === null) {
    return <span className="text-[10px] text-muted-foreground/50">new</span>;
  }
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60">
        <Minus className="h-2.5 w-2.5" />
        flat
      </span>
    );
  }
  const up = delta > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums" style={{ color }}>
      <Icon className="h-2.5 w-2.5" />
      {up ? "+" : "−"}
      {fmt(Math.abs(delta))}
    </span>
  );
}
