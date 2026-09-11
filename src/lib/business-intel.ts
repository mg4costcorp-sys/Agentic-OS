// Business Intelligence — sample data + pure helpers.
//
// Everything on the /business page reads from `BUSINESS_SAMPLE`. It is
// deliberately a plain, typed object so a live source (bank API, Stripe,
// Skool, a spreadsheet export via scripts/aggregate.ts) can replace it
// field-for-field without touching the UI. All money is in USD; the page
// formats through `useCurrency()` so the operator's chosen currency applies.

export type StreamKey = "sponsorships" | "community" | "products" | "consulting";

export type MonthRow = {
  /** ISO month, e.g. "2026-09" */
  month: string;
  /** Short label for axes, e.g. "Sep" */
  label: string;
  /** True when the month is still in progress (month-to-date figures). */
  partial?: boolean;
  income: Record<StreamKey, number>;
  expenses: number;
};

export type Account = { name: string; balance: number; note: string };

export type DealStage = "Lead" | "Proposal" | "Negotiating" | "Signed" | "Delivered" | "Paid";

export type Deal = {
  id: string;
  partner: string;
  stage: DealStage;
  value: number;
  /** ISO date the deal closes / closed */
  close: string;
  owner: string;
};

export type QuarterMetric = {
  key: string;
  label: string;
  unit: string;
  value: number;
  target: number;
  /** Same metric at the end of the previous quarter, for the delta. */
  previous: number;
  icon: "video" | "handshake" | "users";
};

export type PublishDay = { date: string; views: number };

export type ExpenseLine = { name: string; amount: number };

export type BusinessData = {
  generatedAt: string;
  accounts: Account[];
  /** Daily total balance across accounts, oldest first (last 90 days). */
  balanceHistory: number[];
  months: MonthRow[];
  quarter: {
    label: string;
    start: string;
    end: string;
    priority: { title: string; why: string; value: number; target: number; unit: string };
    metrics: QuarterMetric[];
  };
  deals: Deal[];
  invoices: { outstanding: number; outstandingCount: number; overdue: number; overdueCount: number; paidThisMonth: number; paidCount: number };
  expensesThisMonth: ExpenseLine[];
  publishing: PublishDay[];
};

export const STREAMS: Array<{ key: StreamKey; label: string }> = [
  { key: "sponsorships", label: "Sponsorships" },
  { key: "community", label: "Community" },
  { key: "products", label: "Products" },
  { key: "consulting", label: "Consulting" },
];

// Dark-surface categorical palette, validated with the dataviz six-check
// script against the card surface (#11151b): lightness band, chroma floor,
// CVD ΔE ≥ 8 adjacent, normal-vision ΔE ≥ 15, contrast ≥ 3:1. Slot 1 is the
// house orange stepped into the band. Order is the safety mechanism — never
// re-sort or cycle these.
export const SERIES = ["#d0663f", "#3987e5", "#199e70", "#c98500", "#9085e9", "#d55181"] as const;
export const STREAM_COLOR: Record<StreamKey, string> = {
  sponsorships: SERIES[0],
  community: SERIES[1],
  products: SERIES[2],
  consulting: SERIES[3],
};
export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" } as const;
export const SEQUENTIAL = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec"] as const;

const M = (
  month: string,
  label: string,
  s: number,
  c: number,
  p: number,
  k: number,
  expenses: number,
  partial?: boolean,
): MonthRow => ({ month, label, partial, income: { sponsorships: s, community: c, products: p, consulting: k }, expenses });

