import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Image as ImageIcon,
  ImagePlus,
  Film,
  Search,
  X,
  Copy,
  Check,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Plus,
  ChevronDown,
  Download,
  Wand2,
  Palette,
  Trash2,
  Pin,
  PanelTop,
  PanelBottom,
  Save,
  KeyRound,
  Terminal,
  Settings2,
  WalletCards,
  ScanSearch,
  Maximize2,
  Minimize2,
  Eye,
  BarChart3,
  Pencil,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import claudeLogo from "@/assets/claude-logo.png";
import hermesLogo from "@/assets/hermes-agent.png";
import { BRANDS, BrandMark, brandForModel, MODEL_BLURBS } from "@/components/design-brands";

export const Route = createFileRoute("/design")({
  component: DesignStudio,
  head: () => ({
    meta: [
      { title: "Design — Claude Code OS" },
      { name: "description", content: "Every engine you have, one box, one gallery." },
    ],
  }),
});

// ── types ──────────────────────────────────────────────────────────────────

type MediaItem = {
  id: string;
  /** Real path with this machine's native separators — used verbatim for Copy path. */
  path: string;
  name: string;
  ext: string;
  kind: "image" | "video";
  bytes: number;
  mtime: number;
  project: string;
  root: string;
};

type RootStatus = { root: string; found: number; error: string | null };

type MediaResponse = {
  ok: boolean;
  roots: string[];
  rootStatus?: RootStatus[];
  permHint?: string;
  total: number;
  returned: number;
  truncated: boolean;
  scanCapped: boolean;
  projects: Array<{ name: string; count: number }>;
  items: MediaItem[];
  error?: string;
};

type AgentId = "claude" | "hermes" | "studio";

type LedgerItem = {
  id: string;
  path: string;
  name: string;
  agent: AgentId;
  tool: string | null;
  kind: "image" | "video";
  ts: number;
  bytes: number;
  mtime: number;
  alive: boolean;
  session: string | null;
  cwd: string | null;
  prompt: string | null;
  backfill: boolean;
  model: string | null;
  look?: string | null;
  params?: Record<string, unknown>;
  w?: number | null;
  h?: number | null;
  costUsd?: number | null;
  costCredits?: number | null;
  costSource?: "reported" | "estimate" | "live_quote" | null;
  jobId?: string | null;
  references?: Array<{
    id: string;
    path: string;
    name: string;
    alive: boolean;
  }>;
};

type LedgerResponse = {
  ok: boolean;
  ledger: string;
  armed: boolean;
  total: number;
  byAgent: { claude: number; hermes: number; studio: number };
  items: LedgerItem[];
  error?: string;
};

type GenerationJob = {
  id: string;
  total: number;
  prompt: string;
  engine: string;
  engineLabel: string;
  model: string;
  modelLabel: string;
  kind: "image" | "video";
  startedAt: number;
  status: "running" | "cancelling";
};

type GenerationJobWithProgress = GenerationJob & { completed: number };

type ParamSpec = {
  name: string;
  type: "string" | "integer" | "boolean";
  default: unknown;
  required: boolean;
  enum?: string[];
};

type PriceLine = {
  billable: string;
  unit: string;
  costUsd: number;
  variant?: string | null;
  provider?: string | null;
};

type EngineModel = {
  id: string;
  label: string;
  kind: "image" | "video";
  perUnit: number | null;
  pricing?: PriceLine[];
  pricingSource?: "live" | "estimate" | "unavailable";
};

type Engine = {
  id: string;
  label: string;
  auth: "key" | "cli";
  configured: boolean;
  tail: string | null;
  source?: "settings" | "environment" | "key_file" | "cli" | null;
  models: EngineModel[];
};

type Look = { id: string; label: string; hint: string };

type ProvidersResponse = { ok: boolean; engines: Engine[]; looks: Look[]; error?: string };

type ProviderBalance = {
  ok: boolean;
  engine: string;
  amount: number;
  unit: "credits" | "usd";
  plan?: string | null;
  error?: string;
};

type SearchHit = { id: string; path: string; desc: string; why: string; score: number };
type SearchResult = { query: string; hits: SearchHit[] };

type DesignIndexStatus = {
  ok: boolean;
  indexed: number;
  ocrIndexed: number;
  visionIndexed: number;
  visionEstimate?: {
    eligible: number;
    pending: number;
    estimatedUsd: number;
    perImageUsd: number;
    estimatedProcessedUsd: number;
    trackedUsd: number;
    trackedImages: number;
  };
  ocrAvailable: boolean;
  available?: boolean;
  model?: string;
  job: {
    running: boolean;
    done: number;
    total: number;
    failed: number;
    spentUsd?: number;
    mode: "ocr" | "vision";
  } | null;
};

// ── shared bits ────────────────────────────────────────────────────────────

const fileUrl = (id: string) => `/__design_file?id=${encodeURIComponent(id)}`;

async function moveDesignItemToTrash(id: string): Promise<void> {
  const token = (await (await fetch("/__token")).json()).token as string;
  const response = await fetch("/__design_trash", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify({ id }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "Could not move this file to Trash");
}

const AGENT: Record<AgentId, { label: string; tone: string; logo: string | null }> = {
  claude: { label: "Claude", tone: "#D97757", logo: claudeLogo },
  hermes: { label: "Hermes", tone: "#FFD21E", logo: hermesLogo },
  // Studio = generated right here in the OS, on the user's own key.
  studio: { label: "Studio", tone: "#a78bfa", logo: null },
};

const ENGINE_HINT: Record<string, { hint: string; keyHint: string }> = {
  higgsfield: { hint: "Cinematic image + video, 56 models via its CLI", keyHint: "" },
  kie: { hint: "Nano Banana 2 images · Seedance 2.0 video", keyHint: "Kie.ai API key" },
  openrouter: { hint: "Every image model one key serves", keyHint: "OpenRouter API key (sk-or-…)" },
  openai: { hint: "GPT Image 2", keyHint: "OpenAI API key (sk-…)" },
  fal: { hint: "FLUX and friends, serverless", keyHint: "fal key (id:secret)" },
  replicate: { hint: "Any public Replicate model", keyHint: "Replicate token (r8_…)" },
};

const ENGINE_SETUP: Record<
  string,
  { eyebrow: string; detail: string; command?: string; href?: string }
> = {
  higgsfield: {
    eyebrow: "CLI connection",
    detail:
      "Design uses the account already authenticated in the Higgsfield CLI. No key is copied into this app.",
    command: "higgsfield auth login",
  },
  kie: {
    eyebrow: "API key",
    detail: "Connect one Kie.ai key for Nano Banana images and Seedance video.",
    href: "https://kie.ai/api-key",
  },
  openrouter: {
    eyebrow: "API key · live image catalogue",
    detail:
      "Yes, OpenRouter serves images. Design reads its dedicated Image API, live model catalogue and endpoint pricing.",
    href: "https://openrouter.ai/settings/keys",
  },
  openai: {
    eyebrow: "API key",
    detail: "Connect an OpenAI project key to use GPT Image directly.",
    href: "https://platform.openai.com/api-keys",
  },
  fal: {
    eyebrow: "API key",
    detail: "Connect a fal key to run supported image models on fal infrastructure.",
    href: "https://fal.ai/dashboard/keys",
  },
  replicate: {
    eyebrow: "API token",
    detail: "Connect a Replicate token to run the models exposed in Design.",
    href: "https://replicate.com/account/api-tokens",
  },
};

function compactUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (value >= 0.0001) return `$${value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toPrecision(2)}`;
}

function outputPriceLines(model: EngineModel | null): PriceLine[] {
  return (model?.pricing ?? []).filter((line) => line.billable === "output_image");
}

function videoPriceLines(model: EngineModel | null): PriceLine[] {
  return (model?.pricing ?? []).filter((line) => line.billable === "output_video");
}

function compactModelLabel(model: EngineModel | null): string {
  if (!model) return "Choose model";
  const id = model.id.toLowerCase();
  if (id.includes("gemini-3.1-flash-lite-image")) return "Nano Banana 2 Lite";
  if (id.includes("gemini-3.1-flash-image")) return "Nano Banana 2";
  if (id.includes("gemini-3-pro-image")) return "Nano Banana Pro";
  return model.label.replace(/\s*\([^)]*\)\s*$/, "");
}

function modelRateLabel(model: EngineModel | null): string {
  if (!model) return "Price unavailable";
  const lines = outputPriceLines(model);
  const imageRates = lines.filter((line) => line.unit === "image");
  if (imageRates.length) {
    const values = [...new Set(imageRates.map((line) => line.costUsd))].sort((a, b) => a - b);
    return `${values.length > 1 ? "from " : ""}${compactUsd(values[0])} / image`;
  }
  const tokenRate = lines.find((line) => line.unit === "token");
  const id = model.id.toLowerCase();
  if (tokenRate && /gpt[-_]?image[-_]?2/.test(id)) return "from $0.005 / image";
  if (tokenRate && id.includes("gemini-3.1-flash-image")) {
    // Nano Banana 2 uses 1,120 output tokens at both 1K and 2K.
    return `from ≈${compactUsd(tokenRate.costUsd * 1_120)} / image`;
  }
  if (tokenRate) return "Usage based";
  const mpRate = lines.find((line) => line.unit === "megapixel");
  if (mpRate) return `${compactUsd(mpRate.costUsd)} / MP`;
  const videoLines = videoPriceLines(model);
  const secondRates = videoLines.filter((line) => line.unit === "second");
  if (secondRates.length) {
    const values = [...new Set(secondRates.map((line) => line.costUsd))].sort((a, b) => a - b);
    return `${values.length > 1 ? "from " : ""}${compactUsd(values[0])} / second`;
  }
  const videoRates = videoLines.filter((line) => line.unit === "video");
  if (videoRates.length) {
    const values = [...new Set(videoRates.map((line) => line.costUsd))].sort((a, b) => a - b);
    return `${values.length > 1 ? "from " : ""}${compactUsd(values[0])} / video`;
  }
  if (model.perUnit !== null) return `≈${compactUsd(model.perUnit)} / output`;
  return "TBC";
}

function modelRateDetail(model: EngineModel): string {
  const tokenRate = outputPriceLines(model).find((line) => line.unit === "token");
  if (!tokenRate) return modelRateLabel(model);
  const rawRate = `${compactUsd(tokenRate.costUsd * 1_000_000)} per 1M output tokens`;
  if (/gpt[-_]?image[-_]?2/.test(model.id.toLowerCase())) {
    return `About $0.005 to $0.211 per image at common sizes and quality settings. ${rawRate}.`;
  }
  if (model.id.toLowerCase().includes("gemini-3.1-flash-image")) {
    return `About ${compactUsd(tokenRate.costUsd * 1_120)} at 1K or 2K. ${rawRate}.`;
  }
  return rawRate;
}

function usdGenerationEstimate(
  model: EngineModel | null,
  count: number,
  values: Record<string, unknown>,
): { label: string; detail: string; perOutput: number } | null {
  if (!model) return null;
  const resolution = String(values.resolution ?? values.size ?? "").toLowerCase();
  const imageRates = outputPriceLines(model).filter((line) => line.unit === "image");
  if (imageRates.length) {
    const quality = String(values.quality ?? "").toLowerCase();
    const imageTier = resolution || (quality === "high" ? "2k" : quality === "basic" ? "1k" : "");
    const exact = imageTier
      ? imageRates.filter((line) => line.variant?.toLowerCase().includes(imageTier))
      : [];
    const candidates = exact.length ? exact : imageRates;
    const perOutput = Math.min(...candidates.map((line) => line.costUsd));
    const from = !exact.length && new Set(imageRates.map((line) => line.costUsd)).size > 1;
    return {
      label: `${from ? "from " : ""}${compactUsd(perOutput * count)}`,
      detail: `${compactUsd(perOutput)} per output${from ? " at the lowest available tier" : ""}`,
      perOutput,
    };
  }

  const allVideoRates = videoPriceLines(model);
  if (allVideoRates.length) {
    const duration = Math.max(1, Number(values.duration) || 5);
    const matchingTier = resolution
      ? allVideoRates.filter((line) => line.variant?.toLowerCase().includes(resolution))
      : [];
    const candidates = matchingTier.length ? matchingTier : allVideoRates;
    const perSecond = candidates.filter((line) => line.unit === "second");
    if (perSecond.length) {
      const rate = Math.min(...perSecond.map((line) => line.costUsd));
      const perOutput = rate * duration;
      return {
        label: `≈${compactUsd(perOutput * count)}`,
        detail: `${compactUsd(rate)} per second × ${duration}s per output`,
        perOutput,
      };
    }
    const perVideo = candidates.filter((line) => line.unit === "video");
    if (perVideo.length) {
      const perOutput = Math.min(...perVideo.map((line) => line.costUsd));
      const from = !matchingTier.length && new Set(perVideo.map((line) => line.costUsd)).size > 1;
      return {
        label: `${from ? "from " : ""}${compactUsd(perOutput * count)}`,
        detail: `${compactUsd(perOutput)} per video${from ? " at the lowest available tier" : ""}`,
        perOutput,
      };
    }
  }

  const tokenRate = outputPriceLines(model).find((line) => line.unit === "token");
  const id = model.id.toLowerCase();
  if (tokenRate && id.includes("gemini-3.1-flash-image")) {
    const outputTokens = resolution === "4k" ? 2_240 : 1_120;
    const perOutput = tokenRate.costUsd * outputTokens;
    return {
      label: `≈${compactUsd(perOutput * count)}`,
      detail: `Estimated from ${outputTokens.toLocaleString()} output tokens per image`,
      perOutput,
    };
  }
  if (tokenRate && /gpt[-_]?image[-_]?2/.test(id)) {
    const floor = 0.005 * count;
    return {
      label: `from ${compactUsd(floor)}`,
      detail: "Final cost changes with image size and quality",
      perOutput: 0.005,
    };
  }
  if (model.perUnit !== null) {
    return {
      label: `≈${compactUsd(model.perUnit * count)}`,
      detail: `${compactUsd(model.perUnit)} per output`,
      perOutput: model.perUnit,
    };
  }
  return null;
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

const PARAM_LABEL: Record<string, string> = {
  resolution: "Quality",
  aspect_ratio: "Ratio",
  image_size: "Ratio",
  quality: "Effort",
  thinking: "Thinking",
  mode: "Mode",
  genre: "Genre",
  duration: "Seconds",
  bitrate_mode: "Bitrate",
  generate_audio: "Audio",
  output_format: "Format",
};

function isNanoBananaModel(modelId?: string | null): boolean {
  const id = (modelId ?? "").toLowerCase();
  return (
    id.includes("nano-banana") ||
    id.includes("nano_banana") ||
    (id.includes("gemini-") && id.includes("image"))
  );
}

function visibleParamOptions(spec: ParamSpec, modelId?: string | null): string[] {
  const options = spec.enum ?? [];
  if (spec.name === "resolution") {
    if (isNanoBananaModel(modelId)) {
      return options.filter((option) => ["1K", "2K", "4K"].includes(option.toUpperCase()));
    }
    return options.filter((option) => !["512", "0.5K"].includes(option.toUpperCase()));
  }
  if (spec.name === "quality" || spec.name === "aspect_ratio" || spec.name === "image_size") {
    return options.filter((option) => option !== "auto");
  }
  return options;
}

function visibleParamDefault(spec: ParamSpec, modelId?: string | null): unknown {
  const options = visibleParamOptions(spec, modelId);
  if (typeof spec.default === "string" && options.includes(spec.default)) return spec.default;
  if (spec.name === "quality" && options.includes("medium")) return "medium";
  if ((spec.name === "aspect_ratio" || spec.name === "image_size") && options.includes("1:1"))
    return "1:1";
  if (spec.name === "resolution" && options.includes("2K")) return "2K";
  return options[0] ?? spec.default ?? "";
}

// How many tiles load without waiting on the observer. Anything plausibly
// above the fold should never depend on an IntersectionObserver callback.
const EAGER_TILES = 24;

type VerticalCrop = { top: number; bottom: number };

// Some generation providers return the requested canvas with dead-black bars
// baked into the pixels. Detect those once per asset instead of zooming every
// image and needlessly cutting into good compositions.
const VERTICAL_CROP_CACHE = new Map<string, VerticalCrop | null>();

function detectVerticalDeadSpace(image: HTMLImageElement): VerticalCrop | null {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) return null;

  const width = 128;
  const height = Math.max(48, Math.round((width * naturalHeight) / naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const rowMean = (y: number) => {
      let total = 0;
      let brightest = 0;
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const luminance =
          pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
        total += luminance;
        brightest = Math.max(brightest, luminance);
      }
      return { mean: total / width, brightest };
    };

    const scan = (fromTop: boolean) => {
      const limit = Math.floor(height * 0.24);
      const deadRows: number[] = [];
      let depth = 0;
      for (; depth < limit; depth += 1) {
        const y = fromTop ? depth : height - depth - 1;
        const row = rowMean(y);
        if (row.mean > 10 || row.brightest > 32) break;
        deadRows.push(row.mean);
      }

      const minimum = Math.max(2, Math.round(height * 0.025));
      if (depth < minimum || depth === limit) return 0;

      const lookAhead = Math.min(8, height - depth);
      let contentTotal = 0;
      for (let offset = 0; offset < lookAhead; offset += 1) {
        const y = fromTop ? depth + offset : height - depth - offset - 1;
        contentTotal += rowMean(y).mean;
      }
      const deadMean = deadRows.reduce((sum, value) => sum + value, 0) / deadRows.length;
      const contentMean = contentTotal / lookAhead;

      // A gradual dark scene is artwork. A sharp luminance jump is a border.
      return contentMean - deadMean >= 16 ? depth / height : 0;
    };

    const top = scan(true);
    const bottom = scan(false);
    const total = top + bottom;
    if (total < 0.04 || total > 0.45) return null;
    return { top, bottom };
  } catch {
    return null;
  }
}

function verticalCropStyle(crop: VerticalCrop): React.CSSProperties {
  const content = 1 - crop.top - crop.bottom;
  const zoom = Math.min(1.45, (1 / content) * 1.015);
  const visibleContent = content * zoom;
  return {
    width: `${zoom * 100}%`,
    height: `${zoom * 100}%`,
    left: `${((1 - zoom) / 2) * 100}%`,
    top: `${(-crop.top * zoom - (visibleContent - 1) / 2) * 100}%`,
  };
}

