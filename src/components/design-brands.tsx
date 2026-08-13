// Brand marks for the engines and the model families behind them.
// Canonical glyphs where a brand publishes one; a styled monogram where it
// does not.

import kieLogo from "@/assets/kie-logo.png";
import grokLogo from "@/assets/logo-grok.svg";
import minimaxLogo from "@/assets/logo-minimax.svg";
import qwenLogo from "@/assets/logo-qwen.svg";

export type Brand = {
  id: string;
  label: string;
  tone: string;
  /** SVG path data, or null for monogram brands. */
  path: string | null;
  /** Multi-colour marks, such as Google's G. */
  paths?: Array<{ d: string; fill: string }>;
  viewBox?: string;
  image?: string;
};

export const BRANDS: Record<string, Brand> = {
  google: {
    id: "google",
    label: "Google",
    tone: "#4285F4",
    path: null,
    paths: [
      {
        fill: "#4285F4",
        d: "M21.6 12.227c0-.709-.064-1.391-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.995 3.018v2.509h3.236c1.893-1.743 2.977-4.309 2.977-7.35Z",
      },
      {
        fill: "#34A853",
        d: "M12 22c2.7 0 4.964-.895 6.623-2.423l-3.236-2.509c-.895.6-2.041.955-3.387.955-2.605 0-4.809-1.759-5.596-4.123H3.06v2.591A10 10 0 0 0 12 22Z",
      },
      {
        fill: "#FBBC05",
        d: "M6.404 13.9A6.01 6.01 0 0 1 6.091 12c0-.659.114-1.3.313-1.9V7.509H3.06A10 10 0 0 0 2 12c0 1.614.386 3.141 1.06 4.491L6.404 13.9Z",
      },
      {
        fill: "#EA4335",
        d: "M12 5.977c1.468 0 2.786.505 3.823 1.496l2.873-2.873C16.959 2.982 14.7 2 12 2a10 10 0 0 0-8.94 5.509L6.404 10.1C7.191 7.736 9.395 5.977 12 5.977Z",
      },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    tone: "#10A37F",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  bytedance: {
    id: "bytedance",
    label: "ByteDance",
    tone: "#4E9CF8",
    path: "M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z",
  },
  xai: {
    id: "xai",
    label: "xAI",
    tone: "#E5E7EB",
    path: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z",
    image: grokLogo,
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    tone: "#F97316",
    path: "M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997",
    image: minimaxLogo,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    tone: "#94A3B8",
    path: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
  },
  replicate: {
    id: "replicate",
    label: "Replicate",
    tone: "#CBD5E1",
    path: "M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z",
  },
  higgsfield: {
    id: "higgsfield",
    label: "Higgsfield",
    tone: "#F2F4FA",
    viewBox: "0 0 20 20",
    path: "M18.3498 9.83713L18.3339 9.65759C18.1831 7.93447 17.0963 4.69261 14.0816 4.69261C11.8445 4.69261 10.1545 6.97097 8.66311 8.97967C7.47302 10.5883 6.4419 11.9683 5.3073 11.9683C5.00574 11.9357 4.61708 11.7805 4.3792 11.4294C4.16497 11.1108 4.10948 10.7026 4.22046 10.2126C4.39489 9.43684 5.39463 8.7182 6.44963 7.95063C7.02864 7.54238 7.6238 7.10955 8.03634 6.69311C9.22643 5.5091 9.82932 4.65164 9.82932 3.2717C9.82932 1.89176 9.09157 1.20565 8.47276 0.911636C7.23514 0.323844 5.41851 0.666781 4.26026 1.69583C4.08583 1.85922 3.91117 2.01418 3.75243 2.16119C2.58622 3.23097 1.80094 3.95781 0 3.40232V5.63972C2.38791 6.72588 4.39512 4.65164 5.15675 3.69633C5.74372 3.06758 6.36253 2.70006 6.82283 2.70006H6.84671C7.05298 2.70825 7.22741 2.78995 7.35454 2.93696C7.56081 3.18204 7.64018 3.46786 7.60038 3.78622C7.51305 4.45594 6.83875 5.23967 5.60113 6.09713C4.14928 7.10159 1.7218 8.78374 1.53122 10.8987C1.3884 12.4177 2.15003 13.9365 3.34012 14.5243C6.11669 15.8798 7.80665 13.5444 9.5994 11.0783C10.9719 9.1756 12.273 7.37103 14.0818 7.37103C15.7081 7.37103 16.311 8.75916 16.311 9.63301V9.80459L16.1523 9.83713C12.2095 10.5558 10.0595 14.3611 10.0595 16.1167C10.0595 17.8724 11.5034 19.375 13.2804 19.375C15.359 19.375 17.9293 17.5458 18.3419 12.4013L18.3578 12.2136H20V9.83737H18.3498V9.83713ZM16.1998 12.4746C15.8826 15.5531 14.3513 16.9904 13.4232 16.9904C13.0027 16.9904 12.4158 16.631 12.4158 15.9615C12.4158 15.2104 13.5026 12.932 15.946 12.2543L16.2316 12.1808L16.1998 12.4748V12.4746Z",
  },
  kie: {
    id: "kie",
    label: "Kie.ai",
    tone: "#2497E8",
    path: null,
    image: kieLogo,
  },
  // Wordmark brands use a quiet monogram until a canonical glyph is available.
  fal: { id: "fal", label: "fal", tone: "#8B5CF6", path: null },
  bfl: { id: "bfl", label: "Black Forest Labs", tone: "#F472B6", path: null },
  kling: { id: "kling", label: "Kling", tone: "#22D3EE", path: null },
  alibaba: { id: "alibaba", label: "Alibaba", tone: "#FB923C", path: null },
  qwen: { id: "qwen", label: "Qwen", tone: "#6F69F7", path: null, image: qwenLogo },
  recraft: { id: "recraft", label: "Recraft", tone: "#E879F9", path: null },
  topaz: { id: "topaz", label: "Topaz", tone: "#60A5FA", path: null },
  runway: { id: "runway", label: "Runway", tone: "#E7FE55", path: null },
  pixverse: { id: "pixverse", label: "PixVerse", tone: "#A78BFA", path: null },
  ideogram: { id: "ideogram", label: "Ideogram", tone: "#F8FAFC", path: null },
  happyhorse: { id: "happyhorse", label: "HappyHorse", tone: "#F9A8D4", path: null },
};

/** Which company actually made a given model, by its id. */
export function brandForModel(modelId: string, engineId: string): Brand {
  const m = modelId.toLowerCase();
  if (/nano[-_]?banana|gemini|veo|imagen|lyria/.test(m)) return BRANDS.google;
  if (/gpt[-_]?image|openai|dall|sora/.test(m)) return BRANDS.openai;
  if (/seedream|seedance|bytedance|seed_audio/.test(m)) return BRANDS.bytedance;
  if (/grok/.test(m)) return BRANDS.xai;
  if (/minimax|hailuo/.test(m)) return BRANDS.minimax;
  if (/flux/.test(m)) return BRANDS.bfl;
  if (/kling/.test(m)) return BRANDS.kling;
  if (/qwen/.test(m)) return BRANDS.qwen;
  if (/^wan/.test(m)) return BRANDS.alibaba;
  if (/recraft/.test(m)) return BRANDS.recraft;
  if (/topaz/.test(m)) return BRANDS.topaz;
  if (/runway/.test(m)) return BRANDS.runway;
  if (/pixverse/.test(m)) return BRANDS.pixverse;
  if (/ideogram/.test(m)) return BRANDS.ideogram;
  if (/happyhorse/.test(m)) return BRANDS.happyhorse;
  if (/soul|higgsfield/.test(m)) return BRANDS.higgsfield;
  return BRANDS[engineId] ?? BRANDS.openrouter;
}

export function BrandMark({
  brand,
  className,
  style,
}: {
  brand: Brand;
  className?: string;
  style?: React.CSSProperties;
}) {
  const cls = className ?? "h-4 w-4";
  if (brand.image) {
    return <img src={brand.image} alt="" className={`${cls} object-contain`} aria-hidden />;
  }
  if (brand.paths?.length || brand.path) {
    return (
      <svg
        viewBox={brand.viewBox ?? "0 0 24 24"}
        className={cls}
        fill="currentColor"
        style={{ color: brand.tone, ...style }}
        aria-hidden
      >
        {brand.paths?.map((part, index) => (
          <path key={`${brand.id}-${index}`} d={part.d} fill={part.fill} />
        ))}
        {brand.path && <path d={brand.path} />}
      </svg>
    );
  }
  // Monogram tile for the wordmark brands.
  return (
    <span
      className={`${cls} inline-flex items-center justify-center rounded-[5px] font-bold leading-none`}
      style={{
        background: `${brand.tone}22`,
        color: brand.tone,
        border: `1px solid ${brand.tone}55`,
        fontSize: "0.6em",
        ...style,
      }}
      aria-hidden
    >
      {brand.label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Short, honest blurbs for the models worth leading with. */
export const MODEL_BLURBS: Record<string, string> = {
  nano_banana_pro: "Google's flagship image model",
  nano_banana_flash: "Pro quality at Flash speed",
  nano_banana_2_lite: "Lightweight generation at speed",
  gpt_image_2: "Near-perfect text rendering",
  "gpt-image-2": "Strong layouts, editing and text",
  "openai/gpt-image-2": "Strong layouts, editing and text",
  "google/gemini-3.1-flash-image": "Fast, smart generation and editing",
  "google/gemini-3.1-flash-lite-image": "Low-cost, high-volume image creation",
  "google/gemini-3-pro-image": "Detailed professional image production",
  seedream_v5_pro: "Logically consistent, reasons about the scene",
  seedream_v5_lite: "Fast visual reasoning",
  seedream_v4_5: "ByteDance's 4K image model",
  flux_2: "Photoreal, expressive detail",
  text2image_soul_v2: "Ultra-realistic fashion visuals",
  soul_cinematic: "Cinema-grade stills",
  recraft_v4_1: "Vector-clean, brand-ready output",
  z_image: "Fast general-purpose images",
  seedance_2_0: "Cinematic video, pins both ends of a shot",
  seedance_2_0_mini: "Seedance at lower cost",
  seedance_2_5: "Newest Seedance video",
  kling3_0: "Long, stable motion",
  kling3_0_turbo: "Kling at speed",
  veo3_1: "Google's video model with audio",
  "nano-banana-2": "Google's Nano Banana 2, via Kie",
  "nano-banana-2-lite": "Faster Google image generation, via Kie",
  "nano-banana-pro": "Google's detailed professional image model, via Kie",
  "gpt-image-2-text-to-image": "OpenAI layouts, editing and text, via Kie",
  "gpt-image-2-image-to-image": "OpenAI reference-led image editing, via Kie",
  "seedream/5-pro-text-to-image": "ByteDance visual reasoning and 2K output, via Kie",
  "seedream/5-lite-text-to-image": "Faster ByteDance image generation, via Kie",
  "flux-2/pro-text-to-image": "Black Forest Labs photoreal detail, via Kie",
  "qwen3/pro-text-to-image": "Alibaba image generation and strong typography, via Kie",
  "bytedance/seedance-2-5": "Newest Seedance video, via Kie",
  "bytedance/seedance-2": "Seedance 2.0 video, via Kie",
  "kling-3.0/video": "Long, stable Kling motion, via Kie",
  "veo-3-1": "Google video generation with audio, via Kie",
  "gpt-image-1": "OpenAI's image model",
};
