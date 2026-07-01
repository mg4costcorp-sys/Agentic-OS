// Time-saved estimates per skill (minutes saved per invocation).
// Persisted in localStorage so the user can tune them across all projects.

import { useEffect, useState } from "react";
import { skills } from "@/lib/mock-data";

const STORAGE_KEY = "claude-os.time-saved.v1";
const RATE_KEY = "claude-os.hourly-rate.v1";

// Skills get a defensible default minutes-per-run so the dashboard
// shows realistic value on first paint. The user can override any of
// these via the UI — the defaults exist so a fresh install demonstrates
// the value model rather than greeting everyone with "$0 saved".

export const DEFAULT_RATE = 120; // $/hour

// Per-skill default minutes-per-run. Picked from honest, defensible
// estimates of how long the same task would take WITHOUT the skill —
// not inflated. Match priority: prefix match → generic fallback.
const SKILL_MINUTE_DEFAULTS: Array<[RegExp, number]> = [
  // Long-form synthesis / generation
  [/^\/?html-presentation\b/i, 30],
  [/^\/?infographic-generator\b/i, 20],
  [/^\/?dream\b/i, 15],
  [/^\/?notebooklm\b/i, 18],
  [/^\/?wrapup\b/i, 12],
  [/^\/?community-post-creator\b/i, 15],
  // Persona / agent ops
  [/^\/?personas\b/i, 10],
  [/^\/?goal\b/i, 8],
  [/^\/?obsidian\b/i, 7],
  [/^\/?recall\b/i, 6],
  [/^\/?pinecone-memory\b/i, 6],
  // Image / video gen
  [/^\/?higgsfield\b/i, 12],
  [/^\/?seed-dance\b/i, 12],
  [/^\/?scroll-stop-prompter\b/i, 8],
  // Quick utilities
  [/^\/?bitly\b/i, 1],
  [/^\/?yt-transcript\b/i, 3],
];

const GENERIC_DEFAULT_MINUTES = 5;

export function getDefaultMinutes(name: string): number {
  if (!name) return GENERIC_DEFAULT_MINUTES;
  for (const [pattern, mins] of SKILL_MINUTE_DEFAULTS) {
    if (pattern.test(name)) return mins;
  }
  return GENERIC_DEFAULT_MINUTES;
}

function loadMinutes(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadRate(): number {
  if (typeof window === "undefined") return DEFAULT_RATE;
  try {
    const raw = window.localStorage.getItem(RATE_KEY);
    return raw ? Number(raw) || DEFAULT_RATE : DEFAULT_RATE;
  } catch {
    return DEFAULT_RATE;
  }
}

export function useTimeSaved() {
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const [rate, setRateState] = useState<number>(DEFAULT_RATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setMinutes(loadMinutes());
    setRateState(loadRate());
    setHydrated(true);
  }, []);

  const minutesFor = (name: string) => minutes[name] ?? getDefaultMinutes(name);

  /** True if the user has explicitly set minutes for this skill */
  const isConfigured = (name: string) => name in minutes;

  const setMinutesFor = (name: string, value: number) => {
    const next = { ...minutes, [name]: Math.max(0, Math.round(value)) };
    setMinutes(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  };

  const setRate = (value: number) => {
    const v = Math.max(0, Math.round(value));
    setRateState(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RATE_KEY, String(v));
    }
  };

  const resetAll = () => {
    setMinutes({});
    setRateState(DEFAULT_RATE);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(RATE_KEY);
    }
  };

  return { minutesFor, setMinutesFor, isConfigured, rate, setRate, resetAll, hydrated };
}

export type Period = "day" | "week" | "month";

// Derive runs in a given period from the 7d "uses" counter.
export function runsIn(uses7d: number, period: Period) {
  const perDay = uses7d / 7;
  if (period === "day") return perDay;
  if (period === "week") return uses7d;
  return perDay * 30;
}

export function formatHours(mins: number) {
  if (mins <= 0) return "0m";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function totals(minutesFor: (name: string) => number, rate: number, period: Period) {
  let mins = 0;
  for (const s of skills) {
    mins += minutesFor(s.name) * runsIn(s.uses, period);
  }
  return { minutes: mins, dollars: (mins / 60) * rate };
}
