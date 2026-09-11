import { useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { InstrumentMark } from "./instrument-mark";
import { publishedInQuarter, type BusinessVideo } from "@/lib/business-videos";
import { BUSINESS_SAMPLE } from "@/lib/business-intel";

export function PublishingTracker({
  videos,
  ready,
  updateVideo,
  addVideo,
  storageStatus,
}: {
  videos: BusinessVideo[];
  ready: boolean;
  updateVideo: (id: string, patch: Partial<Omit<BusinessVideo, "id">>) => void;
  addVideo: (title: string, date: string) => void;
  storageStatus: string;
}) {
  const [filter, setFilter] = useState<"all" | "planned" | "published">("all");
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(BUSINESS_SAMPLE.generatedAt.slice(0, 10));
  const published = videos.filter((v) => v.published).length;
  const quarter = publishedInQuarter(
    videos,
    BUSINESS_SAMPLE.quarter.start,
    BUSINESS_SAMPLE.quarter.end,
  );
  const target = BUSINESS_SAMPLE.quarter.metrics.find((m) => m.key === "videos")!.target;
  const filtered = [...videos]
    .filter((v) => filter === "all" || (filter === "published" ? v.published : !v.published))
    .sort((a, b) => Number(a.published) - Number(b.published) || b.date.localeCompare(a.date));
  const shown = showAll ? filtered : filtered.slice(0, 5);
  return (
    <section className="biz-card biz-publishing" aria-labelledby="publishing-title">
      <div className="biz-publishing-heading">
        <div className="biz-title-with-mark">
          <InstrumentMark kind="video" tone="mint" />
          <div>
            <h2 id="publishing-title">One video at a time.</h2>
            <p>Tick it when it’s published. Your count follows.</p>
          </div>
        </div>
        <button
          className="biz-soft-button"
          disabled={!ready || videos.length >= 500}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? <X size={13} /> : <Plus size={13} />} {adding ? "Cancel" : "Add video"}
        </button>
      </div>
      <div className="biz-publishing-summary">
        <div>
          <strong>{published}</strong>
          <span>published in your tracker</span>
        </div>
        <div className="biz-quarter-checks">
          <span>
            <b>{quarter}</b> / {target} this quarter
          </span>
          <div role="img" aria-label={`${quarter} of ${target} videos published this quarter`}>
            {Array.from({ length: target }, (_, i) => (
              <span key={i} className={i < quarter ? "is-done" : ""}>
                {i < quarter ? <Check size={11} /> : <i />}
              </span>
            ))}
          </div>
        </div>
      </div>
      {adding && (
        <form
          className="biz-add-video"
          onSubmit={(e) => {
            e.preventDefault();
            addVideo(title, date);
            setTitle("");
            setAdding(false);
            setFilter("planned");
            setShowAll(false);
          }}
        >
          <label className="sr-only" htmlFor="new-video-title">
            Video title
          </label>
          <input
            id="new-video-title"
            value={title}
            maxLength={160}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you making?"
            required
            autoFocus
          />
          <label className="sr-only" htmlFor="new-video-date">
            Publish date
          </label>
          <input
            id="new-video-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <button className="biz-soft-button" type="submit" disabled={!title.trim()}>
            Add to tracker
          </button>
        </form>
      )}
      <div className="biz-publishing-filter" aria-label="Filter videos">
        {(
          [
            { key: "all", label: "All videos", n: videos.length },
            { key: "planned", label: "To publish", n: videos.length - published },
            { key: "published", label: "Published", n: published },
          ] as const
        ).map((f) => (
          <button
            key={f.key}
            aria-pressed={filter === f.key}
            onClick={() => {
              setFilter(f.key);
              setShowAll(false);
            }}
          >
            {f.label}
            <span>{f.n}</span>
          </button>
        ))}
      </div>
      <div className="biz-video-list">
        {shown.map((video) => (
          <div className={`biz-video-row${video.published ? " is-published" : ""}`} key={video.id}>
            <label className="biz-video-check">
              <input
                type="checkbox"
                checked={video.published}
                disabled={!ready}
                onChange={(e) => updateVideo(video.id, { published: e.target.checked })}
                aria-label={`Published: ${video.title}`}
              />
              <span aria-hidden="true">{video.published ? <Check size={14} /> : null}</span>
            </label>
            <div className="biz-video-name">
              <input
                value={video.title}
                maxLength={160}
                disabled={!ready}
                aria-label={`Title for ${video.title}`}
                onChange={(e) => updateVideo(video.id, { title: e.target.value })}
                onBlur={(e) => {
                  if (!e.target.value.trim()) updateVideo(video.id, { title: "Untitled video" });
                }}
              />
              <span>{video.published ? "Published" : "Ready when you are"}</span>
            </div>
            <input
              className="biz-video-date"
              type="date"
              value={video.date}
              disabled={!ready}
              aria-label={`Publish date for ${video.title}`}
              onChange={(e) => {
                if (e.target.value) updateVideo(video.id, { date: e.target.value });
              }}
            />
          </div>
        ))}
      </div>
      {!shown.length && (
        <div className="biz-empty-state">
          {filter === "planned"
            ? "Nothing waiting to publish. Add your next idea above."
            : "No videos here yet. Add your first one above."}
        </div>
      )}
      <div className="biz-tracker-footer">
        <span role="status">{storageStatus}</span>
        {filtered.length > 5 && (
          <button className="biz-text-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${filtered.length}`}
            <ChevronDown size={13} style={{ transform: showAll ? "rotate(180deg)" : undefined }} />
          </button>
        )}
      </div>
    </section>
  );
}
