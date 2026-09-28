// Weekly regime filter: Trend trades with each coin's 21-week EMA; Momentum buys only while BTC is above its own.
import { describe, expect, it } from "vitest";
import { boozy } from "../src/bees/boozy.js";
import { breezy } from "../src/bees/breezy.js";
import { regimeBlock, withRegime } from "../src/bees/regime.js";
import { emaOfConfirmed } from "../src/market/indicators.js";
import { bee, coin, ctx, position, testConfig, trend, view } from "./fixtures.js";

const btc = (px: number, ema: number | null) => coin("BTC", { trend: trend({ score: 5 }), ema21wPx: ema }, px);
const eth = (px: number, ema: number | null) => coin("ETH", { trend: trend({ score: -5 }), ema21wPx: ema }, px);

describe("regimeBlock", () => {
  it("Trend: longs only above the coin's 21-week EMA, shorts only below", () => {
    const v = view([btc(110, 100), eth(90, 100)]);
    const c = ctx("breezy", bee("breezy"), v);
    const [b, e] = [...v.stats.values()];
    expect(regimeBlock("breezy", b!.instId, "long", c)).toBeNull();
    expect(regimeBlock("breezy", b!.instId, "short", c)).toMatch(/BTC above/);
    expect(regimeBlock("breezy", e!.instId, "short", c)).toBeNull();
    expect(regimeBlock("breezy", e!.instId, "long", c)).toMatch(/ETH below/);
  });
  it("Momentum: judges BTC, and leaves shorts alone", () => {
    const alt = coin("ENA", { ret7dPct: 40 });
    const up = ctx("boozy", bee("boozy"), view([alt, btc(110, 100)]));
    const down = ctx("boozy", bee("boozy"), view([alt, btc(90, 100)]));
    expect(regimeBlock("boozy", alt.instId, "long", up)).toBeNull();
    expect(regimeBlock("boozy", alt.instId, "long", down)).toMatch(/BTC below/);
    expect(regimeBlock("boozy", alt.instId, "short", down)).toBeNull();
  });
  it("no weekly data blocks the entry", () => {
    const v = view([btc(110, null)]);
    expect(regimeBlock("breezy", [...v.stats.keys()][0]!, "long", ctx("breezy", bee("breezy"), v))).toMatch(/no weekly data/);
  });
});

describe("withRegime", () => {
  it("Trend's flat menu keeps only the moves with the regime", () => {
    const c = ctx("breezy", bee("breezy"), view([btc(110, 100), eth(90, 100)]));
    expect(Object.keys(withRegime(breezy, "breezy").menu(c)).sort()).toEqual(["LONG_BTC", "SHORT_ETH"]);
  });
  it("Momentum: BTC below its EMA empties the flat menu, blocks the forced entry and says why", () => {
    const b = withRegime(boozy, "boozy");
    const c = ctx("boozy", bee("boozy"), view([coin("ENA", { ret7dPct: 40, ret24hPct: 5 }), btc(90, 100)]));
    expect(b.menu(c)).toEqual({});
    expect(b.forcedEntry(c)).toBeNull();
    expect(b.idleStatus!(c)).toBe("waiting: BTC below its 21-week average");
  });
  it("Momentum: a held long keeps RIDE but loses DOUBLE_DOWN below the EMA", () => {
    const ena = coin("ENA", { ret7dPct: 40, ret24hPct: 5, atr14Pct: 0.5 }, 110);
    const cfg = testConfig();
    const p = position(ena, { entryPx: 100, openedAt: 0, stopPx: 95, initialStopPx: 95 });
    const withAdd = ctx("boozy", bee("boozy", { position: p, flatSince: null }), view([ena, btc(110, 100)]), cfg);
    const noAdd = ctx("boozy", bee("boozy", { position: p, flatSince: null }), view([ena, btc(90, 100)]), cfg);
    const b = withRegime(boozy, "boozy");
    expect(Object.keys(boozy.menu(noAdd))).toContain("DOUBLE_DOWN");
    expect(Object.keys(b.menu(withAdd))).toContain("DOUBLE_DOWN");
    expect(Object.keys(b.menu(noAdd))).not.toContain("DOUBLE_DOWN");
    expect(Object.keys(b.menu(noAdd))).toContain("RIDE");
  });
});

describe("emaOfConfirmed", () => {
  const bar = (c: number, confirmed = true) => ({ ts: 0, o: c, h: c, l: c, c, volUsd: 0, confirmed });
  it("null with fewer than `period` confirmed bars; the open bar is ignored", () => {
    expect(emaOfConfirmed([bar(1), bar(2), bar(3, false)], 3)).toBeNull();
    expect(emaOfConfirmed([bar(5), bar(5), bar(5), bar(50, false)], 3)).toBe(5);
  });
});