export const BUSINESS_SAMPLE: BusinessData = {
  generatedAt: "2026-09-05T08:00:00Z",
  accounts: [
    { name: "Operating", balance: 168_900, note: "Day-to-day" },
    { name: "Tax reserve", balance: 64_300, note: "Set aside" },
    { name: "Savings", balance: 35_220, note: "Buffer" },
  ],
  balanceHistory: (() => {
    // 90 days, a gentle climb with payroll dips and invoice jumps.
    const out: number[] = [];
    let v = 214_800;
    for (let i = 0; i < 90; i++) {
      const day = i % 30;
      if (day === 1) v -= 11_200; // team payroll
      if (day === 3) v -= 4_900; // tools + APIs
      if (day === 9 || day === 21) v += 9_000 + ((i * 37) % 7_000); // invoices land
      if (day === 15) v -= 3_800; // production
      v += ((i * 13) % 900) - 300; // community + products trickle
      out.push(Math.round(v));
    }
    // Pin the final figure to the account total so the tile and the accounts agree.
    const target = 168_900 + 64_300 + 35_220;
    const shift = target - out[out.length - 1];
    return out.map((x) => x + shift);
  })(),
  months: [
    M("2025-10", "Oct", 18_000, 11_400, 4_200, 6_000, 24_100),
    M("2025-11", "Nov", 27_000, 12_100, 3_900, 4_500, 25_300),
    M("2025-12", "Dec", 22_000, 12_800, 6_800, 3_000, 23_900),
    M("2026-01", "Jan", 31_000, 13_900, 5_100, 6_000, 26_200),
    M("2026-02", "Feb", 27_000, 14_600, 4_400, 7_500, 25_800),
    M("2026-03", "Mar", 42_000, 15_200, 5_900, 6_000, 27_400),
    M("2026-04", "Apr", 36_000, 16_100, 7_300, 9_000, 28_600),
    M("2026-05", "May", 45_000, 16_900, 6_200, 6_000, 27_900),
    M("2026-06", "Jun", 39_000, 17_800, 8_900, 12_000, 29_300),
    M("2026-07", "Jul", 54_000, 18_400, 7_600, 9_000, 30_100),
    M("2026-08", "Aug", 48_000, 19_300, 9_800, 12_000, 31_200),
    M("2026-09", "Sep", 12_000, 3_400, 1_900, 0, 6_800, true),
  ],
  quarter: {
    label: "Q3 2026",
    start: "2026-07-01",
    end: "2026-09-30",
    priority: {
      title: "Sign 6 partnership deals",
      why: "Partnerships are the stream that compounds. Six signed this quarter locks Q4 income before it starts.",
      value: 4,
      target: 6,
      unit: "deals",
    },
    metrics: [
      { key: "videos", label: "Videos published", unit: "videos", value: 9, target: 12, previous: 8, icon: "video" },
      { key: "deals", label: "Partnership deals signed", unit: "deals", value: 4, target: 6, previous: 3, icon: "handshake" },
      { key: "members", label: "New paid members", unit: "members", value: 286, target: 400, previous: 241, icon: "users" },
    ],
  },
  deals: [
    { id: "d1", partner: "Northwind Cloud", stage: "Paid", value: 27_000, close: "2026-07-14", owner: "Operator" },
    { id: "d2", partner: "Lumen Labs", stage: "Delivered", value: 24_000, close: "2026-08-02", owner: "Operator" },
    { id: "d3", partner: "Parallel Data", stage: "Signed", value: 30_000, close: "2026-08-21", owner: "Operator" },
    { id: "d4", partner: "Brightline AI", stage: "Signed", value: 18_000, close: "2026-09-01", owner: "Operator" },
    { id: "d5", partner: "Cobalt Systems", stage: "Negotiating", value: 36_000, close: "2026-09-19", owner: "Operator" },
    { id: "d6", partner: "Meridian Tools", stage: "Proposal", value: 21_000, close: "2026-09-26", owner: "Operator" },
    { id: "d7", partner: "Halcyon Robotics", stage: "Lead", value: 15_000, close: "2026-10-10", owner: "Operator" },
  ],
  invoices: {
    outstanding: 41_500,
    outstandingCount: 3,
    overdue: 12_000,
    overdueCount: 1,
    paidThisMonth: 27_000,
    paidCount: 2,
  },
  expensesThisMonth: [
    { name: "Team", amount: 11_200 },
    { name: "AI & APIs", amount: 4_850 },
    { name: "Production", amount: 3_900 },
    { name: "Software", amount: 2_340 },
    { name: "Travel", amount: 1_600 },
    { name: "Other", amount: 2_510 },
  ],
  publishing: [
    { date: "2026-06-16", views: 41_000 },
    { date: "2026-06-19", views: 88_000 },
    { date: "2026-06-24", views: 36_000 },
    { date: "2026-06-30", views: 120_000 },
    { date: "2026-07-03", views: 52_000 },
    { date: "2026-07-08", views: 61_000 },
    { date: "2026-07-14", views: 210_000 },
    { date: "2026-07-22", views: 47_000 },
    { date: "2026-07-29", views: 93_000 },
    { date: "2026-08-05", views: 58_000 },
    { date: "2026-08-12", views: 175_000 },
    { date: "2026-08-19", views: 66_000 },
    { date: "2026-08-26", views: 132_000 },
    { date: "2026-09-02", views: 44_000 },
  ],
};

// ── helpers ────────────────────────────────────────────────────────────────

export const monthTotal = (m: MonthRow): number =>
  m.income.sponsorships + m.income.community + m.income.products + m.income.consulting;

export const monthNet = (m: MonthRow): number => monthTotal(m) - m.expenses;

export function pctChange(now: number, before: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

/** Days elapsed / total for a quarter, clamped, as of `today`. */
export function quarterProgress(start: string, end: string, today = new Date()) {
  const s = new Date(start + "T00:00:00Z").getTime();
  const e = new Date(end + "T23:59:59Z").getTime();
  const t = Math.min(Math.max(today.getTime(), s), e);
  const total = Math.max(1, Math.round((e - s) / 86_400_000));
  const elapsed = Math.round((t - s) / 86_400_000);
  return { elapsed, total, left: Math.max(0, total - elapsed), fraction: elapsed / total };
}

export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}
