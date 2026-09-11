import { Landmark, Clapperboard, Handshake, ReceiptText, Sparkles } from "lucide-react";

const icons = {
  bank: Landmark,
  video: Clapperboard,
  partnership: Handshake,
  invoice: ReceiptText,
  chat: Sparkles,
};
export function InstrumentMark({
  kind,
  tone = "lilac",
  small = false,
}: {
  kind: keyof typeof icons;
  tone?: "lilac" | "mint" | "amber";
  small?: boolean;
}) {
  const Icon = icons[kind];
  return (
    <span
      className={`biz-instrument-mark tone-${tone}${small ? " is-small" : ""}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48">
        <circle
          cx="24"
          cy="24"
          r="21"
          fill="none"
          stroke="currentColor"
          strokeOpacity=".18"
          strokeWidth="1"
        />
        <circle
          cx="24"
          cy="24"
          r="21"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="31 8 9 85"
          transform="rotate(-105 24 24)"
        />
        <circle cx="24" cy="24" r="16" fill="currentColor" fillOpacity=".06" />
      </svg>
      <Icon size={small ? 13 : 18} strokeWidth={1.4} />
    </span>
  );
}
