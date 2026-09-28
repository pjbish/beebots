// Weekly regime filter (research/youtubers, 2026-09-28): only trade with the 21-week EMA. Trend judges the coin it
// trades: longs above its 21-week EMA, shorts below. Momentum judges BTC: no new longs while BTC is below it (shorts are
// left alone). Opens, switches, adds, forced entries and rebalances all pass through here; open positions are not closed.
import type { StyleId } from "../settings.js";
import type { CoinStats } from "../market/types.js";
import type { BeeBrain, BeeContext, Intent, Menu, Side } from "./types.js";

const btc = (ctx: BeeContext): CoinStats | undefined => [...ctx.view.stats.values()].find((s) => s.coin === "BTC" && s.ema21wPx !== undefined);

/** Why this entry is against the weekly regime, or null when it is allowed. No weekly data blocks it (fail closed). */
export function regimeBlock(style: StyleId, instId: string, side: Side, ctx: BeeContext): string | null {
  const trend = style === "breezy";
  if (!trend && side === "short") return null;
  const ref = trend ? ctx.view.stats.get(instId) : btc(ctx);
  const name = ref?.coin ?? (trend ? instId.split("-")[0] : "BTC");
  const ema = ref?.ema21wPx;
  if (!ref || ema === null || ema === undefined) return `regime: no weekly data for ${name}`;
  const above = ref.mid > ema;
  if (side === "long" && !above) return `regime: ${name} below its 21-week average`;
  if (side === "short" && above) return `regime: ${name} above its 21-week average`;
  return null;
}

const entryOf = (i: Intent, ctx: BeeContext): { instId: string; side: Side } | null => {
  if (i.kind === "open" || i.kind === "switch") return { instId: i.instId, side: i.side };
  if (i.kind === "add" && ctx.bee.position) return { instId: ctx.bee.position.instId, side: ctx.bee.position.side };
  return null;
};

export function withRegime(base: BeeBrain, style: StyleId): BeeBrain {
  const blocked = (i: Intent | null, ctx: BeeContext) => {
    const e = i && entryOf(i, ctx);
    return e ? regimeBlock(style, e.instId, e.side, ctx) : null;
  };
  const rule =
    style === "breezy"
      ? " Weekly regime filter: you may only go long a coin above its 21-week average and short one below it; the code removes the other moves."
      : " Weekly regime filter: no new longs while BTC is below its 21-week average; the code removes those moves.";
  return {
    ...base,
    strategy: base.strategy + rule,
    coinSnapshot: (s, ctx) => {
      const row = base.coinSnapshot(s, ctx);
      if (style === "breezy" && s.ema21wPx) row.vs_21w_pct = Number((((s.mid - s.ema21wPx) / s.ema21wPx) * 100).toFixed(1));
      return row;
    },
    menu: (ctx) => {
      const m: Menu = {};
      for (const [label, opt] of Object.entries(base.menu(ctx))) if (!blocked(opt.intent, ctx)) m[label] = opt;
      return m;
    },
    forcedEntry: (ctx) => {
      const f = base.forcedEntry(ctx);
      return f && !blocked(f, ctx) ? f : null;
    },
    ...(base.rebalance
      ? {
          rebalance: (ctx: BeeContext) => {
            const a = base.rebalance!(ctx);
            return a && !blocked(a, ctx) ? a : null;
          },
        }
      : {}),
    idleStatus: (ctx) => {
      if (!ctx.bee.position && style !== "breezy") {
        const why = regimeBlock(style, "", "long", ctx);
        if (why) return `waiting: ${why.replace("regime: ", "")}`;
      }
      return base.idleStatus?.(ctx) ?? "no valid options";
    },
  };
}
