/**
 * ContextBreakdown — what is actually sitting in the model's context window,
 * broken out by category, the way Claude Code's own /context does it.
 *
 * Honesty rules this component follows, because the numbers are the product:
 *  • The context WINDOW is real — resolved per-model from the live OpenRouter
 *    catalog, falling back to the shared CTX_TABLE.
 *  • "Memory files", "Skills" and "Custom agents" are sized from REAL character
 *    counts the dev server read off disk; only chars→tokens is estimated.
 *  • "System prompt + tools" is not guessed either: once the harness reports a
 *    turn's usage, it's the residual of the API's OWN prompt-token count after
 *    subtracting everything we measured. Before the first reply it reads "—".
 *  • Tool and MCP inventories are listed by NAME with counts. The CLI never
 *    reports per-schema sizes, so this component never invents one.
 *  • Everything derived from chars is marked estimated, in the panel footer.
 */
import { useState } from "react";
import { C_HARNESS, estTokens, fmtCtxTokens, type CtxBreakdown } from "@/lib/ctx-window";

const CREAM = "#FFE6CB";
const HAIR = "rgba(255,230,203,0.14)";
/**
 * The ONE secondary-text value in this panel.
 *
 * It shipped with five (.35 / .40 / .42 / .45 / .50), which is both arbitrary
 * and, below .50, illegible: measured in the browser against the panel's own
 * composited background (#061817), α.35 → 3.0:1, α.40 → 3.35:1, α.42 → 3.58:1,
 * α.45 → 3.93:1 — all under the 4.5:1 WCAG AA floor for body text. α.55 →
 * 5.25:1, with the primary CREAM still at ~13:1, so the hierarchy is intact and
 * every row is actually readable.
 */
const DIM = "rgba(255,230,203,0.55)";

// ── Presentation ───────────────────────────────────────────────────────────

function Row({
  color,
  label,
  right,
  sub,
  dim,
}: {
  color?: string;
  label: string;
  right: string;
  sub?: string;
  dim?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2" style={{ padding: "2.5px 0" }}>
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          flexShrink: 0,
          borderRadius: 2,
          alignSelf: "center",
          background: color ?? "transparent",
          border: color ? "none" : `1px solid ${HAIR}`,
        }}
      />
      <span
        className="truncate"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          color: dim ? DIM : "rgba(255,230,203,0.8)",
        }}
      >
        {label}
      </span>
      <span
        className="hermes-mono"
        style={{
          fontSize: 10.5,
          color: dim ? DIM : CREAM,
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
          minWidth: 46,
        }}
      >
        {right}
      </span>
      <span
        className="hermes-mono"
        style={{
          fontSize: 10.5,
          color: DIM,
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
          minWidth: 40,
        }}
      >
        {sub ?? ""}
      </span>
    </div>
  );
}

