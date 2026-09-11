import { useEffect, useState } from "react";
import { BUSINESS_SAMPLE } from "@/lib/business-intel";
export interface BusinessVideo {
  id: string;
  title: string;
  date: string;
  published: boolean;
  views?: number;
}
export const VIDEO_STORAGE_KEY = "claude-os.business.videos.v1";
export const INITIAL_VIDEOS: BusinessVideo[] = BUSINESS_SAMPLE.publishing.map((day, i) => ({
  id: `sample-video-${i + 1}`,
  title: `Video ${String(i + 1).padStart(2, "0")}`,
  date: day.date,
  published: true,
  views: day.views,
}));
export function parseVideos(raw: string): BusinessVideo[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 500) return null;
    const ids = new Set<string>();
    for (const entry of value) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        ids.has(entry.id) ||
        typeof entry.title !== "string" ||
        entry.title.length > 160 ||
        typeof entry.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
        !Number.isFinite(Date.parse(entry.date)) ||
        new Date(entry.date).toISOString().slice(0, 10) !== entry.date ||
        typeof entry.published !== "boolean" ||
        (entry.views !== undefined &&
          (typeof entry.views !== "number" || !Number.isFinite(entry.views) || entry.views < 0))
      )
        return null;
      ids.add(entry.id);
    }
    return value as BusinessVideo[];
  } catch {
    return null;
  }
}
export function publishedInQuarter(videos: BusinessVideo[], start: string, end: string) {
  return videos.filter((v) => v.published && v.date >= start && v.date <= end).length;
}
export function useBusinessVideos() {
  const [videos, setVideos] = useState(INITIAL_VIDEOS);
  const [ready, setReady] = useState(false);
  const [persist, setPersist] = useState(true);
  const [storageStatus, setStorageStatus] = useState("Loading tracker…");
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VIDEO_STORAGE_KEY);
      if (raw !== null) {
        const restored = parseVideos(raw);
        if (!restored) throw new Error("Invalid tracker");
        setVideos(restored);
      }
    } catch {
      setPersist(false);
      setStorageStatus("This session only. Saved tracker could not be loaded.");
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready || !persist) return;
    try {
      window.localStorage.setItem(VIDEO_STORAGE_KEY, JSON.stringify(videos));
      setStorageStatus("Saved in this browser");
    } catch {
      setPersist(false);
      setStorageStatus("This session only. Browser storage is unavailable.");
    }
  }, [videos, ready, persist]);
  const updateVideo = (id: string, patch: Partial<Omit<BusinessVideo, "id">>) =>
    setVideos((current) => current.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const addVideo = (title: string, date: string) => {
    if (!ready || !title.trim() || videos.length >= 500) return;
    setVideos((current) => [
      ...current,
      { id: crypto.randomUUID(), title: title.trim().slice(0, 160), date, published: false },
    ]);
  };
  return { videos, ready, updateVideo, addVideo, storageStatus };
}
