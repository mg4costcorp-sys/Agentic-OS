import { useState } from "react";
import { ArrowRight, CalendarDays } from "lucide-react";
import { InstrumentMark } from "./instrument-mark";
import { type Deal, type DealStage } from "@/lib/business-intel";
const STAGES: DealStage[] = ["Lead", "Proposal", "Negotiating", "Signed", "Delivered", "Paid"];
const COLORS = ["#82718f", "#ac91c4", "#d0b4ef", "#9cbdc8", "#9bcbbb", "#b3dec3"];
export function PartnershipPipeline({
  deals,
  money,
}: {
  deals: Deal[];
  money: (n: number, c?: boolean) => string;
}) {
  const [stage, setStage] = useState<DealStage | "active" | "all">("active");
  const active = deals.filter((d) => STAGES.indexOf(d.stage) < 3);
  const secured = deals.filter((d) => STAGES.indexOf(d.stage) >= 3);
  const shown =
    stage === "active" ? active : stage === "all" ? deals : deals.filter((d) => d.stage === stage);
  return (
    <section className="biz-card biz-pipeline" aria-labelledby="pipeline-title">
      <div className="biz-pipeline-heading">
        <div className="biz-title-with-mark">
          <InstrumentMark kind="partnership" />
          <div>
            <h2 id="pipeline-title">Partnership pipeline</h2>
            <p>From first conversation to money in the bank.</p>
          </div>
        </div>
        <div className="biz-pipeline-totals">
          <div>
            <strong>
              {money(
                active.reduce((s, d) => s + d.value, 0),
                true,
              )}
            </strong>
            <span>in play</span>
          </div>
          <div>
            <strong>
              {money(
                secured.reduce((s, d) => s + d.value, 0),
                true,
              )}
            </strong>
            <span>secured</span>
          </div>
        </div>
      </div>
      <div className="biz-pipeline-stages" aria-label="Filter by deal stage">
        {STAGES.map((s, i) => {
          const ds = deals.filter((d) => d.stage === s);
          return (
            <button
              key={s}
              aria-pressed={stage === s}
              onClick={() => setStage(stage === s ? "active" : s)}
              style={{ "--stage-color": COLORS[i] } as React.CSSProperties}
            >
              <span className="biz-stage-name">
                <i />
                {s}
                {i < 5 && <ArrowRight size={10} />}
              </span>
              <span className="biz-stage-value">
                {money(
                  ds.reduce((sum, d) => sum + d.value, 0),
                  true,
                )}
              </span>
              <span className="biz-stage-count">
                {ds.length} {ds.length === 1 ? "deal" : "deals"}
              </span>
            </button>
          );
        })}
      </div>
      <div className="biz-pipeline-list-heading">
        <div>
          <button aria-pressed={stage === "active"} onClick={() => setStage("active")}>
            Active deals <span>{active.length}</span>
          </button>
          <button aria-pressed={stage === "all"} onClick={() => setStage("all")}>
            All deals <span>{deals.length}</span>
          </button>
          {stage !== "active" && stage !== "all" && (
            <span className="biz-active-stage">{stage}</span>
          )}
        </div>
        <span>
          {shown.length} {shown.length === 1 ? "partnership" : "partnerships"}
        </span>
      </div>
      <div className="biz-deal-cards">
        {[...shown]
          .sort((a, b) => a.close.localeCompare(b.close))
          .map((d) => (
            <article className="biz-deal-card" key={d.id}>
              <div className="biz-deal-top">
                <span className="biz-partner-monogram">
                  {d.partner
                    .split(" ")
                    .map((w) => w[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <span
                  className="biz-deal-status"
                  style={{ color: COLORS[STAGES.indexOf(d.stage)] }}
                >
                  <i />
                  {d.stage}
                </span>
              </div>
              <h3>{d.partner}</h3>
              <strong>{money(d.value)}</strong>
              <div className="biz-deal-footer">
                <span>
                  <CalendarDays size={11} />
                  {new Intl.DateTimeFormat("en-GB", {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  }).format(new Date(d.close + "T00:00:00Z"))}
                </span>
                <span>{d.owner}</span>
              </div>
            </article>
          ))}
      </div>
      {!shown.length && <div className="biz-empty-state">No partnerships at this stage yet.</div>}
    </section>
  );
}