/** A row that opens into a detail list, animated open/closed. */
function Expandable({
  label,
  right,
  sub,
  children,
  count,
}: {
  label: string;
  right: string;
  sub?: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 text-left"
        style={{ padding: "2.5px 0" }}
        aria-expanded={open}
      >
        <span
          aria-hidden
          className="hermes-mono"
          style={{
            width: 8,
            flexShrink: 0,
            fontSize: 9,
            color: DIM,
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .18s ease",
          }}
        >
          ▸
        </span>
        <span
          className="truncate"
          style={{ flex: 1, minWidth: 0, fontSize: 11, color: "rgba(255,230,203,0.8)" }}
        >
          {label}
        </span>
        <span
          className="hermes-mono"
          style={{
            fontSize: 10.5,
            color: CREAM,
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
            minWidth: 46,
          }}
        >
          {right}
        </span>
        <span
          className="hermes-mono"
          style={{
            fontSize: 10.5,
            color: DIM,
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
            minWidth: 40,
          }}
        >
          {sub ?? ""}
        </span>
      </button>
      {/* 0fr → 1fr grid trick: animates to the content's real height with no
          measuring and no layout thrash. */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows .22s ease",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div
            style={{
              margin: "3px 0 6px 18px",
              paddingLeft: 8,
              borderLeft: `1px solid ${HAIR}`,
              maxHeight: 168,
              overflowY: "auto",
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Paths are informative at the END — clip the head, not the filename. */
function clipHead(s: string, max = 34): string {
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`;
}

function DetailLine({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-baseline gap-2" style={{ padding: "1.5px 0" }}>
      <span
        className="hermes-mono truncate"
        style={{ flex: 1, minWidth: 0, fontSize: 10, color: "rgba(255,230,203,0.6)" }}
        title={left}
      >
        {clipHead(left)}
      </span>
      <span
        className="hermes-mono"
        style={{
          fontSize: 10,
          color: DIM,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}
      >
        {right}
      </span>
    </div>
  );
}

export function ContextBreakdown({
  breakdown,
  modelLabel,
  compactAt,
}: {
  breakdown: CtxBreakdown;
  modelLabel: string;
  /** fraction of the window at which the harness auto-compacts, if it does */
  compactAt?: number;
}) {
  const { slices, free, used, limit, reported } = breakdown;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const pctOf = (n: number) => (limit > 0 ? (n / limit) * 100 : 0);
  const mcpToolCount = breakdown.mcpByServer.reduce((a, s) => a + s.tools.length, 0);
  const waiting = reported === null;

  return (
    <div style={{ fontVariantNumeric: "tabular-nums" }}>
      {/* header — category, headline number, window */}
      <div className="flex items-baseline justify-between" style={{ marginBottom: 7 }}>
        <span
          className="hermes-mono"
          style={{
            fontSize: 9,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: DIM,
          }}
        >
          Context window
        </span>
        <span className="hermes-mono" style={{ fontSize: 15, color: CREAM, lineHeight: 1 }}>
          {fmtCtxTokens(used)}
          <span style={{ fontSize: 10, color: DIM }}>
            {" "}
            / {fmtCtxTokens(limit)}
          </span>
        </span>
      </div>

      {/* one continuous bar, segments in category order */}
      <div
        className="relative flex w-full overflow-hidden"
        style={{ height: 9, borderRadius: 5, background: "rgba(255,230,203,0.1)" }}
        role="img"
        aria-label={`${Math.round(pct)}% of the context window used`}
      >
        {slices.map((s) => (
          <div
            key={s.key}
            title={`${s.label} · ${fmtCtxTokens(s.tokens)}`}
            style={{
              width: `${pctOf(s.tokens)}%`,
              background: s.color,
              transition: "width .3s ease",
            }}
          />
        ))}
        {typeof compactAt === "number" && (
          <div
            className="absolute inset-y-0 w-px"
            style={{ left: `${compactAt * 100}%`, background: "rgba(255,157,143,0.9)" }}
            title={`Auto-compacts around ${fmtCtxTokens(limit * compactAt)}`}
          />
        )}
      </div>
      <div
        className="hermes-mono"
        style={{ fontSize: 9, color: DIM, margin: "5px 0 7px" }}
      >
        {modelLabel}
        {typeof compactAt === "number"
          ? ` · auto-compacts ≈${fmtCtxTokens(limit * compactAt)}`
          : ""}
      </div>

      {/* sized rows */}
      {slices.map((s) => {
        if (s.key === "memory")
          return (
            <Expandable
              key={s.key}
              label="Memory files"
              right={fmtCtxTokens(s.tokens)}
              sub={`${pctOf(s.tokens).toFixed(1)}%`}
              count={breakdown.memoryFiles.length}
            >
              {breakdown.memoryFiles.map((f) => (
                <DetailLine key={f.label} left={f.label} right={fmtCtxTokens(estTokens(f.chars))} />
              ))}
            </Expandable>
          );
        return (
          <Row
            key={s.key}
            color={s.color}
            label={s.label}
            right={fmtCtxTokens(s.tokens)}
            sub={`${pctOf(s.tokens).toFixed(1)}%`}
          />
        );
      })}
      {waiting && <Row color={C_HARNESS} label="System prompt + tools" right="—" sub="" dim />}
      <Row label="Free space" right={fmtCtxTokens(free)} sub={`${pctOf(free).toFixed(1)}%`} dim />

      {/* inventory — what's resident, by name. No invented token figures. */}
      {(breakdown.systemTools.length > 0 || mcpToolCount > 0) && (
        <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${HAIR}` }}>
          <div
            className="hermes-mono"
            style={{
              fontSize: 8.5,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: DIM,
              marginBottom: 3,
            }}
          >
            Also resident · inside system prompt + tools
          </div>
          <Expandable
            label="System tools"
            right={`${breakdown.systemTools.length}`}
            count={breakdown.systemTools.length}
          >
            {breakdown.systemTools.map((t) => (
              <DetailLine key={t} left={t} right="" />
            ))}
          </Expandable>
          <Expandable label="MCP tools" right={`${mcpToolCount}`} count={mcpToolCount}>
            {breakdown.mcpByServer.map((s) => (
              <DetailLine key={s.server} left={s.server} right={`${s.tools.length}`} />
            ))}
          </Expandable>
          <Expandable
            label="Slash commands"
            right={`${breakdown.slashCommands.length}`}
            count={breakdown.slashCommands.length}
          >
            {breakdown.slashCommands.map((c) => (
              <DetailLine key={c} left={`/${c}`} right="" />
            ))}
          </Expandable>
        </div>
      )}

      <div
        className="hermes-mono"
        style={{
          fontSize: 8.5,
          lineHeight: 1.55,
          color: DIM,
          marginTop: 8,
          paddingTop: 7,
          borderTop: `1px solid ${HAIR}`,
        }}
      >
        {reported === null
          ? breakdown.unreportedLane
            ? // Different sentence from "no turn yet": the lane answered and
              // then reported no usage at all, which is what happens when its
              // last provider call errors. Saying which lane is the difference
              // between a shrug and a lead.
              `Estimated — the ${breakdown.unreportedLane} lane reported no token count for the last turn, so every row here is chars ÷ 4, not a real tokenizer.`
            : "Estimated — token counts are chars ÷ 4, not a real tokenizer. Send a message and the harness reports its own count."
          : `Estimated split of a real total — the harness's last API call carried ${fmtCtxTokens(
              reported,
            )} prompt tokens; the per-row split is chars ÷ 4, not a real tokenizer.`}
      </div>
    </div>
  );
}
