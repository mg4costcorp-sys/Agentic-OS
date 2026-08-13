import { Coins } from "lucide-react";
import { CURRENCIES, useCurrency } from "@/lib/currency";

/**
 * Display-currency selector. Costs are billed by providers in USD, so this
 * converts at render time using live keyless rates — the stored data is never
 * rewritten. Falls back to showing USD (and says so) if rates can't be reached.
 */
export function CurrencyPicker() {
  const { selected, code, converted, rate, setCurrency } = useCurrency();
  const unavailable = selected !== "USD" && !converted;

  return (
    <div className="rounded-xl border border-border bg-card p-4 mb-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 grid place-items-center shrink-0 rounded-lg bg-foreground/5">
            <Coins className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Display currency</div>
            <div className="text-xs text-muted-foreground">
              {unavailable
                ? "Rates unavailable right now — showing USD."
                : converted
                  ? `Converted from USD at ${rate.toFixed(4)} · live rate`
                  : "Costs are billed in USD. Pick a currency to convert on screen."}
            </div>
          </div>
        </div>

        <select
          value={selected}
          onChange={(e) => setCurrency(e.target.value)}
          aria-label="Display currency"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40 transition-colors"
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 text-[11px] text-muted-foreground">
        Display only — your underlying spend data stays in USD, exactly as the providers bill it.
        {code !== "USD" && " Rates refresh daily and are cached for offline use."}
      </div>
    </div>
  );
}