// Observer-gated <img>/<video>. One implementation shared by the Library
// tiles and the Creations cards so the loading rules can't drift apart.
function LazyMedia({
  id,
  kind,
  name,
  eager,
  className,
}: {
  id: string;
  kind: "image" | "video";
  name: string;
  eager: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState(eager);
  const [verticalCrop, setVerticalCrop] = useState<VerticalCrop | null>(
    () => VERTICAL_CROP_CACHE.get(id) ?? null,
  );
  const [cropReady, setCropReady] = useState(() => VERTICAL_CROP_CACHE.has(id));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVerticalCrop(VERTICAL_CROP_CACHE.get(id) ?? null);
    setCropReady(VERTICAL_CROP_CACHE.has(id));
  }, [id]);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    // A zero-height viewport (embedded panes) makes IntersectionObserver
    // report nothing as intersecting, ever. Don't resolve that by loading
    // everything — the eager set already covers the fold.
    if (!window.innerHeight) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return (
    <div ref={ref} className={cn("relative h-full w-full overflow-hidden", className)}>
      {seen && !failed ? (
        kind === "video" ? (
          <video
            src={fileUrl(id)}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
            onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={fileUrl(id)}
            alt={name}
            decoding="async"
            data-smart-crop={verticalCrop ? "vertical" : undefined}
            className={cn(
              "absolute left-0 top-0 h-full w-full max-w-none object-cover transition-opacity duration-200",
              cropReady ? "opacity-100" : "opacity-0",
            )}
            style={verticalCrop ? verticalCropStyle(verticalCrop) : undefined}
            onLoad={(event) => {
              const cached = VERTICAL_CROP_CACHE.get(id);
              if (cached !== undefined) {
                setVerticalCrop(cached);
                setCropReady(true);
                return;
              }
              const detected = detectVerticalDeadSpace(event.currentTarget);
              VERTICAL_CROP_CACHE.set(id, detected);
              setVerticalCrop(detected);
              setCropReady(true);
            }}
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/40">
          {kind === "video" ? <Film className="h-6 w-6" /> : <ImageIcon className="h-6 w-6" />}
        </div>
      )}
    </div>
  );
}

// Popovers close on Escape and on a click outside. Anything that covers the
// composer has to be dismissible without hunting for the toggle again.
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);
  return ref;
}

function InsightsTab({ onOpenConnections }: { onOpenConnections: () => void }) {
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [balances, setBalances] = useState<Record<string, ProviderBalance | null>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ledgerResponse, providerResponse] = await Promise.all([
        fetch("/__design_ledger"),
        fetch("/__design_providers"),
      ]);
      const [nextLedger, nextProviders] = await Promise.all([
        ledgerResponse.json() as Promise<LedgerResponse>,
        providerResponse.json() as Promise<ProvidersResponse>,
      ]);
      setLedger(nextLedger.ok ? nextLedger : null);
      setProviders(nextProviders.ok ? nextProviders : null);
      const connected = (nextProviders.engines ?? []).filter((engine) => engine.configured);
      const balanceEntries = await Promise.all(
        connected.map(async (engine) => {
          try {
            const response = await fetch(
              `/__design_balance?engine=${encodeURIComponent(engine.id)}`,
            );
            if (!response.ok) return [engine.id, null] as const;
            return [engine.id, (await response.json()) as ProviderBalance] as const;
          } catch {
            return [engine.id, null] as const;
          }
        }),
      );
      setBalances(Object.fromEntries(balanceEntries));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const insight = useMemo(() => {
    const items = (ledger?.items ?? []).filter(
      (item) => item.alive && item.agent === "studio" && item.tool !== "reference",
    );
    const lastThirtyDays = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    const recent = items.filter((item) => item.ts >= lastThirtyDays);
    const summarize = (source: LedgerItem[]) => ({
      outputs: source.length,
      usd: source.reduce((total, item) => total + (item.costUsd ?? 0), 0),
      credits: source.reduce((total, item) => total + (item.costCredits ?? 0), 0),
    });
    const byProvider = new Map<string, ReturnType<typeof summarize>>();
    for (const item of items) {
      const provider = item.tool ?? "unknown";
      const current = byProvider.get(provider) ?? { outputs: 0, usd: 0, credits: 0 };
      current.outputs += 1;
      current.usd += item.costUsd ?? 0;
      current.credits += item.costCredits ?? 0;
      byProvider.set(provider, current);
    }
    return {
      all: summarize(items),
      recent: summarize(recent),
      byProvider: [...byProvider.entries()].sort((a, b) => b[1].outputs - a[1].outputs),
    };
  }, [ledger]);

  const connected = providers?.engines.filter((engine) => engine.configured) ?? [];
  const maxOutputs = Math.max(1, ...insight.byProvider.map(([, value]) => value.outputs));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-white/92">
            Design insights
          </h2>
          <p className="mt-1 text-[11px] text-white/34">
            Recorded spend, output volume and live balances from your connected providers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="grid h-9 w-9 place-items-center rounded-[11px] border border-white/[0.09] text-white/38 transition-colors hover:bg-white/[0.05] hover:text-white/75 disabled:opacity-35"
            aria-label="Refresh insights"
            title="Refresh insights"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onOpenConnections}
            className="inline-flex h-9 items-center gap-2 rounded-[11px] border border-white/[0.1] bg-white/[0.035] px-3 text-[10.5px] font-medium text-white/58 transition-colors hover:bg-white/[0.07] hover:text-white/86"
          >
            <Settings2 className="h-3.5 w-3.5" /> Connections
          </button>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Last 30 days",
            value: insight.recent.outputs.toLocaleString(),
            detail: "outputs created",
          },
          {
            label: "Tracked spend",
            value: compactUsd(insight.recent.usd),
            detail: "USD-priced generations",
          },
          {
            label: "Provider credits",
            value: insight.recent.credits.toLocaleString(),
            detail: "credits used where reported",
          },
          {
            label: "Connected",
            value: connected.length.toLocaleString(),
            detail: `${providers?.engines.length ?? 0} providers available`,
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className="rounded-[15px] border border-white/[0.075] bg-white/[0.025] px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
          >
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/28">
              {metric.label}
            </div>
            <div className="mt-2 text-[24px] font-semibold tracking-[-0.04em] text-white/90">
              {loading && !ledger ? "…" : metric.value}
            </div>
            <div className="mt-1 text-[9.5px] text-white/28">{metric.detail}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-[16px] border border-white/[0.075] bg-[#171c28]/72 p-4">
          <div className="mb-4 flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-[#9ce8d7]/70" />
            <h3 className="text-[11.5px] font-semibold text-white/78">Usage by provider</h3>
          </div>
          <div className="space-y-3">
            {insight.byProvider.map(([provider, value]) => (
              <div key={provider}>
                <div className="mb-1.5 flex items-center gap-2 text-[10px]">
                  <BrandMark
                    brand={BRANDS[provider] ?? BRANDS.openrouter}
                    className="h-3.5 w-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate text-white/58">
                    {BRANDS[provider]?.label ?? provider}
                  </span>
                  <span className="tabular-nums text-white/34">
                    {value.outputs} {value.outputs === 1 ? "output" : "outputs"}
                    {value.usd > 0 ? ` · ${compactUsd(value.usd)}` : ""}
                    {value.credits > 0 ? ` · ${value.credits.toLocaleString()} credits` : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.045]">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#67dbc4,#7899ff,#d277da)]"
                    style={{ width: `${Math.max(4, (value.outputs / maxOutputs) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {!insight.byProvider.length && (
              <div className="py-8 text-center text-[10.5px] text-white/28">
                Tracked generations will appear here.
              </div>
            )}
          </div>
        </section>

        <section className="rounded-[16px] border border-white/[0.075] bg-[#171c28]/72 p-4">
          <div className="mb-4 flex items-center gap-2">
            <WalletCards className="h-3.5 w-3.5 text-[#aeb6ff]/75" />
            <h3 className="text-[11.5px] font-semibold text-white/78">Balances and access</h3>
          </div>
          <div className="space-y-1.5">
            {(providers?.engines ?? []).map((engine) => {
              const balance = balances[engine.id];
              return (
                <div
                  key={engine.id}
                  className="flex items-center gap-2.5 rounded-[11px] border border-white/[0.055] bg-white/[0.018] px-3 py-2.5"
                >
                  <BrandMark
                    brand={BRANDS[engine.id] ?? BRANDS.openrouter}
                    className={cn("h-4 w-4", !engine.configured && "opacity-30 grayscale")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10.5px] font-medium text-white/65">{engine.label}</div>
                    <div className="mt-0.5 text-[8.5px] text-white/25">
                      {engine.configured ? "Connected" : "Not connected"}
                    </div>
                  </div>
                  <div className="text-right text-[10px] font-medium tabular-nums text-white/58">
                    {balance?.ok
                      ? balance.unit === "usd"
                        ? compactUsd(balance.amount)
                        : `${balance.amount.toLocaleString()} credits`
                      : engine.configured
                        ? "Balance hidden"
                        : "Setup"}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── page shell ─────────────────────────────────────────────────────────────

type Tab = "create" | "library" | "insights";
type LibrarySort = "relevance" | "newest" | "oldest" | "largest" | "smallest";

type DesignQuote = { text: string; author: string };

const DESIGN_QUOTES: DesignQuote[] = [
  { text: "Good design is as little design as possible.", author: "Dieter Rams" },
  { text: "Less, but better.", author: "Dieter Rams" },
  {
    text: "Design is not just what it looks like and feels like. Design is how it works.",
    author: "Steve Jobs",
  },
  { text: "The details are not the details. They make the design.", author: "Charles Eames" },
  {
    text: "Recognising the need is the primary condition for design.",
    author: "Charles Eames",
  },
  { text: "Design is thinking made visual.", author: "Saul Bass" },
  { text: "Design is the silent ambassador of your brand.", author: "Paul Rand" },
  {
    text: "Styles come and go. Good design is a language, not a style.",
    author: "Massimo Vignelli",
  },
  { text: "If you do it right, it will last forever.", author: "Massimo Vignelli" },
  { text: "People ignore design that ignores people.", author: "Frank Chimero" },
  {
    text: "There are three responses to a piece of design: yes, no and wow.",
    author: "Milton Glaser",
  },
  {
    text: "To design is to communicate clearly by whatever means you can control or master.",
    author: "Milton Glaser",
  },
  {
    text: "Content precedes design. Design without content is decoration.",
    author: "Jeffrey Zeldman",
  },
  {
    text: "The public is more familiar with bad design than good design.",
    author: "Paul Rand",
  },
  {
    text: "Design is the intermediary between information and understanding.",
    author: "Richard Grefé",
  },
  {
    text: "A designer knows perfection when there is nothing left to take away.",
    author: "Antoine de Saint-Exupéry",
  },
  { text: "Have no fear of perfection. You will never reach it.", author: "Salvador Dalí" },
  {
    text: "You cannot use up creativity. The more you use, the more you have.",
    author: "Maya Angelou",
  },
  { text: "The best way to predict the future is to invent it.", author: "Alan Kay" },
  {
    text: "We shape our tools, and thereafter our tools shape us.",
    author: "John Culkin",
  },
];

const QUOTE_SESSION_KEY = "claude-os.design.quote-session.v1";
const LAST_QUOTE_KEY = "claude-os.design.quote-last.v1";

function quoteForThisSession(): DesignQuote {
  if (typeof window === "undefined") return DESIGN_QUOTES[0];
  try {
    const existing = Number(window.sessionStorage.getItem(QUOTE_SESSION_KEY));
    if (Number.isInteger(existing) && existing >= 0 && existing < DESIGN_QUOTES.length) {
      return DESIGN_QUOTES[existing];
    }

    const previous = Number(window.localStorage.getItem(LAST_QUOTE_KEY));
    let next = Math.floor(Math.random() * DESIGN_QUOTES.length);
    if (DESIGN_QUOTES.length > 1 && next === previous) next = (next + 1) % DESIGN_QUOTES.length;
    window.sessionStorage.setItem(QUOTE_SESSION_KEY, String(next));
    window.localStorage.setItem(LAST_QUOTE_KEY, String(next));
    return DESIGN_QUOTES[next];
  } catch {
    return DESIGN_QUOTES[0];
  }
}

function DesignStudio() {
  const [tab, setTab] = useState<Tab>("create");
  const [designQuote] = useState(quoteForThisSession);
  const [refs, setRefs] = useState<LedgerItem[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(REFERENCES_KEY) ?? "[]");
      return Array.isArray(saved)
        ? saved
            .filter(
              (item: LedgerItem) =>
                item?.id && item?.name && item.kind === "image" && item.alive !== false,
            )
            .slice(0, 8)
        : [];
    } catch {
      return [];
    }
  });
  const [connectionsRequest, setConnectionsRequest] = useState(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(REFERENCES_KEY, JSON.stringify(refs));
    } catch {
      /* local storage can be unavailable in hardened browser sessions */
    }
  }, [refs]);

  const openConnections = () => {
    setTab("create");
    setConnectionsRequest((current) => current + 1);
  };

  const useLibraryReference = (item: MediaItem) => {
    if (item.kind !== "image") return;
    const reference: LedgerItem = {
      id: item.id,
      path: item.path,
      name: item.name,
      agent: "studio",
      tool: "library",
      kind: "image",
      ts: item.mtime,
      bytes: item.bytes,
      mtime: item.mtime,
      alive: true,
      session: null,
      cwd: item.root,
      prompt: null,
      backfill: false,
      model: null,
      params: {},
    };
    setRefs((current) =>
      current.some((existing) => existing.id === reference.id)
        ? current
        : [...current, reference].slice(0, 8),
    );
    setTab("create");
  };

  return (
    <div className="dark relative -m-4 min-h-[calc(100vh-3.5rem)] overflow-hidden bg-[#11151f] text-foreground md:-m-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(circle at 18% -8%, rgba(116,92,255,0.14), transparent 29%), radial-gradient(circle at 86% 4%, rgba(60,204,190,0.08), transparent 25%), linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)",
          backgroundSize: "auto, auto, 42px 42px, 42px 42px",
          maskImage: "linear-gradient(to bottom, black, transparent 68%)",
        }}
      />
      <div className="relative z-10 mx-auto max-w-[1800px] px-3 pb-10 pt-3 md:px-5 md:pt-4">
        <div className="mb-6 flex flex-wrap items-end gap-6 border-b border-white/[0.08] pt-2">
          <div className="min-w-0 flex-1 pb-6">
            <div className="flex items-center gap-2.5">
              <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight md:text-5xl">
                Design
              </h1>
              <span className="rounded-full border border-fuchsia-300/30 bg-fuchsia-300/[0.07] px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-fuchsia-200">
                Beta
              </span>
            </div>
            {tab === "create" ? (
              <blockquote className="mt-3 max-w-3xl">
                <p className="text-[15px] leading-6 tracking-[-0.01em] text-white/48">
                  “{designQuote.text}”
                </p>
                <cite className="mt-1 block text-[11px] italic text-white/27">
                  {designQuote.author}
                </cite>
              </blockquote>
            ) : (
              <p className="mt-3 max-w-2xl text-base leading-relaxed text-white/42">
                {tab === "library"
                  ? "Find any visual on this machine without remembering the filename."
                  : "See what Design has made, spent and still has available."}
              </p>
            )}
          </div>

          <div className="flex items-end gap-3">
            <div className="flex items-end gap-7" role="tablist" aria-label="Design workspace">
              {[
                { id: "create" as const, label: "Create", number: "01" },
                { id: "library" as const, label: "Library", number: "02" },
                { id: "insights" as const, label: "Insights", number: "03" },
              ].map((t) => {
                const is = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    role="tab"
                    aria-pressed={is}
                    aria-selected={is}
                    className={cn(
                      "group relative flex items-baseline gap-2 pb-6 text-left transition-colors focus-visible:outline-none focus-visible:text-white",
                      is ? "text-white" : "text-white/34 hover:text-white/70",
                    )}
                  >
                    <span className="font-mono text-[9px] tracking-[0.14em] text-white/25">
                      {t.number}
                    </span>
                    <span className="text-[13px] font-medium tracking-[-0.01em]">{t.label}</span>
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-x-0 bottom-[-1px] h-[2px] origin-left transition-transform duration-300",
                        is ? "scale-x-100" : "scale-x-0 group-hover:scale-x-50",
                      )}
                      style={{
                        background:
                          "linear-gradient(90deg, #fc7b58 0%, #f6c65f 28%, #66dfc2 58%, #8d7cff 100%)",
                        boxShadow: is ? "0 0 18px rgba(126,112,255,0.45)" : undefined,
                      }}
                    />
                  </button>
                );
              })}
            </div>
            <div className="mb-[18px] flex items-center gap-1.5">
              <button
                type="button"
                onClick={openConnections}
                aria-label="Open connections"
                title="Connections"
                className="grid h-8 w-8 place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.025] text-white/35 transition-colors hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white/75"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className={tab === "create" ? "block" : "hidden"}>
          <CreateTab refs={refs} setRefs={setRefs} connectionsRequest={connectionsRequest} />
        </div>
        <div className={tab === "library" ? "block" : "hidden"}>
          <LibraryTab onUseAsReference={useLibraryReference} />
        </div>
        <div className={tab === "insights" ? "block" : "hidden"}>
          <InsightsTab onOpenConnections={openConnections} />
        </div>
      </div>
    </div>
  );
}

// ── Create — composer over the whole record of what you've made ────────────

// Each lobe is a soft disc of one colour that drifts on its own cycle; put
// together they read as a single body of living light. Sizes are deliberately
// larger than the tile so no lobe ever shows a hard edge against the frame.
const RENDER_LOBES = [
  { cls: "design-render-lobe-a", color: "#ff5f3d", left: "-12%", top: "-24%", w: "60%", h: "82%" },
  { cls: "design-render-lobe-b", color: "#2f9bff", left: "54%", top: "-18%", w: "62%", h: "86%" },
  { cls: "design-render-lobe-c", color: "#12d7a4", left: "-8%", top: "44%", w: "58%", h: "78%" },
  { cls: "design-render-lobe-d", color: "#7d55ff", left: "52%", top: "42%", w: "64%", h: "88%" },
  { cls: "design-render-lobe-e", color: "#ffb63d", left: "26%", top: "2%", w: "42%", h: "56%" },
] as const;

// Fine static grain over the gradients. Big soft colour fields band badly on
// an 8-bit panel; a still noise layer costs one rasterise and hides it.
const RENDER_GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

function RenderPlaceholder({ index, total }: { index: number; total: number }) {
  // Tiles in the same batch are offset in time so a row of them never
  // pulses in unison — that lockstep is what makes a loader look mechanical.
  const stagger = index * -3.7;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Generating image ${index + 1} of ${total}`}
      className="group/render relative isolate aspect-[16/10] overflow-hidden rounded-lg border border-white/[0.08] bg-[#06090f] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_16px_35px_-28px_rgba(0,0,0,0.95)]"
    >
      <div
        aria-hidden
        className="design-render-field absolute inset-0"
        style={{ animationDelay: `${stagger}s` }}
      >
        {RENDER_LOBES.map((lobe) => (
          <div
            key={lobe.cls}
            className={`design-render-lobe ${lobe.cls} absolute rounded-full mix-blend-screen`}
            style={{
              left: lobe.left,
              top: lobe.top,
              width: lobe.w,
              height: lobe.h,
              background: `radial-gradient(circle at 50% 50%, ${lobe.color} 0%, ${lobe.color}d9 26%, ${lobe.color}00 68%)`,
              filter: "blur(20px)",
              opacity: 0.82,
              animationDelay: `${stagger}s`,
            }}
          />
        ))}
        <div
          className="design-render-gleam absolute left-1/4 top-1/4 h-1/2 w-1/2 rounded-full mix-blend-screen"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(255,252,246,0.9) 0%, rgba(255,240,220,0.22) 42%, rgba(255,240,220,0) 70%)",
            filter: "blur(26px)",
            // Base value for the reduced-motion case, where the keyframes
            // that normally drive opacity never run.
            opacity: 0.28,
            animationDelay: `${stagger}s`,
          }}
        />
      </div>
      {/* Dark between the lobes is what makes them read as light rather than
          as a gradient: five of these screened together go beige without it. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_46%,transparent_22%,rgba(4,6,12,0.32)_68%,rgba(2,4,9,0.88))]"
      />
      <div
        aria-hidden
        className="design-render-sheen absolute inset-y-[-40%] left-0 w-[38%] bg-gradient-to-r from-transparent via-white/[0.09] to-transparent blur-xl"
        style={{ animationDelay: `${stagger}s` }}
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.11] mix-blend-overlay"
        style={{ backgroundImage: RENDER_GRAIN }}
      />
      <div
        aria-hidden
        className="design-render-bloom pointer-events-none absolute inset-0 rounded-lg opacity-45"
        style={{ animationDelay: `${stagger}s` }}
      />
      <div
        aria-hidden
        className="design-render-rim pointer-events-none absolute inset-0 rounded-lg p-px opacity-80"
        style={{ animationDelay: `${stagger}s` }}
      />
      {/* Which tile of the batch this is. Dots rather than a counter: it
          answers "how many am I waiting on" without narrating progress the
          server never reports. One image has nothing to count. */}
      {total > 1 && (
        <div aria-hidden className="absolute bottom-3 right-3 flex items-center gap-[5px]">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={`h-[3px] w-[3px] rounded-full ${
                i === index ? "bg-white/60" : "bg-white/[0.16]"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTab({
  refs,
  setRefs,
  connectionsRequest,
}: {
  refs: LedgerItem[];
  setRefs: React.Dispatch<React.SetStateAction<LedgerItem[]>>;
  connectionsRequest: number;
}) {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LedgerItem | null>(null);
  const [generationJobs, setGenerationJobs] = useState<GenerationJob[]>([]);
  const [framePick, setFramePick] = useState<"start" | "end" | null>(null);
  // Set by "Recreate"/"Animate" in the lightbox, consumed by the composer.
  const [preset, setPreset] = useState<{
    prompt?: string;
    kind?: "image" | "video";
    nonce: number;
  } | null>(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    return fetch("/__design_ledger")
      .then((r) => r.json())
      .then((d: LedgerResponse) => {
        if (!d.ok) throw new Error(d.error || "ledger read failed");
        setData(d);
        setErr(null);
      })
      .catch((e) => {
        if (!silent) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, []);

  // The whole point is "the second you build it" — so keep the view live.
  useEffect(() => {
    load();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, 12_000);
    return () => clearInterval(iv);
  }, [load]);

  const syncGenerationJobs = useCallback(() => {
    return fetch("/__design_jobs")
      .then((response) => response.json())
      .then((result: { ok?: boolean; jobs?: GenerationJob[] }) => {
        if (!result.ok || !Array.isArray(result.jobs)) return;
        setGenerationJobs((current) => {
          const serverJobs = result.jobs!;
          const activeIds = new Set(serverJobs.map((job) => job.id));
          // A newly clicked run can exist in React for a beat before the POST
          // registers server-side. Keep a short grace window so reconciliation
          // never flickers it away.
          const retained = current.filter(
            (job) => activeIds.has(job.id) || Date.now() - job.startedAt < 5_000,
          );
          const known = new Set(retained.map((job) => job.id));
          return [...retained, ...serverJobs.filter((job) => !known.has(job.id))];
        });
      })
      .catch(() => undefined);
  }, []);

  // A generation keeps running on the local server if the page is refreshed.
  // Reattach to those jobs so their progress and cancel controls come back too.
  useEffect(() => {
    void syncGenerationJobs();
  }, [syncGenerationJobs]);

  useEffect(() => {
    if (!generationJobs.length) return;
    void load(true);
    void syncGenerationJobs();
    const iv = window.setInterval(() => {
      void load(true);
      void syncGenerationJobs();
    }, 1_200);
    return () => {
      window.clearInterval(iv);
    };
  }, [generationJobs.length, load, syncGenerationJobs]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const items = useMemo(() => {
    // Shell-touched inputs are not Design results. They remain discoverable in
    // Library, but generic Bash activity should never pollute Create.
    return (data?.items ?? []).filter((i) => i.alive && i.tool?.trim().toLowerCase() !== "bash");
  }, [data]);

  const jobItems = useMemo(() => {
    const grouped = new Map<string, LedgerItem[]>();
    for (const job of generationJobs) grouped.set(job.id, []);
    for (const item of items) {
      if (item.jobId && grouped.has(item.jobId)) grouped.get(item.jobId)!.push(item);
    }
    return grouped;
  }, [generationJobs, items]);
  const activeItemIds = useMemo(
    () =>
      new Set(generationJobs.flatMap((job) => (jobItems.get(job.id) ?? []).map((item) => item.id))),
    [generationJobs, jobItems],
  );
  const previousItems = useMemo(
    () => items.filter((item) => !activeItemIds.has(item.id)),
    [activeItemIds, items],
  );
  const jobsWithProgress = useMemo<GenerationJobWithProgress[]>(
    () =>
      generationJobs.map((job) => ({
        ...job,
        completed: Math.min(job.total, jobItems.get(job.id)?.length ?? 0),
      })),
    [generationJobs, jobItems],
  );
  const pending = jobsWithProgress.reduce(
    (total, job) => total + Math.max(0, job.total - job.completed),
    0,
  );

  const cancelGeneration = useCallback(async (id: string) => {
    setGenerationJobs((current) =>
      current.map((job) => (job.id === id ? { ...job, status: "cancelling" } : job)),
    );
    try {
      const csrf = (await (await fetch("/__token")).json()).token as string;
      const response = await fetch("/__design_cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": csrf },
        body: JSON.stringify({ jobId: id }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "could not cancel generation");
    } catch (error) {
      setGenerationJobs((current) =>
        current.map((job) => (job.id === id ? { ...job, status: "running" } : job)),
      );
      setErr(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const addRef = (it: LedgerItem) => {
    setRefs((r) => (r.some((x) => x.id === it.id) ? r : [...r, it].slice(0, 8)));
    setLightbox(null);
  };

  const setVideoFrame = (it: LedgerItem, slot: "start" | "end") => {
    setRefs((current) => {
      const next = current.filter((item) => item.id !== it.id);
      if (slot === "start") return [it, ...next.slice(1)];
      if (!next[0]) return [it];
      return [next[0], it, ...next.slice(2)];
    });
    setFramePick(null);
    setLightbox(null);
  };

  return (
    <div className="pb-[250px]">
      <Composer
        refs={refs}
        onDropRef={(id) => setRefs((r) => r.filter((x) => x.id !== id))}
        onAddRefs={(items) =>
          setRefs((current) => {
            const seen = new Set(current.map((item) => item.id));
            return [
              ...current,
              ...items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true))),
            ].slice(0, 8);
          })
        }
        onRequestFrame={setFramePick}
        preset={preset}
        connectionsRequest={connectionsRequest}
        onStart={(job) => {
          setGenerationJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        }}
        onSettle={(id) => {
          void load(true).finally(() =>
            setGenerationJobs((current) => current.filter((job) => job.id !== id)),
          );
        }}
      />

      {framePick && (
        <div className="mb-3 flex items-center gap-3 rounded-xl border border-violet-300/25 bg-violet-400/[0.08] px-3 py-2.5 text-[12px] text-violet-100">
          <span className="flex-1">
            Pick an image below for the {framePick === "start" ? "start" : "end"} frame.
          </span>
          <button
            onClick={() => setFramePick(null)}
            className="text-violet-200/60 hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}

      {err && (
        <div className="rounded-xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-100 mb-6">
          {err}
        </div>
      )}

      {/* Only speaks up when it has something to say: armed is the normal
          state and doesn't need a badge sitting there forever. */}
      {data && !data.armed && (
        <div className="mb-5 rounded-xl border border-amber-300/30 bg-amber-500/10 px-4 py-3 text-[12.5px] text-amber-100">
          Your agents' own builds aren't being captured yet — run{" "}
          <code className="text-amber-50">bun run scripts/install-design-capture.ts</code> once, and
          everything Claude Code or Hermes creates lands here on its own.
        </div>
      )}

      {loading && !data ? (
        <div className="rounded-xl border border-dashed border-border/60 p-16 text-center text-sm text-muted-foreground">
          Reading the ledger…
        </div>
      ) : items.length === 0 && generationJobs.length === 0 ? (
        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/20 p-14 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-48 w-96 rounded-full blur-3xl opacity-30"
            style={{ background: "linear-gradient(90deg, #9fa8ff, #d8dcff)" }}
          />
          <Sparkles className="mx-auto h-8 w-8 mb-4" style={{ color: "#bfc5ff" }} />
          <div className="mb-1.5 text-[15px] font-medium">Nothing captured yet</div>
          <p className="text-[13px] text-muted-foreground max-w-md mx-auto leading-relaxed">
            Finished generations appear here automatically. Write a prompt below to make the first
            one, or use Library to search everything on this machine.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 xl:grid-cols-4">
          {jobsWithProgress.map((job) => {
            const completedItems = jobItems.get(job.id) ?? [];
            const remaining = Math.max(0, job.total - completedItems.length);
            return (
              <div key={job.id} className="contents">
                <div className="col-span-full mb-1 mt-2 flex min-w-0 items-center gap-2 rounded-[10px] border border-white/[0.07] bg-white/[0.025] px-3 py-2 first:mt-0">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      job.status === "cancelling"
                        ? "bg-amber-300/70"
                        : "animate-pulse bg-[#72e0c5] shadow-[0_0_10px_rgba(114,224,197,0.7)]",
                    )}
                  />
                  <span className="shrink-0 text-[10px] font-medium text-white/58">
                    {job.status === "cancelling"
                      ? "Cancelling"
                      : `${job.completed}/${job.total} ready`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-white/28">
                    {job.prompt}
                  </span>
                  <span className="hidden shrink-0 text-[9px] text-white/24 md:block">
                    {job.engineLabel} · {job.modelLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => void cancelGeneration(job.id)}
                    disabled={job.status === "cancelling"}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-white/[0.08] px-2 text-[9.5px] font-medium text-white/38 transition-colors hover:border-rose-300/20 hover:bg-rose-400/[0.06] hover:text-rose-100 disabled:cursor-wait disabled:opacity-35"
                  >
                    <X className="h-3 w-3" /> Cancel
                  </button>
                </div>
                {completedItems.map((m, i) => (
                  <CreationCard
                    key={m.id}
                    item={m}
                    index={i}
                    onOpen={() => {
                      if (framePick && m.kind === "image") setVideoFrame(m, framePick);
                      else setLightbox(m);
                    }}
                  />
                ))}
                {Array.from({ length: remaining }).map((_, i) => (
                  <RenderPlaceholder
                    key={`${job.id}-pending-${completedItems.length + i}`}
                    index={completedItems.length + i}
                    total={job.total}
                  />
                ))}
              </div>
            );
          })}
          {previousItems.map((m, i) => (
            <CreationCard
              key={m.id}
              item={m}
              index={generationJobs.length + pending + i}
              onOpen={() => {
                if (framePick && m.kind === "image") setVideoFrame(m, framePick);
                else setLightbox(m);
              }}
            />
          ))}
        </div>
      )}

      {lightbox && (
        <CreationLightbox
          item={lightbox}
          onClose={() => setLightbox(null)}
          onReference={() => addRef(lightbox)}
          onRemix={() => {
            setPreset({ prompt: lightbox.prompt ?? "", kind: lightbox.kind, nonce: Date.now() });
            setLightbox(null);
          }}
          onAnimate={() => {
            addRef(lightbox);
            setPreset({ prompt: lightbox.prompt ?? "", kind: "video", nonce: Date.now() });
          }}
          onDelete={async () => {
            try {
              await moveDesignItemToTrash(lightbox.id);
              setLightbox(null);
              load(true);
            } catch (error) {
              setErr(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      )}
    </div>
  );
}

// ── the composer — engine, model, and that model's own controls ────────────

const ENGINE_KEY = "claude-os.design.engine.v1";
const LOOK_KEY = "claude-os.design.look.v1";
const SAVED_LOOKS_KEY = "claude-os.design.saved-looks.v1";
const HIDDEN_LOOKS_KEY = "claude-os.design.hidden-looks.v1";
const PROMPT_KEY = "claude-os.design.prompt.v1";
const REFERENCES_KEY = "claude-os.design.references.v1";
const PINNED_MODELS_KEY = "claude-os.design.pinned-models.v1";
const DEFAULT_MODEL_PINS: Record<string, string[]> = {
  higgsfield: ["gpt_image_2", "nano_banana_flash", "recraft_v4_1", "seedream_v5_pro"],
  openrouter: [
    "openai/gpt-image-2",
    "google/gemini-3.1-flash-image",
    "recraft/recraft-v4.1",
    "bytedance-seed/seedream-4.5",
  ],
  kie: [
    "nano-banana-2",
    "gpt-image-2-text-to-image",
    "seedream/5-pro-text-to-image",
    "flux-2/pro-text-to-image",
    "qwen3/pro-text-to-image",
    "bytedance/seedance-2-5",
    "kling-3.0/video",
    "veo-3-1",
  ],
  openai: ["gpt-image-2"],
};
type SavedLook = Look & { prompt: string; references: LedgerItem[] };

function VideoFrameSlots({
  refs,
  onRemove,
  onRequest,
}: {
  refs: LedgerItem[];
  onRemove: (id: string) => void;
  onRequest: (slot: "start" | "end") => void;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      {(["start", "end"] as const).map((slot, index) => {
        const frame = refs[index];
        const disabled = slot === "end" && !refs[0];
        return (
          <div
            key={slot}
            className="group relative flex h-12 min-w-[138px] items-center gap-2 rounded-xl border border-white/[0.08] bg-[#181d2b] px-2"
          >
            {frame ? (
              <>
                <img
                  src={fileUrl(frame.id)}
                  alt=""
                  className="h-8 w-11 rounded-md border border-white/10 object-cover"
                />
                <span className="text-[10.5px] text-white/68">
                  {slot === "start" ? "Start frame" : "End frame"}
                </span>
                <button
                  onClick={() => onRemove(frame.id)}
                  aria-label={`Remove ${slot} frame`}
                  className="absolute right-1.5 top-1.5 rounded-full p-0.5 text-white/30 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </>
            ) : (
              <button
                onClick={() => onRequest(slot)}
                disabled={disabled}
                className="flex w-full items-center gap-2 text-left text-white/38 transition-colors hover:text-white/78 disabled:cursor-not-allowed disabled:opacity-30"
                title={disabled ? "Choose a start frame first" : undefined}
              >
                {slot === "start" ? (
                  <PanelTop className="h-4 w-4" />
                ) : (
                  <PanelBottom className="h-4 w-4" />
                )}
                <span className="text-[10.5px]">
                  Add {slot === "start" ? "start" : "end"} frame
                </span>
              </button>
            )}
          </div>
        );
      })}
      <span className="hidden text-[10px] leading-relaxed text-white/27 md:block">
        Frames are sent in order to supported video models.
      </span>
    </div>
  );
}

function ReferenceStack({
  refs,
  adding,
  onAdd,
  onRemove,
}: {
  refs: LedgerItem[];
  adding: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const shown = refs.slice(0, 4);

  return (
    <div
      className="inline-flex h-9 shrink-0 items-center rounded-[11px] border border-white/[0.13] bg-[#121722]/90 px-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.065),0_2px_9px_-6px_rgba(0,0,0,0.95)]"
      role="group"
      aria-label="Reference images"
    >
      {shown.length > 0 && (
        <div className="mr-1 flex items-center -space-x-[6px] pl-0.5">
          {shown.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onRemove(item.id)}
              className={cn(
                "group/reference relative h-[30px] w-[30px] overflow-hidden rounded-[8px] border border-white/[0.16] bg-[#090d14] shadow-[-3px_2px_10px_-5px_rgba(0,0,0,1)] transition-all duration-200 hover:z-20 hover:-translate-y-1 hover:rotate-0 hover:scale-105",
                index === 0 ? "-rotate-1" : index % 2 === 0 ? "-rotate-2" : "rotate-2",
              )}
              style={{ zIndex: index + 1, transformOrigin: "50% 85%" }}
              aria-label={`Remove reference ${item.name}`}
              title={`Remove ${item.name}`}
            >
              <img src={fileUrl(item.id)} alt="" className="h-full w-full object-cover" />
              <span className="absolute inset-0 grid place-items-center bg-black/62 opacity-0 transition-opacity group-hover/reference:opacity-100">
                <X className="h-3 w-3 text-white" />
              </span>
            </button>
          ))}
          {refs.length > shown.length && (
            <span className="relative z-10 grid h-[30px] w-[30px] place-items-center rounded-[8px] border border-white/[0.13] bg-[#252b3b] text-[9px] font-medium tabular-nums text-white/72 shadow-[-3px_2px_10px_-5px_rgba(0,0,0,1)]">
              +{refs.length - shown.length}
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onAdd}
        disabled={adding || refs.length >= 8}
        className="group/add-reference inline-flex h-7 items-center gap-1.5 rounded-[8px] px-1.5 text-[10.5px] font-medium text-white/52 transition-colors hover:bg-white/[0.055] hover:text-white/88 disabled:cursor-not-allowed disabled:opacity-35"
        aria-label={refs.length ? "Add another reference image" : "Add reference images"}
        title={refs.length >= 8 ? "Maximum 8 reference images" : "Add reference images"}
      >
        <span className="relative grid h-5 w-5 place-items-center rounded-[7px] border border-white/[0.11] bg-white/[0.035]">
          <ImagePlus className={cn("h-3 w-3", adding && "animate-pulse")} />
          {!adding && (
            <Plus className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[#7d83e8] p-[1px] text-white shadow-[0_0_7px_rgba(125,131,232,0.65)]" />
          )}
        </span>
        <span>{adding ? "Adding…" : refs.length ? `${refs.length} refs` : "Reference"}</span>
      </button>
    </div>
  );
}

function Composer({
  refs,
  onDropRef,
  onAddRefs,
  onRequestFrame,
  preset,
  connectionsRequest,
  onStart,
  onSettle,
}: {
  refs: LedgerItem[];
  onDropRef: (id: string) => void;
  onAddRefs: (items: LedgerItem[]) => void;
  onRequestFrame: (slot: "start" | "end") => void;
  preset: { prompt?: string; kind?: "image" | "video"; nonce: number } | null;
  connectionsRequest: number;
  onStart: (job: GenerationJob) => void;
  onSettle: (id: string) => void;
}) {
  const [prov, setProv] = useState<ProvidersResponse | null>(null);
  const [provErr, setProvErr] = useState<string | null>(null);
  const [engineId, setEngineId] = useState<string>(() => {
    try {
      return window.localStorage.getItem(ENGINE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [models, setModels] = useState<EngineModel[]>([]);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [modelId, setModelId] = useState("");
  const [schema, setSchema] = useState<ParamSpec[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [count, setCount] = useState(1);
  const [creditEstimate, setCreditEstimate] = useState<{
    perOutput: number;
    total: number;
  } | null>(null);
  const [creditEstimateLoading, setCreditEstimateLoading] = useState(false);
  const [providerBalance, setProviderBalance] = useState<ProviderBalance | null>(null);
  const [look, setLook] = useState<string>(() => {
    try {
      return window.localStorage.getItem(LOOK_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [savedLooks, setSavedLooks] = useState<SavedLook[]>(() => {
    try {
      const value = JSON.parse(window.localStorage.getItem(SAVED_LOOKS_KEY) ?? "[]");
      return Array.isArray(value)
        ? value
            .filter((item) => item?.id && item?.label && item?.prompt)
            .map((item) => ({
              ...item,
              references: Array.isArray(item.references)
                ? item.references.filter(
                    (reference: LedgerItem) =>
                      reference?.id && reference?.name && reference.kind === "image",
                  )
                : [],
            }))
            .slice(0, 20)
        : [];
    } catch {
      return [];
    }
  });
  const [hiddenLookIds, setHiddenLookIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(HIDDEN_LOOKS_KEY) ?? "[]");
      return [...new Set(["amber", ...(Array.isArray(saved) ? saved : [])])];
    } catch {
      return ["amber"];
    }
  });
  const [prompt, setPrompt] = useState(() => {
    try {
      return window.localStorage.getItem(PROMPT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [genErr, setGenErr] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [addingRefs, setAddingRefs] = useState(false);
  const referenceInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!connectionsRequest) return;
    setProviderOpen(true);
    setPickerOpen(false);
    setStyleOpen(false);
  }, [connectionsRequest]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PROMPT_KEY, prompt);
    } catch {
      /* local storage can be unavailable in hardened browser sessions */
    }
  }, [prompt]);

  const loadProviders = useCallback((refresh = false) => {
    fetch(`/__design_providers${refresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((d: ProvidersResponse) => {
        if (!d.ok) throw new Error(d.error || "engine check failed");
        setProv(d);
        setProvErr(null);
      })
      .catch((e) => setProvErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const loadBalance = useCallback((id: string, refresh = false) => {
    return fetch(`/__design_balance?engine=${encodeURIComponent(id)}${refresh ? "&refresh=1" : ""}`)
      .then(async (response) => {
        const data = (await response.json()) as ProviderBalance;
        if (!response.ok || !data.ok) throw new Error(data.error || "balance unavailable");
        setProviderBalance(data);
      })
      .catch(() => setProviderBalance(null));
  }, []);

  const engines = prov?.engines ?? [];
  const engine =
    engines.find((e) => e.id === engineId) ??
    engines.find((e) => e.configured) ??
    engines[0] ??
    null;

  useEffect(() => {
    if (engine && engine.id !== engineId) setEngineId(engine.id);
  }, [engine, engineId]);

  useEffect(() => {
    if (!engine?.configured) {
      setProviderBalance(null);
      return;
    }
    setProviderBalance(null);
    setBalanceOpen(false);
    void loadBalance(engine.id);
  }, [engine?.configured, engine?.id, loadBalance]);

  // Model list follows the engine.
  useEffect(() => {
    if (!engine?.configured) {
      setModels([]);
      return;
    }
    let live = true;
    const forEngine = engine.id;
    fetch(`/__design_models?engine=${encodeURIComponent(forEngine)}`)
      .then((r) => r.json())
      .then((d) => {
        if (live && d.ok) setModels(d.models ?? []);
      })
      .catch(() => {
        if (live) setModels([]);
      });
    return () => {
      live = false;
    };
  }, [engine?.id, engine?.configured]);

  const kindModels = useMemo(() => models.filter((m) => m.kind === kind), [models, kind]);
  const hasImage = models.some((m) => m.kind === "image");
  const hasVideo = models.some((m) => m.kind === "video");
  const model = kindModels.find((m) => m.id === modelId) ?? kindModels[0] ?? null;
  const schemaEngineId = engine?.id;
  const schemaModelId = model?.id;

  useEffect(() => {
    if (model && model.id !== modelId) setModelId(model.id);
    if (!hasVideo && kind === "video") setKind("image");
  }, [model, modelId, hasVideo, kind]);

  // Controls follow the model — straight from what it accepts.
  useEffect(() => {
    if (!schemaEngineId || !schemaModelId) {
      setSchema([]);
      setValues({});
      return;
    }
    let live = true;
    fetch(
      `/__design_schema?engine=${encodeURIComponent(schemaEngineId)}&model=${encodeURIComponent(schemaModelId)}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (!live || !d.ok) return;
        const specs: ParamSpec[] = d.params ?? [];
        setSchema(specs);
        setValues((prev) => {
          const next: Record<string, unknown> = {};
          for (const s of specs) {
            // Keep a compatible choice when switching models — a 16:9 stays
            // 16:9 rather than snapping back to the model's default.
            const carried = prev[s.name];
            const visibleOptions = visibleParamOptions(s, schemaModelId);
            next[s.name] =
              visibleOptions.length &&
              typeof carried === "string" &&
              visibleOptions.includes(carried)
                ? carried
                : visibleParamDefault(s, schemaModelId);
          }
          return next;
        });
      })
      .catch(() => {
        if (live) {
          setSchema([]);
          setValues({});
        }
      });
    return () => {
      live = false;
    };
  }, [schemaEngineId, schemaModelId]);

  useEffect(() => {
    if (engine?.id !== "higgsfield" || !model) {
      setCreditEstimate(null);
      setCreditEstimateLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCreditEstimateLoading(true);
      void (async () => {
        try {
          const response = await fetch("/__design_cost", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
            body: JSON.stringify({ engine: engine.id, model: model.id, count, params: values }),
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || "cost estimate failed");
          setCreditEstimate({ perOutput: Number(data.perOutput), total: Number(data.total) });
        } catch (error: unknown) {
          if (!(error instanceof Error) || error.name !== "AbortError") setCreditEstimate(null);
        } finally {
          if (!controller.signal.aborted) setCreditEstimateLoading(false);
        }
      })();
    }, 320);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [count, engine?.id, model, values]);

  // "Recreate" / "Animate" from the lightbox.
  useEffect(() => {
    if (!preset) return;
    if (preset.prompt !== undefined) setPrompt(preset.prompt);
    if (preset.kind) setKind(preset.kind);
  }, [preset]);

  const pickEngine = (id: string) => {
    if (id === engineId) return;
    setEngineId(id);
    setGenErr(null);
    setKeyInput("");
    // Everything downstream belonged to the old engine. Clearing it
    // synchronously means Generate is disabled until the new engine answers,
    // rather than briefly pointing at a model this engine doesn't have.
    setModelId("");
    setModels([]);
    setSchema([]);
    setValues({});
    try {
      window.localStorage.setItem(ENGINE_KEY, id);
    } catch {
      /* fine */
    }
  };
  const pickLook = (id: string) => {
    setLook(id);
    const recipe = savedLooks.find((item) => item.id === id);
    if (recipe?.references.length) onAddRefs(recipe.references);
    try {
      window.localStorage.setItem(LOOK_KEY, id);
    } catch {
      /* fine */
    }
  };
  const removeLook = (id: string) => {
    const isSaved = savedLooks.some((item) => item.id === id);
    if (isSaved) {
      setSavedLooks((current) => {
        const next = current.filter((item) => item.id !== id);
        try {
          window.localStorage.setItem(SAVED_LOOKS_KEY, JSON.stringify(next));
        } catch {
          /* storage blocked */
        }
        return next;
      });
    } else {
      setHiddenLookIds((current) => {
        const next = current.includes(id) ? current : [...current, id];
        try {
          window.localStorage.setItem(HIDDEN_LOOKS_KEY, JSON.stringify(next));
        } catch {
          /* storage blocked */
        }
        return next;
      });
    }
    if (look === id) pickLook("");
  };
  const saveLook = (
    label: string,
    prompt: string,
    references: LedgerItem[],
    existingId?: string,
  ) => {
    const nextLook: SavedLook = {
      id: existingId ?? `saved-${Date.now()}`,
      label,
      hint: prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt,
      prompt,
      references: references.filter((item) => item.kind === "image").slice(0, 8),
    };
    setSavedLooks((current) => {
      const next = existingId
        ? current.map((item) => (item.id === existingId ? nextLook : item))
        : [...current, nextLook].slice(-20);
      try {
        window.localStorage.setItem(SAVED_LOOKS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked */
      }
      return next;
    });
    pickLook(nextLook.id);
  };

  const token = async () => (await (await fetch("/__token")).json()).token as string;

  const uploadReferenceFiles = async (incoming: File[]) => {
    const remaining = Math.max(0, 8 - refs.length);
    const files = incoming.filter((file) => file.type.startsWith("image/")).slice(0, remaining);
    if (!files.length || addingRefs) return;
    const oversized = files.find((file) => file.size > 12 * 1024 * 1024);
    if (oversized) {
      setGenErr(`${oversized.name} is over the 12 MB reference limit`);
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) > 42 * 1024 * 1024) {
      setGenErr("Keep the selected references under 42 MB in total");
      return;
    }
    setAddingRefs(true);
    setGenErr(null);
    try {
      const encoded = await Promise.all(
        files.map(
          (file, index) =>
            new Promise<{ name: string; type: string; dataUrl: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  name: file.name || `pasted-reference-${Date.now()}-${index + 1}.png`,
                  type: file.type,
                  dataUrl: String(reader.result ?? ""),
                });
              reader.onerror = () => reject(new Error(`Could not read ${file.name || "image"}`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      const response = await fetch("/__design_reference", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
        body: JSON.stringify({ files: encoded }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "reference upload failed");
      onAddRefs(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      setGenErr(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingRefs(false);
    }
  };

  const uploadReferences = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    void uploadReferenceFiles(files);
  };

  const pasteReferences = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    void uploadReferenceFiles(images);
  };

  const connect = async () => {
    if (!engine || !keyInput.trim() || connecting) return;
    setConnecting(true);
    setGenErr(null);
    try {
      const r = await fetch("/__design_set_key", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
        body: JSON.stringify({ provider: engine.id, key: keyInput.trim() }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "connect failed");
      setKeyInput("");
      loadProviders();
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!engine || engine.source !== "settings" || disconnecting) return;
    setDisconnecting(true);
    setGenErr(null);
    try {
      const r = await fetch("/__design_remove_key", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
        body: JSON.stringify({ provider: engine.id }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "disconnect failed");
      setKeyInput("");
      loadProviders(true);
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDisconnecting(false);
    }
  };

  const generate = async () => {
    if (!engine || !model || !prompt.trim()) return;
    const jobId =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const job: GenerationJob = {
      id: jobId,
      total: count,
      prompt: prompt.trim(),
      engine: engine.id,
      engineLabel: engine.label,
      model: model.id,
      modelLabel: model.label,
      kind,
      startedAt: Date.now(),
      status: "running",
    };
    const perOutputUsd = usdGenerationEstimate(model, 1, values)?.perOutput ?? null;
    const perOutputCredits =
      engine.id === "higgsfield" && creditEstimate ? creditEstimate.perOutput : null;
    setGenErr(null);
    onStart(job);
    try {
      const r = await fetch("/__design_generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await token() },
        body: JSON.stringify({
          jobId,
          engine: engine.id,
          engineLabel: engine.label,
          model: model.id,
          modelLabel: model.label,
          prompt: prompt.trim(),
          kind,
          count,
          look: look || null,
          lookLabel:
            [...(prov?.looks ?? []), ...savedLooks].find((item) => item.id === look)?.label ?? null,
          lookPrompt: savedLooks.find((item) => item.id === look)?.prompt ?? null,
          params: values,
          references: refs.map((r2) => r2.id),
          quotedCostCredits: perOutputCredits,
          estimatedCostUsd: engine.id === "higgsfield" ? null : perOutputUsd,
        }),
      });
      const d = await r.json();
      if (d.cancelled) return;
      if (!r.ok || !d.ok) throw new Error(d.error || "generation failed");
      if (d.failed)
        setGenErr(`${d.failed} of ${count} failed — ${d.failures?.[0] ?? "no reason given"}`);
    } catch (e) {
      setGenErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (engine) void loadBalance(engine.id, true);
      onSettle(jobId);
    }
  };

  const canGenerate = Boolean(prompt.trim()) && Boolean(model);
  const usdEstimate = useMemo(
    () => usdGenerationEstimate(model, count, values),
    [count, model, values],
  );
  const priceDisplay =
    engine?.id === "higgsfield"
      ? {
          label: creditEstimateLoading
            ? "Checking…"
            : creditEstimate
              ? `${creditEstimate.total.toLocaleString()} credits`
              : "Credits TBC",
          detail: creditEstimate
            ? `${creditEstimate.perOutput.toLocaleString()} credits per output · live Higgsfield estimate`
            : "Live Higgsfield estimate unavailable",
          secondary: creditEstimate
            ? `${count} ${count === 1 ? "output" : "outputs"} × ${creditEstimate.perOutput.toLocaleString()} credits`
            : "No live rate returned",
          source: creditEstimate ? "Live provider quote" : "Rate unavailable",
        }
      : usdEstimate
        ? {
            ...usdEstimate,
            detail: `${usdEstimate.detail} · ${engine?.label ?? "provider"}`,
            secondary: `${count} ${count === 1 ? "output" : "outputs"} × ${compactUsd(usdEstimate.perOutput)}`,
            source:
              model?.pricingSource === "live" ? "Live provider rates" : "Provider-rate estimate",
          }
        : {
            label: "Price TBC",
            detail: "This provider does not expose a usable estimate",
            secondary: "No usable provider rate",
            source: "Not reported",
          };
  const balanceDisplay = providerBalance
    ? providerBalance.unit === "usd"
      ? compactUsd(providerBalance.amount)
      : `${providerBalance.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`
    : null;

  return (
    <div className="fixed bottom-4 left-3 right-3 z-[60] md:left-[244px] md:right-5">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[8%] -bottom-4 top-5 rounded-[40px] opacity-45 blur-3xl"
        style={{
          background:
            "linear-gradient(100deg, rgba(255,116,87,0.35), rgba(244,197,91,0.2), rgba(80,218,190,0.22), rgba(119,101,255,0.35))",
        }}
      />
      <div
        className="design-spectrum-frame relative mx-auto max-w-[1160px] rounded-[24px] p-[1.5px]"
        style={{
          background:
            "linear-gradient(115deg, #ff7959 0%, #f4ca61 21%, #5cddc1 43%, #7694ff 66%, #d879ff 83%, #ff7959 100%)",
          backgroundSize: "240% 240%",
          boxShadow: "0 28px 80px -30px rgba(3,5,12,0.98), 0 0 34px -15px rgba(116,148,255,0.75)",
        }}
      >
        <div
          className="relative rounded-[22.5px] px-3 py-2.5 backdrop-blur-2xl md:px-4 md:py-3"
          style={{
            background: "linear-gradient(145deg, rgba(27,32,45,0.992), rgba(18,23,34,0.992))",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.09)",
          }}
        >
          {provErr ? (
            <div className="text-[12.5px] text-rose-200">{provErr}</div>
          ) : !prov ? (
            <div className="text-[12.5px] text-muted-foreground">Checking your engines…</div>
          ) : (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 border-b border-white/[0.06] pb-1.5">
                <ProviderButton
                  engine={engine}
                  engines={engines}
                  open={providerOpen}
                  onToggle={() => {
                    setProviderOpen((o) => !o);
                    setPickerOpen(false);
                    setStyleOpen(false);
                  }}
                  onPick={(id) => {
                    pickEngine(id);
                  }}
                  onRefresh={() => loadProviders(true)}
                  keyInput={keyInput}
                  onKeyInput={setKeyInput}
                  connecting={connecting}
                  disconnecting={disconnecting}
                  onConnect={() => void connect()}
                  onDisconnect={() => void disconnect()}
                  error={genErr}
                  modelCount={models.length}
                />
                {engine?.configured && (
                  <ModelButton
                    engine={engine}
                    model={model}
                    open={pickerOpen}
                    onToggle={() => {
                      setPickerOpen((o) => !o);
                      setProviderOpen(false);
                      setStyleOpen(false);
                    }}
                    onPick={(id) => {
                      setModelId(id);
                      setPickerOpen(false);
                    }}
                    models={kindModels}
                  />
                )}
                {engine?.configured && kind === "image" && (
                  <ReferenceStack
                    refs={refs}
                    adding={addingRefs}
                    onAdd={() => referenceInput.current?.click()}
                    onRemove={onDropRef}
                  />
                )}
                {engine?.configured && (
                  <div className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-[10px] border border-white/[0.11] bg-black/15 p-1">
                    {(["image", "video"] as const).map((mediaKind) => {
                      const available = mediaKind === "image" ? hasImage : hasVideo;
                      return (
                        <button
                          key={mediaKind}
                          type="button"
                          onClick={() => {
                            if (!available) return;
                            setKind(mediaKind);
                            setModelId("");
                          }}
                          disabled={!available}
                          aria-pressed={kind === mediaKind}
                          title={
                            available
                              ? `Create ${mediaKind === "image" ? "images" : "video"}`
                              : `No ${mediaKind} models from ${engine.label}`
                          }
                          className={cn(
                            "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[10.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-25",
                            kind === mediaKind
                              ? "bg-white/[0.1] font-medium text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]"
                              : "text-white/38 hover:bg-white/[0.05] hover:text-white/74",
                          )}
                        >
                          {mediaKind === "video" ? (
                            <Film className="h-3 w-3" />
                          ) : (
                            <ImageIcon className="h-3 w-3" />
                          )}
                          {mediaKind === "video" ? "Video" : "Still"}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  ref={referenceInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  hidden
                  tabIndex={-1}
                  onChange={uploadReferences}
                />
              </div>

              {engine && !engine.configured ? (
                <button
                  onClick={() => setProviderOpen(true)}
                  className="flex w-full items-center gap-3 rounded-[14px] border border-white/[0.09] bg-[#161b28] px-3.5 py-3 text-left transition-colors hover:border-white/[0.16] hover:bg-[#1a202f]"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.09] bg-white/[0.035]">
                    {engine.auth === "cli" ? (
                      <Terminal className="h-4 w-4 text-white/50" />
                    ) : (
                      <KeyRound className="h-4 w-4 text-white/50" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-white/76">
                      Connect {engine.label} to create
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-white/34">
                      {engine.auth === "cli"
                        ? "Use the CLI login already on this machine"
                        : "Verify an API key in Connections and pricing"}
                    </span>
                  </span>
                  <Settings2 className="h-4 w-4 text-white/32" />
                </button>
              ) : engine ? (
                <div>
                  {kind === "video" ? (
                    <VideoFrameSlots refs={refs} onRemove={onDropRef} onRequest={onRequestFrame} />
                  ) : null}

                  <div className="rounded-[16px] border border-white/[0.13] bg-[#121722]/82 px-2.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_10px_28px_-24px_rgba(0,0,0,0.9)] transition-colors focus-within:border-[#aeb6ff]/45">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onPaste={pasteReferences}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void generate();
                        }
                      }}
                      rows={2}
                      aria-label={kind === "video" ? "Describe the video" : "Describe the image"}
                      placeholder={
                        kind === "video"
                          ? "Describe the video you want to create"
                          : "Describe the image you want to create"
                      }
                      className="w-full resize-none border-0 bg-transparent px-1 py-1.5 text-[14px] leading-5 text-white outline-none placeholder:text-white/30 md:text-[14.5px]"
                      style={{ minHeight: 54, maxHeight: 64 }}
                    />
                  </div>

                  {/* The control deck. Every knob below comes from the model's
                    own schema, so it can't offer a setting that would fail. */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 xl:w-auto xl:flex-1">
                      {schema
                        .filter((spec) => spec.name !== "background")
                        .map((spec) => (
                          <ParamControl
                            key={spec.name}
                            spec={spec}
                            modelId={model?.id}
                            value={values[spec.name]}
                            onChange={(v) => setValues((s) => ({ ...s, [spec.name]: v }))}
                          />
                        ))}

                      <OutputCount value={count} kind={kind} onChange={setCount} />
                    </div>

                    <StyleButton
                      looks={[
                        ...(prov.looks ?? []).filter((item) => !hiddenLookIds.includes(item.id)),
                        ...savedLooks,
                      ]}
                      refs={refs}
                      addingImages={addingRefs}
                      onAddImages={() => referenceInput.current?.click()}
                      value={look}
                      open={styleOpen}
                      onToggle={() => {
                        setStyleOpen((o) => !o);
                        setProviderOpen(false);
                        setPickerOpen(false);
                      }}
                      onPick={(id) => {
                        pickLook(id);
                        setStyleOpen(false);
                      }}
                      onSave={saveLook}
                      onDelete={removeLook}
                    />

                    <div className="ml-auto flex shrink-0 items-center gap-2.5">
                      <div
                        className="relative inline-flex min-h-[42px] items-center rounded-[11px] border border-white/[0.09] bg-black/15 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
                        title={priceDisplay.detail}
                        aria-label={`Estimated generation price: ${priceDisplay.label}`}
                      >
                        <div className="min-w-[70px] text-left">
                          <div className="text-[8px] font-medium uppercase tracking-[0.13em] text-white/28">
                            This run
                          </div>
                          <div className="mt-0.5 text-[11.5px] font-semibold tabular-nums text-white/82">
                            {priceDisplay.label}
                          </div>
                        </div>
                        {balanceDisplay && (
                          <div className="relative ml-2 border-l border-white/[0.08] pl-2">
                            <button
                              type="button"
                              onClick={() => setBalanceOpen((open) => !open)}
                              aria-expanded={balanceOpen}
                              aria-label={
                                balanceOpen ? "Hide provider balance" : "Show provider balance"
                              }
                              title="Show provider balance"
                              className={cn(
                                "grid h-7 w-7 place-items-center rounded-[8px] border transition-colors",
                                balanceOpen
                                  ? "border-[#9ce8d7]/24 bg-[#9ce8d7]/[0.09] text-[#cafff2]/85"
                                  : "border-white/[0.07] bg-white/[0.025] text-white/32 hover:border-white/[0.14] hover:text-white/70",
                              )}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            {balanceOpen && (
                              <div className="absolute bottom-full right-0 z-[90] mb-2.5 w-[220px] rounded-[14px] border border-white/[0.11] bg-[#161b27]/[0.98] p-3 text-left shadow-[0_22px_55px_-18px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
                                <div className="text-[8.5px] font-medium uppercase tracking-[0.16em] text-white/30">
                                  {engine?.label ?? "Provider"} balance
                                </div>
                                <div className="mt-1 text-[15px] font-semibold tabular-nums text-white/90">
                                  {balanceDisplay}
                                </div>
                                <div className="mt-1.5 text-[9.5px] leading-relaxed text-white/38">
                                  {providerBalance?.unit === "usd"
                                    ? "Remaining account spend. The run estimate uses the same currency."
                                    : engine?.id === "higgsfield"
                                      ? "Remaining provider credits. This run is quoted in the same credits."
                                      : "Provider credits are separate from the USD run estimate."}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div
                        className={cn(
                          "design-spectrum-frame relative isolate shrink-0 rounded-[15px] p-px transition-all duration-300",
                          canGenerate ? "hover:-translate-y-px hover:scale-[1.01]" : "opacity-35",
                        )}
                        style={{
                          background:
                            "linear-gradient(110deg, #ff7959 0%, #ffd568 22%, #61e8c5 46%, #6e9bff 70%, #df78ff 100%)",
                          backgroundSize: "220% 220%",
                          boxShadow: canGenerate
                            ? "0 10px 24px -15px rgba(105,151,255,0.85), 0 0 0 1px rgba(255,255,255,0.04)"
                            : undefined,
                        }}
                      >
                        <button
                          onClick={generate}
                          disabled={!canGenerate}
                          className="group/generate relative inline-flex min-h-[42px] min-w-[124px] items-center justify-center overflow-hidden rounded-[14px] border border-black/70 bg-[#07090e] px-6 py-2.5 text-[12.5px] font-semibold tracking-[-0.01em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.13),inset_0_-12px_24px_rgba(0,0,0,0.34)] transition-colors hover:bg-[#0b0e15] disabled:cursor-not-allowed md:text-[13px]"
                        >
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/65 to-transparent"
                          />
                          <span
                            aria-hidden
                            className="pointer-events-none absolute -top-5 left-1/2 h-8 w-20 -translate-x-1/2 rounded-full bg-white/10 blur-xl transition-opacity group-hover/generate:opacity-80"
                          />
                          <span className="relative">
                            {count > 1 ? `Generate ${count}` : "Generate"}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                  {genErr && <div className="mt-1.5 text-[12px] text-rose-200">{genErr}</div>}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderButton({
  engine,
  engines,
  open,
  onToggle,
  onPick,
  onRefresh,
  keyInput,
  onKeyInput,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
  error,
  modelCount,
}: {
  engine: Engine | null;
  engines: Engine[];
  open: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  onRefresh: () => void;
  keyInput: string;
  onKeyInput: (value: string) => void;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  error: string | null;
  modelCount: number;
}) {
  const close = useCallback(() => {
    if (open) onToggle();
  }, [open, onToggle]);
  const wrap = useDismiss(open, close);
  const connected = engines.filter((e) => e.configured);
  const setup = engine ? ENGINE_SETUP[engine.id] : null;
  const brand = engine ? (BRANDS[engine.id] ?? BRANDS.openrouter) : BRANDS.openrouter;
  const sourceLabel =
    engine?.source === "cli"
      ? "Higgsfield CLI session"
      : engine?.source === "settings"
        ? "local Design settings"
        : engine?.source === "key_file"
          ? "existing Kie key file"
          : engine?.source === "environment"
            ? "environment variable"
            : "not connected";

  return (
    <div className="relative shrink-0" ref={wrap}>
      <div className="inline-flex items-center gap-1 rounded-[11px] border border-white/[0.14] bg-[#121722]/90 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)]">
        {connected.map((item) => {
          const itemBrand = BRANDS[item.id] ?? BRANDS.openrouter;
          const selected = engine?.id === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onPick(item.id)}
              aria-label={`Use ${item.label}`}
              aria-pressed={selected}
              className={cn(
                "group/provider relative flex h-7 w-7 items-center justify-center rounded-[8px] border transition-all",
                selected
                  ? "border-white/[0.18] bg-white/[0.1] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_14px_-8px_rgba(174,182,255,0.9)]"
                  : "w-7 border-transparent opacity-52 hover:border-white/10 hover:bg-white/[0.05] hover:opacity-90",
              )}
            >
              <BrandMark brand={itemBrand} className="h-3.5 w-3.5" />
              <span className="pointer-events-none absolute bottom-full left-1/2 z-[90] mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-[#11151f]/95 px-2 py-1 text-[10px] text-white/72 opacity-0 shadow-xl backdrop-blur-xl transition-all duration-200 group-hover/provider:-translate-y-0.5 group-hover/provider:opacity-100">
                {item.label}
              </span>
            </button>
          );
        })}
        <button
          onClick={onToggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Connections and pricing"
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-[8px] border text-white/45 transition-all hover:border-white/20 hover:bg-white/[0.07] hover:text-white/80",
            open ? "border-[#b6bdff]/35 bg-[#aeb6ff]/12 text-[#d8dcff]" : "border-white/[0.08]",
          )}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && engine && (
        <div
          className="absolute bottom-full left-0 z-[80] mb-3 max-h-[450px] w-[760px] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[20px] border border-white/12 bg-[#1c2130]/[0.99] shadow-2xl backdrop-blur-2xl"
          style={{ boxShadow: "0 30px 80px -22px rgba(0,0,0,0.95)" }}
          role="dialog"
          aria-label="Connections and pricing"
        >
          <div className="flex items-start gap-3 border-b border-white/[0.08] px-4 py-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.045] text-white/65">
              <Settings2 className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold tracking-[-0.01em] text-white/90">
                Connections and pricing
              </div>
              <div className="mt-0.5 text-[10.5px] text-white/38">
                Use an existing CLI session or verify an API key. Nothing is charged until Generate.
              </div>
            </div>
            <button
              onClick={onToggle}
              className="rounded-lg p-1.5 text-white/35 hover:bg-white/[0.06] hover:text-white/75"
              aria-label="Close connections"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid min-h-[340px] md:grid-cols-[245px_1fr]">
            <div className="border-b border-white/[0.08] bg-[#171c29]/75 p-2 md:border-b-0 md:border-r">
              <div className="px-2 pb-2 pt-1 text-[9px] uppercase tracking-[0.18em] text-white/28">
                Generation engines
              </div>
              <div className="space-y-1">
                {engines.map((item) => {
                  const itemBrand = BRANDS[item.id] ?? BRANDS.openrouter;
                  const selected = engine.id === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onPick(item.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2.5 text-left transition-all",
                        selected
                          ? "border-white/[0.13] bg-white/[0.085] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                          : "border-transparent hover:bg-white/[0.04]",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border bg-white/[0.035]",
                          item.configured
                            ? "border-white/10"
                            : "border-white/[0.06] opacity-45 grayscale",
                        )}
                      >
                        <BrandMark brand={itemBrand} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] font-medium text-white/82">
                          {item.label}
                        </span>
                        <span
                          className={cn(
                            "mt-0.5 inline-flex items-center gap-1.5 text-[9.5px]",
                            item.configured ? "text-emerald-300/70" : "text-white/28",
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              item.configured ? "bg-emerald-400" : "bg-white/20",
                            )}
                          />
                          {item.configured
                            ? "Connected"
                            : item.auth === "cli"
                              ? "CLI login needed"
                              : "Key needed"}
                        </span>
                      </span>
                      {selected && <ChevronDown className="h-3 w-3 -rotate-90 text-white/32" />}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={onRefresh}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/[0.07] px-3 py-2 text-[10px] text-white/36 transition-colors hover:bg-white/[0.04] hover:text-white/70"
              >
                <RefreshCw className="h-3 w-3" /> Recheck all
              </button>
            </div>

            <div className="p-4 md:p-5">
              <div className="flex items-start gap-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border bg-white/[0.035]"
                  style={{ borderColor: `${brand.tone}38` }}
                >
                  <BrandMark brand={brand} className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[9px] uppercase tracking-[0.18em] text-white/32">
                    {setup?.eyebrow}
                  </div>
                  <div className="mt-0.5 text-[17px] font-semibold tracking-[-0.025em] text-white/92">
                    {engine.label}
                  </div>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[9.5px]",
                    engine.configured
                      ? "border-emerald-300/18 bg-emerald-300/[0.06] text-emerald-200/75"
                      : "border-white/[0.08] bg-white/[0.025] text-white/34",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      engine.configured ? "bg-emerald-400" : "bg-white/25",
                    )}
                  />
                  {engine.configured ? "Ready" : "Setup needed"}
                </span>
              </div>

              <p className="mt-3 max-w-xl text-[11.5px] leading-relaxed text-white/45">
                {setup?.detail}
              </p>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-white/[0.08] bg-[#151a26]/72 p-3">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.15em] text-white/28">
                    <KeyRound className="h-3 w-3" /> Connection
                  </div>
                  <div className="mt-2 text-[11.5px] font-medium text-white/76">
                    {engine.configured ? `Via ${sourceLabel}` : "Not connected"}
                  </div>
                  <div className="mt-0.5 text-[9.5px] text-white/30">
                    {engine.tail
                      ? `Key ending ${engine.tail}`
                      : engine.auth === "cli"
                        ? "Uses your local account"
                        : "Verified before saving"}
                  </div>
                </div>
                <div className="rounded-xl border border-white/[0.08] bg-[#151a26]/72 p-3">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.15em] text-white/28">
                    <WalletCards className="h-3 w-3" /> Pricing
                  </div>
                  <div className="mt-2 text-[11.5px] font-medium text-white/76">
                    {engine.id === "openrouter"
                      ? "Live endpoint rates"
                      : engine.id === "higgsfield"
                        ? "TBC"
                        : "Indicative estimates"}
                  </div>
                  <div className="mt-0.5 text-[9.5px] text-white/30">
                    {engine.id === "openrouter"
                      ? `${modelCount || "Live"} image models · actual cost saved`
                      : engine.id === "higgsfield"
                        ? "Provider rate unavailable"
                        : "Shown before Generate when available"}
                  </div>
                </div>
              </div>

              {engine.auth === "cli" ? (
                <div className="mt-4 rounded-[14px] border border-white/[0.09] bg-[#121722] p-3.5">
                  <div className="text-[10.5px] font-medium text-white/68">
                    {engine.configured
                      ? "Connected through the CLI"
                      : "Connect in Terminal, then recheck"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <code className="flex min-h-9 flex-1 items-center rounded-[10px] border border-white/[0.08] bg-black/20 px-3 text-[10.5px] text-white/58">
                      <Terminal className="mr-2 h-3.5 w-3.5" />
                      {setup?.command}
                    </code>
                    <button
                      onClick={onRefresh}
                      className="rounded-[10px] border border-white/14 bg-white/[0.055] px-3 text-[10.5px] text-white/68 hover:bg-white/[0.09]"
                    >
                      Recheck
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-[14px] border border-white/[0.09] bg-[#121722] p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10.5px] font-medium text-white/70">
                        {engine.configured ? "Replace API key" : `Connect ${engine.label}`}
                      </div>
                      <div className="mt-0.5 text-[9.5px] text-white/30">
                        Verified with the provider, then stored locally.
                      </div>
                    </div>
                    {setup?.href && (
                      <a
                        href={setup.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[9.5px] text-white/38 underline decoration-white/15 underline-offset-4 hover:text-white/70"
                      >
                        Get key
                      </a>
                    )}
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <input
                      value={keyInput}
                      onChange={(event) => onKeyInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onConnect();
                      }}
                      type="password"
                      placeholder={ENGINE_HINT[engine.id]?.keyHint ?? "API key"}
                      className="min-w-[210px] flex-1 rounded-[10px] border border-white/[0.1] bg-[#0f141f] px-3 py-2.5 text-[11.5px] text-white outline-none placeholder:text-white/25 focus:border-[#99a6ff]/45"
                    />
                    <button
                      onClick={onConnect}
                      disabled={connecting || !keyInput.trim()}
                      className="rounded-[10px] border border-white/80 bg-[#f4f5ff] px-3.5 py-2.5 text-[10.5px] font-semibold text-[#11151f] hover:bg-white disabled:border-white/[0.08] disabled:bg-white/[0.05] disabled:text-white/22"
                    >
                      {connecting
                        ? "Verifying…"
                        : engine.configured
                          ? "Replace key"
                          : "Verify and connect"}
                    </button>
                  </div>
                  {engine.configured && engine.source === "settings" && (
                    <button
                      onClick={onDisconnect}
                      disabled={disconnecting}
                      className="mt-2.5 text-[9.5px] text-white/30 transition-colors hover:text-rose-200 disabled:opacity-40"
                    >
                      {disconnecting ? "Disconnecting…" : "Remove saved key"}
                    </button>
                  )}
                  {engine.configured && engine.source !== "settings" && (
                    <div className="mt-2.5 text-[9.5px] text-white/27">
                      This connection is managed outside Design. Saving a key here will override it
                      locally.
                    </div>
                  )}
                </div>
              )}
              {error && (
                <div className="mt-3 rounded-xl border border-rose-300/15 bg-rose-300/[0.05] px-3 py-2 text-[10.5px] text-rose-100/80">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OutputCount({
  value,
  kind,
  onChange,
}: {
  value: number;
  kind: "image" | "video";
  onChange: (value: number) => void;
}) {
  const options = [1, 2, 4, 8];

  return (
    <div
      role="group"
      aria-label={`Number of ${kind === "image" ? "images" : "clips"}`}
      className="inline-flex h-[38px] shrink-0 items-center gap-1 rounded-[11px] border border-white/[0.14] bg-[#121722] p-1 pl-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)]"
    >
      <span className="mr-0.5 text-[9px] font-medium uppercase tracking-[0.13em] text-white/28">
        {kind === "image" ? "Images" : "Clips"}
      </span>
      <div className="flex items-center gap-0.5" aria-live="polite">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={value === option}
            aria-label={`${option} ${kind === "image" ? (option === 1 ? "image" : "images") : option === 1 ? "clip" : "clips"}`}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-[8px] text-[10.5px] font-medium tabular-nums transition-all",
              value === option
                ? "bg-[#edf0ff] text-[#121522] shadow-[0_2px_9px_-4px_rgba(200,207,255,0.85)]"
                : "text-white/34 hover:bg-white/[0.055] hover:text-white/80",
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function StyleButton({
  looks,
  refs,
  addingImages,
  onAddImages,
  value,
  open,
  onToggle,
  onPick,
  onSave,
  onDelete,
}: {
  looks: Array<Look | SavedLook>;
  refs: LedgerItem[];
  addingImages: boolean;
  onAddImages: () => void;
  value: string;
  open: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  onSave: (label: string, prompt: string, references: LedgerItem[], existingId?: string) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editingReferences, setEditingReferences] = useState<LedgerItem[]>([]);
  const selected = looks.find((l) => l.id === value) ?? null;
  const close = useCallback(() => {
    if (open) onToggle();
  }, [open, onToggle]);
  const wrap = useDismiss(open, close);
  const formReferences = editingId
    ? [
        ...editingReferences,
        ...refs.filter(
          (reference) => !editingReferences.some((existing) => existing.id === reference.id),
        ),
      ].slice(0, 8)
    : refs;

  return (
    <div className="relative flex shrink-0 items-center gap-1.5" ref={wrap}>
      {selected && (
        <button
          type="button"
          onClick={() => onPick("")}
          aria-label={`Remove ${selected.label} style`}
          title="Remove active style"
          className="group/active-style inline-flex h-[38px] max-w-[164px] items-center gap-2 rounded-[11px] border border-[#aeb6ff]/25 bg-[#aeb6ff]/[0.075] px-2.5 text-[10.5px] font-medium text-[#e7e9ff] shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] transition-colors hover:border-[#aeb6ff]/40 hover:bg-[#aeb6ff]/[0.12]"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#aeb6ff] shadow-[0_0_9px_rgba(174,182,255,0.75)]" />
          <span className="min-w-0 truncate">{selected.label}</span>
          <X className="h-3 w-3 shrink-0 text-white/38 transition-colors group-hover/active-style:text-white/85" />
        </button>
      )}
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={selected ? `Style recipe ${selected.label}` : "Style recipes"}
        className={cn(
          "relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-[11px] border shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)] transition-colors",
          selected
            ? "border-white/[0.2] bg-white/[0.1] text-white"
            : "border-white/[0.14] bg-[#121722] text-white/55 hover:border-white/25 hover:text-white/80",
        )}
      >
        <Palette className="h-4 w-4" />
      </button>

      {open && (
        <div
          className="absolute bottom-full right-0 z-[80] mb-3 w-[360px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-white/10 bg-[#222736]/[0.99] p-2 shadow-2xl backdrop-blur-2xl"
          style={{ boxShadow: "0 30px 80px -22px rgba(0,0,0,0.95)" }}
          role="listbox"
        >
          <div className="flex items-start gap-3 px-2 pb-2 pt-1">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-white/85">Design recipes</div>
              <div className="mt-0.5 text-[10.5px] text-white/35">
                Reusable instructions, with reference images only when you need them.
              </div>
            </div>
            <button
              onClick={() => {
                setEditingId(null);
                setEditingReferences([]);
                setName("");
                setInstructions("");
                setAdding((current) => !current);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-violet-300/25 bg-violet-300/[0.08] px-2 py-1.5 text-[10px] text-violet-100 hover:bg-violet-300/[0.14]"
            >
              <Plus className="h-3 w-3" /> New
            </button>
          </div>

          {adding && (
            <div className="mb-2 rounded-xl border border-white/[0.08] bg-[#181d2b] p-2.5">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Recipe name"
                className="mb-2 w-full rounded-lg border border-white/10 bg-[#141925] px-2.5 py-2 text-[11.5px] text-white outline-none placeholder:text-white/28 focus:border-violet-300/35"
              />
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Describe the visual rules, character, mood or composition"
                rows={3}
                className="w-full resize-none rounded-lg border border-white/10 bg-[#141925] px-2.5 py-2 text-[11.5px] leading-relaxed text-white outline-none placeholder:text-white/28 focus:border-violet-300/35"
              />
              <div className="mt-2 rounded-[10px] border border-white/[0.08] bg-[#141925] p-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10.5px] font-medium text-white/66">Recipe references</div>
                    <div className="mt-0.5 text-[9px] text-white/28">
                      These images load every time you use this recipe.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onAddImages}
                    disabled={addingImages || formReferences.length >= 8}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-[#9ce8d7]/25 bg-[#9ce8d7]/[0.08] px-2 py-1.5 text-[9.5px] font-medium text-[#cafff2] transition-colors hover:bg-[#9ce8d7]/[0.14] disabled:opacity-35"
                  >
                    <ImagePlus className={cn("h-3 w-3", addingImages && "animate-pulse")} />
                    {addingImages ? "Adding…" : formReferences.length ? "Add more" : "Add images"}
                  </button>
                </div>
                {formReferences.length > 0 ? (
                  <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
                    {formReferences.slice(0, 8).map((reference) => (
                      <img
                        key={reference.id}
                        src={fileUrl(reference.id)}
                        alt=""
                        title={reference.name}
                        className="h-9 w-9 shrink-0 rounded-[8px] border border-white/[0.12] object-cover shadow-[0_5px_12px_-8px_rgba(0,0,0,1)]"
                      />
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 rounded-[8px] border border-dashed border-white/[0.09] px-2 py-2 text-[9.5px] text-white/24">
                    Add character, product or mood references if this recipe needs them.
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  if (!name.trim() || !instructions.trim()) return;
                  onSave(name.trim(), instructions.trim(), formReferences, editingId ?? undefined);
                  setName("");
                  setInstructions("");
                  setEditingId(null);
                  setEditingReferences([]);
                  setAdding(false);
                }}
                disabled={!name.trim() || !instructions.trim()}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-[9px] border border-white/70 bg-[#f4f1ff] px-3 py-2.5 text-[11px] font-semibold text-[#11131a] shadow-[0_7px_18px_-10px_rgba(210,201,255,0.9),inset_0_1px_0_rgba(255,255,255,1)] transition-all hover:bg-white disabled:border-white/[0.08] disabled:bg-white/[0.055] disabled:text-white/24 disabled:shadow-none"
              >
                <Save className="h-3 w-3" />
                {name.trim()
                  ? `${editingId ? "Update" : "Save"} ${name.trim()}`
                  : editingId
                    ? "Update design"
                    : "Save design"}
              </button>
            </div>
          )}

          <div className="max-h-[300px] overflow-y-auto">
            {[
              { id: "", label: "Original", hint: "Use the prompt exactly as written" },
              ...looks,
            ].map((option) => {
              const is = value === option.id;
              const recipeReferences =
                "references" in option && Array.isArray(option.references) ? option.references : [];
              return (
                <div
                  key={option.id || "original"}
                  className={cn(
                    "group/recipe flex w-full items-start rounded-xl border transition-colors",
                    is
                      ? "border-[#b6bdff]/40 bg-[#aeb6ff]/11"
                      : "border-transparent hover:bg-white/[0.05]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onPick(option.id)}
                    role="option"
                    aria-selected={is}
                    className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left"
                  >
                    <span
                      className={cn(
                        "mt-1 h-2.5 w-2.5 shrink-0 rounded-full border",
                        is ? "border-[#d8dcff] bg-[#9fa8ff]" : "border-white/25",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium text-white/85">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-[10.5px] leading-relaxed text-white/35">
                        {option.hint}
                      </span>
                      {recipeReferences.length > 0 && (
                        <span className="mt-1.5 flex items-center -space-x-1.5">
                          {recipeReferences.slice(0, 4).map((reference, index) => (
                            <img
                              key={reference.id}
                              src={fileUrl(reference.id)}
                              alt=""
                              className="h-5 w-5 rounded-[6px] border border-[#222736] object-cover"
                              style={{ zIndex: index + 1 }}
                            />
                          ))}
                          {recipeReferences.length > 4 && (
                            <span className="relative z-10 grid h-5 w-5 place-items-center rounded-[6px] border border-white/10 bg-[#303647] text-[7.5px] text-white/62">
                              +{recipeReferences.length - 4}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {is && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#d8dcff]" />}
                  </button>
                  {option.id && (
                    <div className="mr-2 mt-2 flex shrink-0 items-center gap-0.5 opacity-45 transition-opacity group-hover/recipe:opacity-100">
                      {"prompt" in option && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(option.id);
                            setName(option.label);
                            setInstructions(option.prompt);
                            setEditingReferences(option.references ?? []);
                            setAdding(true);
                          }}
                          aria-label={`Edit ${option.label}`}
                          title="Edit recipe"
                          className="grid h-7 w-7 place-items-center rounded-[8px] border border-transparent text-white/28 transition-all hover:border-white/10 hover:bg-white/[0.06] hover:text-white/75"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDelete(option.id)}
                        aria-label={`Remove ${option.label}`}
                        title="Remove recipe"
                        className="grid h-7 w-7 place-items-center rounded-[8px] border border-transparent text-white/22 transition-all hover:border-rose-300/20 hover:bg-rose-300/[0.08] hover:text-rose-200"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelOption({
  model,
  engine,
  selected,
  pinned,
  onPick,
  onTogglePin,
}: {
  model: EngineModel;
  engine: Engine;
  selected: boolean;
  pinned: boolean;
  onPick: (id: string) => void;
  onTogglePin: (id: string) => void;
}) {
  const brand = brandForModel(model.id, engine.id);
  const displayLabel = compactModelLabel(model);
  return (
    <div
      role="option"
      aria-selected={selected}
      className={cn(
        "group/model-row flex w-full items-center rounded-xl border transition-all",
        selected
          ? "border-[#aeb6ff]/28 bg-gradient-to-r from-[#aeb6ff]/[0.12] to-[#74d9c1]/[0.045] shadow-[inset_3px_0_0_rgba(174,182,255,0.72)]"
          : "border-transparent hover:border-white/[0.07] hover:bg-white/[0.045]",
      )}
    >
      <button
        onClick={() => onPick(model.id)}
        className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2.5 text-left"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border bg-black/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
          style={{ borderColor: `${brand.tone}3d`, backgroundColor: `${brand.tone}0d` }}
        >
          <BrandMark brand={brand} className="h-[19px] w-[19px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-white/88">
            {displayLabel}
          </span>
          <span className="mt-0.5 block truncate text-[10.5px] text-white/34">
            {MODEL_BLURBS[model.id] ?? `${brand.label} · ${model.kind}`}
          </span>
        </span>
        <span className="max-w-[145px] shrink-0 text-right" title={modelRateDetail(model)}>
          <span className="block text-[10px] font-medium tabular-nums text-white/56">
            {modelRateLabel(model)}
          </span>
        </span>
        {selected && <Check className="h-3.5 w-3.5 shrink-0 text-violet-200" />}
      </button>
      <button
        onClick={() => onTogglePin(model.id)}
        aria-label={pinned ? `Unpin ${model.label}` : `Pin ${model.label}`}
        title={pinned ? "Remove from pinned" : "Pin model"}
        className={cn(
          "mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
          pinned
            ? "bg-[#aeb6ff]/[0.11] text-[#cbd0ff]"
            : "text-white/30 opacity-0 hover:bg-white/[0.06] hover:text-white/70 group-hover/model-row:opacity-100",
        )}
      >
        <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
      </button>
    </div>
  );
}

function ModelButton({
  engine,
  model,
  models,
  open,
  onToggle,
  onPick,
}: {
  engine: Engine;
  model: EngineModel | null;
  models: EngineModel[];
  open: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [pinnedByEngine, setPinnedByEngine] = useState<Record<string, string[]>>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(PINNED_MODELS_KEY) ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const filtered = s
      ? models.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(s))
      : models;
    return [...filtered].sort((a, b) => a.label.localeCompare(b.label));
  }, [models, q]);
  const pinnedIds = pinnedByEngine[engine.id] ?? DEFAULT_MODEL_PINS[engine.id] ?? [];
  const pinnedSet = new Set(pinnedIds);
  const pinned = q ? [] : shown.filter((item) => pinnedSet.has(item.id));
  const standard = q ? shown : shown.filter((item) => !pinnedSet.has(item.id));
  const togglePin = (id: string) => {
    setPinnedByEngine((current) => {
      const currentIds = current[engine.id] ?? DEFAULT_MODEL_PINS[engine.id] ?? [];
      const nextIds = currentIds.includes(id)
        ? currentIds.filter((item) => item !== id)
        : [...currentIds, id];
      const next = { ...current, [engine.id]: nextIds };
      try {
        window.localStorage.setItem(PINNED_MODELS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked */
      }
      return next;
    });
  };
  const brand = model
    ? brandForModel(model.id, engine.id)
    : (BRANDS[engine.id] ?? BRANDS.openrouter);
  const displayLabel = compactModelLabel(model);
  const close = useCallback(() => {
    if (open) onToggle();
  }, [open, onToggle]);
  const wrap = useDismiss(open, close);

  return (
    <div className="group/model relative shrink-0" ref={wrap}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Choose model. Current model: ${model?.label ?? "none"}`}
        title={`${model?.label ?? "Choose model"} · ${model ? modelRateLabel(model) : ""}`}
        className="inline-flex h-9 max-w-[190px] items-center gap-2 rounded-[11px] border border-white/[0.14] bg-[#121722] px-2.5 text-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)] transition-all hover:border-white/25 hover:bg-white/[0.06]"
        style={{ borderColor: `${brand.tone}44`, backgroundColor: `${brand.tone}0a` }}
      >
        <BrandMark brand={brand} className="h-4 w-4 shrink-0" />
        <span className="truncate text-[11.5px] font-medium text-white/78">{displayLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-white/34" />
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 z-[80] mb-3 w-[540px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-[20px] border border-white/[0.11] bg-[#202533]/[0.99] shadow-2xl backdrop-blur-2xl"
          style={{ boxShadow: "0 34px 90px -24px rgba(0,0,0,0.98)" }}
        >
          <div className="border-b border-white/[0.08] p-3">
            <div className="mb-2.5 flex items-center justify-between px-0.5">
              <span>
                <span className="block text-[12.5px] font-medium text-white/88">
                  Choose a model
                </span>
                <span className="mt-0.5 block text-[9.5px] text-white/30">
                  {models.length} available through {engine.label}
                </span>
              </span>
              {model && (
                <span className="inline-flex max-w-[190px] items-center gap-1.5 rounded-lg border border-[#aeb6ff]/20 bg-[#aeb6ff]/[0.07] px-2 py-1 text-[9.5px] text-[#d9ddff]/76">
                  <BrandMark brand={brand} className="h-3 w-3 shrink-0" />
                  <span className="truncate">{displayLabel}</span>
                </span>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`Search ${models.length} models…`}
                className="w-full rounded-xl border border-white/10 bg-[#171c29] py-2 pl-8 pr-3 text-[12px] text-white placeholder:text-white/35 focus:border-[#aeb6ff]/40 focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-[330px] overflow-y-auto p-1.5" role="listbox">
            {shown.length === 0 ? (
              <div className="px-3.5 py-6 text-center text-[12px] text-muted-foreground">
                No model matches.
              </div>
            ) : q ? (
              shown.map((item) => (
                <ModelOption
                  key={item.id}
                  model={item}
                  engine={engine}
                  selected={model?.id === item.id}
                  pinned={pinnedSet.has(item.id)}
                  onPick={onPick}
                  onTogglePin={togglePin}
                />
              ))
            ) : (
              <>
                {pinned.length > 0 && (
                  <div className="mb-1">
                    <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1 text-[9.5px] uppercase tracking-[0.16em] text-[#cbd0ff]/65">
                      <Pin className="h-3 w-3 fill-current" /> Pinned
                    </div>
                    {pinned.map((item) => (
                      <ModelOption
                        key={item.id}
                        model={item}
                        engine={engine}
                        selected={model?.id === item.id}
                        pinned
                        onPick={onPick}
                        onTogglePin={togglePin}
                      />
                    ))}
                  </div>
                )}
                {standard.length > 0 && (
                  <div>
                    <div className="px-2.5 pb-1.5 pt-2 text-[9.5px] uppercase tracking-[0.16em] text-white/28">
                      All models · A to Z
                    </div>
                    {standard.map((item) => (
                      <ModelOption
                        key={item.id}
                        model={item}
                        engine={engine}
                        selected={model?.id === item.id}
                        pinned={false}
                        onPick={onPick}
                        onTogglePin={togglePin}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RatioShape({ value }: { value: string }) {
  const [rawW, rawH] = value.split(":").map(Number);
  const w = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
  const h = Number.isFinite(rawH) && rawH > 0 ? rawH : 1;
  const scale = Math.min(28 / w, 19 / h);
  return (
    <span
      aria-hidden
      className="inline-block rounded-[3px] border border-current bg-current/10"
      style={{ width: Math.max(8, w * scale), height: Math.max(8, h * scale) }}
    />
  );
}

function RatioControl({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const wrap = useDismiss(open, close);

  return (
    <div className="relative shrink-0" ref={wrap}>
      <button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="inline-flex h-[36px] min-w-[78px] items-center justify-center gap-2 rounded-[11px] border border-white/[0.14] bg-[#121722] px-2.5 text-[11.5px] text-white/68 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)] transition-colors hover:border-white/25 hover:text-white/90"
      >
        <RatioShape value={value} />
        <span>{value}</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 z-[80] mb-3 w-[292px] rounded-2xl border border-white/10 bg-[#222736]/[0.99] p-2 shadow-2xl backdrop-blur-2xl"
          role="listbox"
        >
          <div className="px-2 pb-2 pt-1">
            <div className="text-[11.5px] font-medium text-white/82">Canvas ratio</div>
            <div className="text-[10px] text-white/32">Pick the frame you are designing for</div>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {options.map((option) => (
              <button
                key={option}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                role="option"
                aria-selected={value === option}
                className={cn(
                  "flex h-[66px] flex-col items-center justify-center gap-1.5 rounded-xl border text-[10.5px] transition-colors",
                  value === option
                    ? "border-[#b6bdff]/45 bg-[#aeb6ff]/14 text-[#e1e4ff]"
                    : "border-white/[0.07] text-white/48 hover:bg-white/[0.05] hover:text-white/85",
                )}
              >
                <span className="flex h-6 items-center justify-center">
                  <RatioShape value={option} />
                </span>
                {option}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ParamControl({
  spec,
  modelId,
  value,
  onChange,
}: {
  spec: ParamSpec;
  modelId?: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = PARAM_LABEL[spec.name] ?? spec.name.replace(/_/g, " ");
  const options = visibleParamOptions(spec, modelId);

  if ((spec.name === "aspect_ratio" || spec.name === "image_size") && options.length) {
    return (
      <RatioControl
        options={options}
        value={String(value ?? visibleParamDefault(spec, modelId))}
        onChange={onChange}
      />
    );
  }

  if (spec.type === "boolean") {
    const on = Boolean(value);
    return (
      <button
        onClick={() => onChange(!on)}
        aria-pressed={on}
        title={label}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-[11px] border px-2.5 py-2 text-[11.5px] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)] transition-colors",
          on
            ? "border-[#b6bdff]/40 bg-[#aeb6ff]/14 text-[#d8dcff]"
            : "border-white/[0.14] bg-[#121722] text-white/45 hover:border-white/25 hover:bg-white/5 hover:text-white/80",
        )}
      >
        {label}
        <span
          className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-green-400" : "bg-muted-foreground/40")}
        />
      </button>
    );
  }

  if (spec.type === "integer") {
    return (
      <label
        className="inline-flex shrink-0 items-center gap-1.5 rounded-[11px] border border-white/[0.14] bg-[#121722] px-2.5 py-1.5 text-[11.5px] text-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)]"
        title={label}
      >
        <span className="text-muted-foreground">{label}</span>
        <input
          type="number"
          value={String(value ?? spec.default ?? 5)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-12 bg-transparent text-right tabular-nums focus:outline-none"
        />
      </label>
    );
  }

  if (!options.length) return null;

  if (spec.name === "output_format") {
    const selected = String(value ?? visibleParamDefault(spec));
    const next = options[(options.indexOf(selected) + 1) % options.length];
    return (
      <button
        onClick={() => onChange(next)}
        aria-label={`Format ${selected}`}
        title="Click to change format"
        className="shrink-0 rounded-[11px] border border-white/[0.14] bg-[#121722] px-2.5 py-2 text-[11.5px] uppercase text-white/68 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)] transition-colors hover:border-white/25 hover:text-white/90"
      >
        {selected}
      </button>
    );
  }

  if (spec.name === "resolution") {
    return (
      <div
        className="inline-flex shrink-0 items-center overflow-hidden rounded-[11px] border border-white/[0.14] bg-[#121722] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)]"
        title={label}
      >
        <span className="pl-2.5 pr-1 text-[11px]" aria-label="Quality">
          💎
        </span>
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            aria-pressed={String(value) === opt}
            className={cn(
              "px-2 py-2 text-[11.5px] uppercase transition-colors",
              String(value) === opt
                ? "bg-[#aeb6ff]/15 font-medium text-[#d8dcff] shadow-[inset_0_0_0_1px_rgba(174,182,255,0.25)]"
                : "text-white/45 hover:bg-white/5 hover:text-white/80",
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    );
  }

  if (spec.name === "quality") {
    return (
      <div
        className="inline-flex shrink-0 items-center overflow-hidden rounded-[11px] border border-white/[0.14] bg-[#121722] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)]"
        title="Image quality"
      >
        <span className="pl-2.5 pr-1 text-[11px]" aria-label="Quality">
          💎
        </span>
        {options.map((option) => (
          <button
            key={option}
            onClick={() => onChange(option)}
            aria-pressed={String(value) === option}
            className={cn(
              "px-2.5 py-2 text-[11px] capitalize transition-colors",
              String(value) === option
                ? "bg-[#aeb6ff]/15 font-medium text-[#d8dcff] shadow-[inset_0_0_0_1px_rgba(174,182,255,0.25)]"
                : "text-white/45 hover:bg-white/5 hover:text-white/80",
            )}
          >
            {option}
          </button>
        ))}
      </div>
    );
  }

  // Small enums read best as a segmented row; long ones as a select.
  if (options.length <= 4) {
    return (
      <div
        className="inline-flex shrink-0 overflow-hidden rounded-[11px] border border-white/[0.14] bg-[#121722] shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)]"
        title={label}
      >
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            aria-pressed={String(value) === opt}
            className={cn(
              "px-2.5 py-2 text-[11.5px] uppercase transition-colors",
              String(value) === opt
                ? "bg-[#aeb6ff]/15 font-medium text-[#d8dcff] shadow-[inset_0_0_0_1px_rgba(174,182,255,0.25)]"
                : "text-white/45 hover:bg-white/5 hover:text-white/80",
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    );
  }

  return (
    <select
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      title={label}
      className="shrink-0 rounded-[11px] border border-white/[0.14] bg-[#121722] px-2.5 py-2 text-[11.5px] text-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_8px_-5px_rgba(0,0,0,0.95)] focus:border-[#aeb6ff]/40 focus:outline-none"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {label === "Ratio" ? opt : `${label} ${opt}`}
        </option>
      ))}
    </select>
  );
}

// ── cards, lightbox ────────────────────────────────────────────────────────

function AgentChip({
  agent,
  engine,
  small,
}: {
  agent: AgentId;
  engine?: string | null;
  small?: boolean;
}) {
  const a = AGENT[agent];
  const iconCls = small ? "h-3 w-3" : "h-4 w-4";
  const brand = !a.logo && engine ? (BRANDS[engine] ?? null) : null;
  const label = brand ? brand.label : a.label;
  const tone = brand?.tone ?? a.tone;
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center rounded-[9px] border backdrop-blur",
        small ? "h-6 w-6" : "h-8 w-8",
      )}
      style={{ color: tone, borderColor: `${tone}55`, background: `${tone}22` }}
    >
      {a.logo ? (
        <img src={a.logo} alt="" className={cn(iconCls, "object-contain")} />
      ) : brand ? (
        <BrandMark brand={brand} className={iconCls} />
      ) : null}
    </span>
  );
}

function CreationCard({
  item,
  index,
  onOpen,
}: {
  item: LedgerItem;
  index: number;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      aria-label={`Open ${item.name}`}
      className="group relative overflow-hidden rounded-xl border border-white/[0.07] bg-[#1c2130] text-left transition-all hover:z-10 hover:border-[#b6bdff]/30 hover:shadow-[0_18px_44px_-22px_rgba(4,7,18,0.95)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6bdff]/35"
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <LazyMedia
          id={item.id}
          kind={item.kind}
          name={item.name}
          eager={index < EAGER_TILES}
          className="transition-transform duration-500 ease-out group-hover:scale-[1.018]"
        />
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {item.kind === "video" && (
            <span className="rounded-md bg-black/60 backdrop-blur px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/80">
              Video
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function CreationLightbox({
  item,
  onClose,
  onReference,
  onRemix,
  onAnimate,
  onDelete,
}: {
  item: LedgerItem;
  onClose: () => void;
  onReference: () => void;
  onRemix: () => void;
  onAnimate: () => void;
  onDelete: () => Promise<void>;
}) {
  const [copied, setCopied] = useState<"path" | "prompt" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [creditCost, setCreditCost] = useState<number | null>(null);
  const copy = async (what: "path" | "prompt", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const brand = item.model ? brandForModel(item.model, item.tool ?? "") : null;
  const params = item.params ?? {};
  // Measured from the file, not predicted from a quality tier.
  const px = item.w && item.h ? `${item.w}×${item.h}` : null;
  const recordedCost =
    typeof item.costUsd === "number"
      ? {
          value: compactUsd(item.costUsd),
          source:
            item.costSource === "estimate" ? "Saved provider-rate estimate" : "Provider reported",
        }
      : typeof item.costCredits === "number"
        ? {
            value: `${item.costCredits.toLocaleString()} credits`,
            source: "Quote saved at generation",
          }
        : creditCost !== null
          ? {
              value: `${creditCost.toLocaleString()} credits`,
              source: "Current Higgsfield quote for these settings",
            }
          : null;

  useEffect(() => {
    if (item.tool !== "higgsfield" || !item.model || typeof item.costCredits === "number") {
      setCreditCost(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const localToken = (await (await fetch("/__token")).json()).token as string;
        const response = await fetch("/__design_cost", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Claude-OS-Token": localToken },
          body: JSON.stringify({
            engine: "higgsfield",
            model: item.model,
            count: 1,
            params: item.params ?? {},
          }),
          signal: controller.signal,
        });
        const data = await response.json();
        if (response.ok && data.ok && Number.isFinite(Number(data.total))) {
          setCreditCost(Number(data.total));
        }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "AbortError") setCreditCost(null);
      }
    })();
    return () => controller.abort();
  }, [item]);

  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-white/45">{k}</span>
      <span className="text-[11.5px] text-white/85 text-right break-words">{v}</span>
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-hidden bg-[#111521]/96 p-3 backdrop-blur-xl md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Generation details"
    >
      {item.kind === "image" && (
        <img
          aria-hidden
          src={fileUrl(item.id)}
          alt=""
          className="pointer-events-none absolute inset-[-8%] h-[116%] w-[116%] scale-110 object-cover opacity-[0.13] blur-3xl"
        />
      )}
      <div
        className="relative z-10 flex max-h-full w-full max-w-[1500px] flex-col gap-3 lg:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto rounded-2xl border border-white/[0.09] bg-[#171c29]/75 p-2 shadow-[0_30px_90px_-36px_rgba(2,5,16,0.95)]">
          {item.kind === "video" ? (
            <video
              src={fileUrl(item.id)}
              controls
              autoPlay
              loop
              className="max-h-[calc(100vh-3rem)] max-w-full rounded-xl"
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setZoomed((current) => !current)}
                className="absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-[10px] border border-white/[0.14] bg-[#0c111a]/75 px-2.5 py-2 text-[10px] font-medium text-white/68 shadow-lg backdrop-blur-md transition-colors hover:bg-[#121925] hover:text-white"
                aria-label={zoomed ? "Fit image to viewer" : "Zoom image"}
              >
                {zoomed ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
                {zoomed ? "Fit" : "Zoom"}
              </button>
              <img
                src={fileUrl(item.id)}
                alt={item.name}
                onClick={() => setZoomed((current) => !current)}
                className={cn(
                  "rounded-xl object-contain transition-[width,max-width,max-height] duration-300",
                  zoomed
                    ? "h-auto w-[145%] max-h-none max-w-none cursor-zoom-out"
                    : "max-h-[calc(100vh-3rem)] max-w-full cursor-zoom-in",
                )}
              />
            </>
          )}
        </div>

        <div className="max-h-[calc(100vh-3rem)] w-full shrink-0 self-start overflow-y-auto rounded-2xl border border-white/10 bg-[#202534]/94 p-4 shadow-2xl backdrop-blur-2xl lg:w-[360px] lg:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="mb-2">
                <AgentChip agent={item.agent} engine={item.tool} />
              </div>
              <div className="text-[13px] font-medium text-white/90">Generation details</div>
            </div>
            <button
              onClick={onClose}
              className="rounded-xl border border-white/10 p-2 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {item.prompt && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[9.5px] uppercase tracking-[0.18em] text-white/40">
                  Prompt
                </span>
                <button
                  onClick={() => copy("prompt", item.prompt!)}
                  className="inline-flex items-center gap-1 text-[11px] text-white/60 hover:text-white transition-colors"
                >
                  {copied === "prompt" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copied === "prompt" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#171c29] px-3 py-3 text-[12px] leading-relaxed text-white/82">
                {item.prompt}
              </div>
            </div>
          )}

          {item.references && item.references.length > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-[9.5px] uppercase tracking-[0.18em] text-white/40">
                  Reference inputs
                </span>
                <span className="text-[9.5px] tabular-nums text-white/28">
                  {item.references.length} used
                </span>
              </div>
              <div className="flex gap-2 overflow-x-auto rounded-xl border border-white/10 bg-[#171c29] p-2">
                {item.references.map((reference) => (
                  <div key={reference.id} className="w-[72px] shrink-0">
                    <div className="aspect-square overflow-hidden rounded-[9px] border border-white/10 bg-black/20">
                      {reference.alive ? (
                        <img
                          src={fileUrl(reference.id)}
                          alt={reference.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full place-items-center text-white/20">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                    <div
                      className="mt-1 truncate text-[8.5px] text-white/34"
                      title={reference.name}
                    >
                      {reference.name}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(recordedCost || item.tool === "higgsfield") && (
            <div className="mb-4 rounded-xl border border-[#9ce8d7]/15 bg-[#9ce8d7]/[0.045] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-[#cafff2]/65">
                  <WalletCards className="h-3.5 w-3.5" /> Generation cost
                </span>
                <span className="text-[13px] font-semibold tabular-nums text-white/90">
                  {recordedCost?.value ?? "Checking…"}
                </span>
              </div>
              <div className="mt-1 text-right text-[9px] text-white/30">
                {recordedCost?.source ?? "Fetching a live provider quote"}
              </div>
            </div>
          )}

          <div className="mb-4">
            <div className="text-[9.5px] uppercase tracking-[0.18em] text-white/40 mb-1">
              Provenance
            </div>
            <div className="divide-y divide-white/8">
              {item.model && (
                <div className="flex items-baseline justify-between gap-3 py-1">
                  <span className="text-[11px] text-white/45">Model</span>
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] text-white/85 text-right">
                    {brand && <BrandMark brand={brand} className="h-3 w-3" />}
                    {item.model}
                  </span>
                </div>
              )}
              {item.agent === "studio" && item.tool ? (
                <Row k="Engine" v={BRANDS[item.tool]?.label ?? item.tool} />
              ) : (
                <Row k="Source" v={AGENT[item.agent].label} />
              )}
              {px && <Row k="Size" v={`${px}px`} />}
              {Object.entries(params)
                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => (
                  <Row key={k} k={PARAM_LABEL[k] ?? k.replace(/_/g, " ")} v={String(v)} />
                ))}
              {item.look && <Row k="Style" v={item.look} />}
              <Row k="File" v={prettyBytes(item.bytes)} />
              <Row k="Created" v={new Date(item.ts).toLocaleString()} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-white/[0.08] pt-4">
            <button
              onClick={onRemix}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-2.5 py-2 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Wand2 className="h-3.5 w-3.5" /> Remix
            </button>
            <button
              onClick={onReference}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-2.5 py-2 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ImageIcon className="h-3.5 w-3.5" /> Reference
            </button>
            <a
              href={fileUrl(item.id)}
              download={item.name}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-2.5 py-2 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
            <button
              onClick={() => copy("path", item.path)}
              title="Copy the local file path so you can paste it into any chat"
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-2.5 py-2 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
            >
              {copied === "path" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied === "path" ? "Copied" : "Copy for chat"}
            </button>
            <button
              onClick={async () => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                setDeleting(true);
                try {
                  await onDelete();
                } finally {
                  setDeleting(false);
                }
              }}
              className={cn(
                "col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-[12px] transition-colors",
                confirmDelete
                  ? "border-rose-300/30 bg-rose-400/10 text-rose-100"
                  : "border-white/10 text-white/42 hover:border-rose-300/25 hover:text-rose-200",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleting ? "Moving…" : confirmDelete ? "Move to Trash?" : "Delete"}
            </button>
            {item.kind === "image" && (
              <div
                className="design-spectrum-frame col-span-2 mt-1 rounded-[13px] p-px"
                style={{
                  background:
                    "linear-gradient(110deg, #ff7959 0%, #f2cb65 24%, #62dec4 49%, #7396ff 74%, #d979f5 100%)",
                  backgroundSize: "220% 220%",
                }}
              >
                <button
                  onClick={onAnimate}
                  className="group/animate flex w-full items-center justify-between rounded-[12px] border border-black/60 bg-[#0b0f17] px-3 py-2.5 text-left text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.09)] transition-colors hover:bg-[#101621]"
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-[8px] border border-white/[0.09] bg-white/[0.045] text-white/75 transition-colors group-hover/animate:text-white">
                      <Film className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      <span className="block text-[11.5px] font-semibold">Animate image</span>
                      <span className="mt-0.5 block text-[9px] font-normal text-white/32">
                        Use this as the opening frame
                      </span>
                    </span>
                  </span>
                  <span className="text-[14px] text-white/30 transition-transform group-hover/animate:translate-x-0.5 group-hover/animate:text-white/60">
                    →
                  </span>
                </button>
              </div>
            )}
          </div>

          {item.cwd && (
            <div className="mt-4">
              <div className="text-[9.5px] uppercase tracking-[0.18em] text-white/40 mb-1.5">
                Built in
              </div>
              <code className="block text-[11px] text-white/70 break-all">{item.cwd}</code>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Library — the disk scan ────────────────────────────────────────────────

let libraryCache: { data: MediaResponse; scannedAt: number } | null = null;

function LibraryTab({ onUseAsReference }: { onUseAsReference: (item: MediaItem) => void }) {
  const [data, setData] = useState<MediaResponse | null>(() => libraryCache?.data ?? null);
  const [loading, setLoading] = useState(() => !libraryCache);
  const [lastScan, setLastScan] = useState<number | null>(() => libraryCache?.scannedAt ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [indexStatus, setIndexStatus] = useState<DesignIndexStatus | null>(null);
  const [kind, setKind] = useState<"all" | "image" | "video">("all");
  const [project, setProject] = useState<string>("all");
  const [sort, setSort] = useState<LibrarySort>("relevance");
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [visionConfirm, setVisionConfirm] = useState(false);
  const [visionStarting, setVisionStarting] = useState(false);
  const scanInFlight = useRef(false);
  const lastOcrRequest = useRef("");
  const draftQueryRef = useRef(draftQuery);
  draftQueryRef.current = draftQuery;

  const load = useCallback((silent = false) => {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    if (!silent) {
      setLoading(true);
      setErr(null);
    }
    fetch("/__design_media?limit=600")
      .then((r) => r.json())
      .then((d: MediaResponse) => {
        if (!d.ok) throw new Error(d.error || "scan failed");
        setData(d);
        const scannedAt = Date.now();
        libraryCache = { data: d, scannedAt };
        setLastScan(scannedAt);
      })
      .catch((e) => {
        if (!silent) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        scanInFlight.current = false;
        if (!silent) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!libraryCache) load();
  }, [load]);

  const refreshIndexStatus = useCallback(() => {
    fetch("/__design_index_status")
      .then((r) => r.json())
      .then((d: DesignIndexStatus) => {
        if (d.ok) setIndexStatus(d);
      })
      .catch(() => undefined);
  }, []);

  const stopIndex = useCallback(async () => {
    const csrf = (await (await fetch("/__token")).json()).token as string;
    await fetch("/__design_index_stop", {
      method: "POST",
      headers: { "X-Claude-OS-Token": csrf },
    });
    refreshIndexStatus();
  }, [refreshIndexStatus]);

  const startVisualUnderstanding = useCallback(async () => {
    setVisionStarting(true);
    setErr(null);
    try {
      const csrf = (await (await fetch("/__token")).json()).token as string;
      const response = await fetch("/__design_index_start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Claude-OS-Token": csrf },
        body: JSON.stringify({ scope: "library", mode: "vision" }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Visual understanding could not start");
      }
      setVisionConfirm(false);
      refreshIndexStatus();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setVisionStarting(false);
    }
  }, [refreshIndexStatus]);

  useEffect(() => {
    refreshIndexStatus();
    const interval = window.setInterval(refreshIndexStatus, 1_200);
    return () => window.clearInterval(interval);
  }, [refreshIndexStatus]);

  // Keep text inside the currently visible images searchable. This is local
  // Apple Vision OCR, not an API call: no image leaves the machine and there
  // is no usage charge. Changed files are the only ones processed again.
  useEffect(() => {
    if (!data || !indexStatus?.ocrAvailable || indexStatus.job?.running) return;
    const images = data.items.filter((item) => item.kind === "image");
    if (!images.length) return;
    const fingerprint = `${images.length}:${Math.max(...images.map((item) => item.mtime))}`;
    if (lastOcrRequest.current === fingerprint) return;
    lastOcrRequest.current = fingerprint;
    void (async () => {
      try {
        const token = (await (await fetch("/__token")).json()).token as string;
        const response = await fetch("/__design_index_start", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
          body: JSON.stringify({
            scope: "paths",
            mode: "ocr",
            paths: images.map((item) => item.path),
          }),
        });
        if (!response.ok) throw new Error("Image text indexing could not start");
        refreshIndexStatus();
      } catch (error) {
        setErr(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [data, indexStatus?.ocrAvailable, indexStatus?.job?.running, refreshIndexStatus]);

  // Keep discovery live without flashing the scan state or making the user
  // babysit a refresh button. Returning to the app also catches changes made
  // while it was in the background.
  useEffect(() => {
    const refreshIfStale = () => {
      const lastUpdated = libraryCache?.scannedAt ?? 0;
      if (document.visibilityState === "visible" && Date.now() - lastUpdated >= 45_000) {
        load(true);
      }
    };
    const interval = window.setInterval(refreshIfStale, 60_000);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [load]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // The gallery should not reshuffle between keystrokes. Commit a search
  // after a real pause, or immediately when the operator presses Enter or
  // leaves the field.
  useEffect(() => {
    const next = draftQuery.trim();
    if (!next) {
      setQuery("");
      setSearchResult(null);
      return;
    }
    const timer = window.setTimeout(() => setQuery(next), 700);
    return () => window.clearTimeout(timer);
  }, [draftQuery]);

  // Description search, when the index has something to say. Aborted on
  // change so an older query's answer can't overwrite a newer one.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResult(null);
      return;
    }
    setSearchResult((current) => (current?.query === q ? current : null));
    const ac = new AbortController();
    fetch(`/__design_search?q=${encodeURIComponent(q)}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (draftQueryRef.current.trim() !== q) return;

        const terms = q
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const localHits: SearchHit[] = (data?.items ?? []).flatMap((item) => {
          const normalized = `${item.name} ${item.project}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
          const words = normalized.split(/\s+/).filter(Boolean);
          const matchesTerm = (term: string) =>
            words.some((word) => word === term || word === `${term}s` || term === `${word}s`);
          if (!terms.every(matchesTerm)) return [];

          const folderParts = item.project
            .toLowerCase()
            .split(/[/\\]/)
            .map((part) => part.replace(/[^a-z0-9]+/g, " ").trim());
          const folderWords = folderParts.flatMap((part) => part.split(/\s+/).filter(Boolean));
          const filenameWords = item.name
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
          const dedicatedFolderMatch = terms.every((term) =>
            folderParts.some((part) => part === term || part === term + "s" || term === part + "s"),
          );
          const directFolderMatch = terms.every((term) =>
            folderWords.some((word) => word === term || word === `${term}s` || term === `${word}s`),
          );
          const directFilenameMatch = terms.every((term) =>
            filenameWords.some(
              (word) => word === term || word === `${term}s` || term === `${word}s`,
            ),
          );
          const score =
            (dedicatedFolderMatch ? 112 : directFolderMatch ? 58 : 46) +
            (directFilenameMatch ? 18 : 0) +
            (item.kind === "image" ? 6 : 0);
          return [{ id: item.id, path: item.path, desc: "", why: "file", score }];
        });

        const merged = new Map<string, SearchHit>();
        for (const hit of [...(d.ok ? d.hits : []), ...localHits]) {
          const current = merged.get(hit.id);
          if (!current || hit.score > current.score) merged.set(hit.id, hit);
        }
        setSearchResult({
          query: q,
          hits: [...merged.values()].sort((a, b) => b.score - a.score),
        });
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setSearchResult({ query: q, hits: [] });
      });
    return () => {
      ac.abort();
    };
  }, [data, query, indexStatus?.job?.running]);

  const items = useMemo(() => {
    const list = data?.items ?? [];
    const q = query.trim().toLowerCase();
    const activeHits = searchResult?.query === query ? searchResult.hits : null;
    const scored = activeHits ? new Map(activeHits.map((hit) => [hit.id, hit.score])) : null;
    const filtered = list.filter((m) => {
      if (kind !== "all" && m.kind !== kind) return false;
      if (project !== "all" && m.project !== project) return false;
      if (!q) return true;
      // Wait for the complete ranked response. The server already includes
      // filename and folder matches, so doing a second local pass here only
      // makes individual cards flash in before the rest of the results.
      return Boolean(scored?.has(m.id));
    });
    return filtered.sort((a, b) => {
      if (sort === "relevance" && q) {
        const filenameScore = (item: MediaItem) =>
          `${item.name} ${item.project}`.toLowerCase().includes(q) ? 100 : 0;
        const scoreA = filenameScore(a) + (scored?.get(a.id) ?? 0);
        const scoreB = filenameScore(b) + (scored?.get(b.id) ?? 0);
        if (scoreA !== scoreB) return scoreB - scoreA;
      }
      if (sort === "oldest") return a.mtime - b.mtime;
      if (sort === "largest") return b.bytes - a.bytes;
      if (sort === "smallest") return a.bytes - b.bytes;
      return b.mtime - a.mtime;
    });
  }, [data, query, kind, project, searchResult, sort]);

  const searchPending = Boolean(query && searchResult?.query !== query);

  const counts = useMemo(() => {
    const list = data?.items ?? [];
    return {
      images: list.filter((m) => m.kind === "image").length,
      videos: list.filter((m) => m.kind === "video").length,
    };
  }, [data]);

  const visionRunning = Boolean(indexStatus?.job?.running && indexStatus.job.mode === "vision");
  const visionEstimate = indexStatus?.visionEstimate;
  const visionCostSoFar = visionRunning
    ? `${compactUsd(indexStatus?.job?.spentUsd ?? 0)} spent this run`
    : visionEstimate?.trackedImages
      ? `${compactUsd(visionEstimate.trackedUsd)} recorded`
      : indexStatus?.visionIndexed
        ? `≈${compactUsd(visionEstimate?.estimatedProcessedUsd ?? 0)} estimated so far`
        : "No paid scan yet";
  const visionModelLabel = indexStatus?.model?.includes("gemini-2.5-flash-lite")
    ? "Gemini 2.5 Flash Lite"
    : (indexStatus?.model ?? "Visual index model");

  return (
    <div>
      {err && (
        <div className="rounded-xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-100 mb-6">
          {err}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <h2 className="min-w-0 flex-1 text-[16px] font-semibold tracking-[-0.02em] text-white/92">
          Your library
        </h2>
        {data && (
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-white/42">
            <span className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
              <strong className="mr-1 font-medium text-white/76">
                {data.total.toLocaleString()}
              </strong>
              found
            </span>
            <span className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
              <strong className="mr-1 font-medium text-white/76">{counts.images}</strong> images
            </span>
            <span className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
              <strong className="mr-1 font-medium text-white/76">{counts.videos}</strong> videos
            </span>
            <span className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
              <strong className="mr-1 font-medium text-white/76">{data.projects.length}</strong>
              folders
            </span>
          </div>
        )}
      </div>

      <div className="mb-5 overflow-hidden rounded-[16px] border border-white/[0.09] bg-[#171c24]/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_16px_42px_-32px_rgba(0,0,0,0.95)]">
        <div className="flex flex-wrap items-center gap-2 p-2">
          <div className="relative min-w-[240px] flex-1 lg:max-w-[390px]">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8fdac8]/65" />
            <input
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setQuery(draftQuery.trim());
              }}
              onBlur={() => setQuery(draftQuery.trim())}
              placeholder="Magic search your visuals…"
              className="w-full rounded-[11px] border border-white/[0.12] bg-[#111816] py-2.5 pl-9 pr-3 text-[12px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] outline-none placeholder:text-white/30 focus:border-[#8fdac8]/45"
            />
          </div>
          <Seg
            value={kind}
            onChange={setKind}
            options={[
              { v: "all", label: "All" },
              { v: "image", label: "Images" },
              { v: "video", label: "Video" },
            ]}
          />
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="max-w-[250px] rounded-[11px] border border-white/[0.12] bg-[#111816] px-3 py-2.5 text-[12px] text-white/68 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] outline-none focus:border-[#8fdac8]/40"
          >
            <option value="all">All folders</option>
            {(data?.projects ?? []).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} ({p.count})
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as LibrarySort)}
            aria-label="Sort visuals"
            title="Sort visuals"
            className="rounded-[11px] border border-white/[0.12] bg-[#111816] px-3 py-2.5 text-[12px] text-white/68 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] outline-none focus:border-[#8fdac8]/40"
          >
            <option value="relevance">Best match</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="largest">Largest first</option>
            <option value="smallest">Smallest first</option>
          </select>
        </div>
        <div className="grid border-t border-white/[0.075] lg:grid-cols-2">
          <section className="flex min-w-0 items-center gap-3 px-3 py-3 lg:border-r lg:border-white/[0.075]">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-[#79dfc6]/20 bg-[#79dfc6]/[0.07] text-[#8be4ce]">
              <ScanSearch className={cn("h-4 w-4", loading && "animate-pulse")} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-white/76">Magic Scan</span>
                <span className="rounded-full border border-[#79dfc6]/15 bg-[#79dfc6]/[0.055] px-1.5 py-0.5 text-[7.5px] font-medium uppercase tracking-[0.13em] text-[#92ddcb]/58">
                  Automatic · free
                </span>
              </div>
              <p className="mt-1 text-[9.5px] leading-relaxed text-white/34">
                Finds file changes and reads visible words locally. Nothing leaves this Mac.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[8.5px] text-white/29">
                <span className="font-medium tabular-nums text-[#8ddfca]/65">
                  {(indexStatus?.ocrIndexed ?? 0).toLocaleString()} text searchable
                </span>
                <span>{lastScan ? `Checked ${timeAgo(lastScan)}` : "Watching for changes"}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-white/[0.09] bg-white/[0.025] px-2.5 text-[9px] font-medium text-white/43 transition-colors hover:border-[#79dfc6]/25 hover:bg-[#79dfc6]/[0.06] hover:text-white/72 disabled:cursor-wait disabled:opacity-40"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
              {loading ? "Checking" : "Check now"}
            </button>
          </section>

          <section className="flex min-w-0 items-center gap-3 border-t border-white/[0.075] px-3 py-3 lg:border-t-0">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-[#aaa8ff]/20 bg-[#aaa8ff]/[0.07] text-[#bebcff]">
              <Eye className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-white/76">
                  Visual understanding
                </span>
                <span className="rounded-full border border-[#aaa8ff]/15 bg-[#aaa8ff]/[0.055] px-1.5 py-0.5 text-[7.5px] font-medium uppercase tracking-[0.13em] text-[#c2c0ff]/55">
                  Optional setup
                </span>
              </div>
              <p className="mt-1 text-[9.5px] leading-relaxed text-white/34">
                Adds scene and subject descriptions, so search understands what is actually shown.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[8.5px] text-white/29">
                <span className="font-medium tabular-nums text-[#c2c0ff]/65">
                  {(indexStatus?.visionIndexed ?? 0).toLocaleString()} understood
                </span>
                <span>{visionCostSoFar}</span>
                {visionRunning && indexStatus?.job && (
                  <span className="tabular-nums">
                    {indexStatus.job.done.toLocaleString()} /{" "}
                    {indexStatus.job.total.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                if (visionRunning) {
                  void stopIndex();
                } else {
                  setVisionConfirm(true);
                }
              }}
              disabled={
                Boolean(indexStatus?.job?.running && !visionRunning) ||
                (!visionRunning && visionEstimate?.pending === 0)
              }
              title={
                indexStatus?.available
                  ? "Add searchable descriptions to new and changed images"
                  : "Connect OpenRouter in Connections first"
              }
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border px-2.5 text-[9px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                visionRunning
                  ? "border-rose-300/18 bg-rose-300/[0.05] text-rose-100/60 hover:bg-rose-300/[0.09]"
                  : "border-[#aaa8ff]/20 bg-[#aaa8ff]/[0.055] text-[#d3d1ff]/58 hover:border-[#aaa8ff]/35 hover:bg-[#aaa8ff]/[0.1] hover:text-[#efeeff]",
              )}
            >
              {visionRunning ? (
                <Square className="h-2.5 w-2.5 fill-current" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
              {visionRunning
                ? "Stop"
                : visionEstimate?.pending === 0
                  ? "Up to date"
                  : "Understand new"}
            </button>
          </section>
        </div>

        {visionConfirm && !visionRunning && (
          <div className="border-t border-[#aaa8ff]/[0.13] bg-[linear-gradient(100deg,rgba(34,37,55,0.98),rgba(25,29,42,0.98))] px-3 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <BrandMark brand={BRANDS.openrouter} className="h-5 w-5 shrink-0" />
              <div className="min-w-[240px] flex-1">
                <div className="text-[10.5px] font-semibold text-white/76">
                  Understand {(visionEstimate?.pending ?? 0).toLocaleString()} new or changed images
                </div>
                <p className="mt-1 max-w-3xl text-[9.5px] leading-relaxed text-white/36">
                  A 512px copy is sent through OpenRouter to create a private searchable
                  description. Your originals stay where they are, and already-understood images are
                  skipped.
                </p>
              </div>
              <div className="grid min-w-[250px] grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-white/[0.075] bg-white/[0.07]">
                <div className="bg-[#171b27] px-3 py-2">
                  <div className="text-[7.5px] uppercase tracking-[0.13em] text-white/25">
                    Estimated maximum
                  </div>
                  <div className="mt-1 text-[11px] font-semibold tabular-nums text-white/76">
                    {compactUsd(visionEstimate?.estimatedUsd ?? 0)}
                  </div>
                </div>
                <div className="bg-[#171b27] px-3 py-2">
                  <div className="text-[7.5px] uppercase tracking-[0.13em] text-white/25">
                    Model
                  </div>
                  <div className="mt-1 truncate text-[10px] font-medium text-white/64">
                    {visionModelLabel}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setVisionConfirm(false)}
                className="h-8 rounded-[9px] px-2.5 text-[9px] text-white/36 transition-colors hover:bg-white/[0.05] hover:text-white/70"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={() => void startVisualUnderstanding()}
                disabled={!indexStatus?.available || visionStarting}
                className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-[#c6cbff]/35 bg-[#eef0ff] px-3 text-[9px] font-semibold text-[#171a25] transition-colors hover:bg-white disabled:border-white/[0.08] disabled:bg-white/[0.055] disabled:text-white/24"
              >
                {visionStarting ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <Eye className="h-3 w-3" />
                )}
                {indexStatus?.available ? "Start understanding" : "Connect OpenRouter first"}
              </button>
            </div>
            <div className="mt-2 text-right text-[8px] text-white/22">
              Conservative estimate at {compactUsd(visionEstimate?.perImageUsd ?? 0.0003)} per
              image. OpenRouter reports the actual charge as each image finishes.
            </div>
          </div>
        )}
      </div>

      {loading && !data ? (
        <div className="rounded-xl border border-dashed border-border/60 p-16 text-center text-sm text-muted-foreground">
          Scanning your folders…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 p-16 text-center">
          <div className="text-sm text-foreground mb-1">
            {searchPending ? "Searching your visuals…" : "Nothing matches"}
          </div>
          <div className="text-[12.5px] text-muted-foreground">
            {searchPending
              ? "Results will appear together when the search is ready."
              : "Try clearing the filters. New image text is indexed automatically in the background."}
          </div>
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}
        >
          {items.map((m, i) => (
            <Tile
              key={m.id}
              item={m}
              index={i}
              onOpen={() => setLightbox(m)}
              onUseAsReference={() => onUseAsReference(m)}
            />
          ))}
        </div>
      )}

      {data && (
        <details className="group mt-8 rounded-xl border border-border/50 bg-card/15 px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <FolderOpen className="h-3.5 w-3.5" />
            Folders scanned automatically
            <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mb-2 mt-3 flex flex-wrap gap-1.5">
            {(data.rootStatus ?? data.roots.map((r) => ({ root: r, found: 0, error: null }))).map(
              (s) => (
                <code
                  key={s.root}
                  title={s.error ? `${s.error} — ${s.root}` : `${s.found} files`}
                  className={cn(
                    "text-[11px] rounded border px-2 py-1",
                    s.error
                      ? "bg-amber-500/10 border-amber-300/40 text-amber-100"
                      : "bg-black/30 border-border/50",
                  )}
                >
                  {s.root.replace(/^\/Users\/[^/]+/, "~")}
                  {s.error ? ` · ${s.error}` : ` · ${s.found}`}
                </code>
              ),
            )}
          </div>
          {(data.rootStatus ?? []).some((s) => s.error) && (
            <p className="text-[11.5px] text-amber-100/80 leading-relaxed mb-2">
              {data.permHint ??
                "A folder above couldn't be read. Check its permissions, or point design.roots somewhere readable."}
            </p>
          )}
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            These are broad defaults, so expect screenshots and downloads mixed in with real work.
            Narrow it by adding <code className="text-foreground/80">design.roots</code> to{" "}
            <code className="text-foreground/80">~/.claude-os/config.json</code> — an array of
            folders, <code className="text-foreground/80">~</code> allowed. Build output, dependency
            folders and screen-recording frame dumps are always skipped.
          </p>
        </details>
      )}

      {lightbox && (
        <Lightbox
          item={lightbox}
          onClose={() => setLightbox(null)}
          onUseAsReference={() => onUseAsReference(lightbox)}
          onDelete={async () => {
            try {
              await moveDesignItemToTrash(lightbox.id);
              setLightbox(null);
              load();
            } catch (error) {
              setErr(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      )}
    </div>
  );
}

// ── shared leaf components ─────────────────────────────────────────────────

function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; label: string }>;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-[11px] border border-white/[0.12] bg-[#111816] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            "px-3 py-2 text-[12.5px] transition-colors",
            value === o.v
              ? "bg-[#bceedd]/12 font-medium text-[#d8fff4] shadow-[inset_0_0_0_1px_rgba(143,218,200,0.17)]"
              : "text-white/42 hover:bg-white/[0.05] hover:text-white/80",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tile({
  item,
  index,
  onOpen,
  onUseAsReference,
}: {
  item: MediaItem;
  index: number;
  onOpen: () => void;
  onUseAsReference: () => void;
}) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-xl border border-border/60 bg-card/30 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/30">
      <button
        onClick={onOpen}
        className="absolute inset-0 w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#8fdac8]/60"
        aria-label={`Open ${item.name}`}
      >
        <LazyMedia id={item.id} kind={item.kind} name={item.name} eager={index < EAGER_TILES} />
        <div className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/80 backdrop-blur">
          {item.kind === "video" ? "Video" : item.ext.slice(1)}
        </div>
        <div className="absolute inset-x-0 bottom-0 translate-y-full bg-gradient-to-t from-black/90 to-black/50 px-2.5 py-2 transition-transform group-hover:translate-y-0">
          <div className="truncate text-[11.5px] text-white/95">{item.name}</div>
          <div className="truncate text-[10px] text-white/55">
            {item.project} · {prettyBytes(item.bytes)} · {timeAgo(item.mtime)}
          </div>
        </div>
      </button>
      {item.kind === "image" && (
        <button
          type="button"
          onClick={onUseAsReference}
          className="absolute right-2 top-2 z-10 inline-flex translate-y-1 items-center gap-1.5 rounded-[9px] border border-white/20 bg-[#101a18]/88 px-2.5 py-1.5 text-[10px] font-medium text-white/85 opacity-0 shadow-[0_8px_20px_-10px_rgba(0,0,0,0.95)] backdrop-blur-md transition-all hover:border-[#9ce8d7]/45 hover:bg-[#173029] group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100"
          aria-label={`Use ${item.name} as a reference`}
        >
          <ImagePlus className="h-3.5 w-3.5 text-[#9ce8d7]" />
          Reference
        </button>
      )}
    </div>
  );
}

function Lightbox({
  item,
  onClose,
  onDelete,
  onUseAsReference,
}: {
  item: MediaItem;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onUseAsReference: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const copyPath = async () => {
    try {
      // The server's own path, unmodified. Reassembling it here would mean
      // picking a separator, which is wrong on one platform or the other.
      await navigator.clipboard.writeText(item.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="relative max-h-full max-w-6xl w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-white truncate">{item.name}</div>
            <div className="text-[12px] text-white/50 truncate">
              {item.project} · {prettyBytes(item.bytes)} · {timeAgo(item.mtime)}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {item.kind === "image" && (
              <button
                onClick={onUseAsReference}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#a4ead8]/35 bg-[#9ce8d7]/12 px-3 py-1.5 text-[12px] font-medium text-[#cafff2] transition-colors hover:border-[#a4ead8]/55 hover:bg-[#9ce8d7]/20"
              >
                <ImagePlus className="h-3.5 w-3.5" /> Use as reference
              </button>
            )}
            <a
              href={fileUrl(item.id)}
              download={item.name}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/10 transition-colors"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
            <button
              onClick={copyPath}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/10 transition-colors"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy for chat"}
            </button>
            <button
              onClick={() => {
                if (!confirmDelete) setConfirmDelete(true);
                else void onDelete();
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors",
                confirmDelete
                  ? "border-rose-300/30 bg-rose-400/10 text-rose-100"
                  : "border-white/20 text-white/60 hover:border-rose-300/25 hover:text-rose-200",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmDelete ? "Move to Trash?" : "Delete"}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-white/20 p-1.5 text-white/80 hover:bg-white/10 transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 flex items-center justify-center">
          {item.kind === "video" ? (
            <video
              src={fileUrl(item.id)}
              controls
              autoPlay
              loop
              className="max-h-[78vh] max-w-full rounded-lg"
            />
          ) : (
            <img
              src={fileUrl(item.id)}
              alt={item.name}
              className="max-h-[78vh] max-w-full rounded-lg object-contain"
            />
          )}
        </div>
      </div>
    </div>
  );
}
