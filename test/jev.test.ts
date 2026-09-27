import { describe, expect, it } from "vitest";
import { gatewayClient, isGatewayKey, Jev, type SystemOne } from "../src/jev.js";

const menu = { APE_PENGU: { desc: "ape", intent: { kind: "hold" as const } }, APE_BTC: { desc: "ape", intent: { kind: "hold" as const } } };
const ask = { strategy: "You are boozy.", state: { x: 1 }, menu, convictionLabels: ["tipsy", "buzzed", "wasted", "legendary"] };

function fake(result: unknown | (() => unknown), tokens = 500): SystemOne & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async systemOne(req) {
      calls.push(req);
      const r = typeof result === "function" ? (result as () => unknown)() : result;
      if (r instanceof Error) throw r;
      return { model: "jev-1.13.0", usage: { input_tokens: tokens, output_tokens: 0 }, answers: r } as never;
    },
  };
}

const answers = { action: { type: "choice", choice: "APE_PENGU", confidence: 0.62, probabilities: { APE_PENGU: 0.62, APE_BTC: 0.38 } }, conviction: { type: "score", score: 2.4, confidence: 0.5, legend: {}, probabilities: {} } };
const base = { apiKey: "k", model: "jev-1.13.0", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042 };

describe("Jev client", () => {
  it("returns choice, probabilities, rounded conviction and exact cost", async () => {
    const j = new Jev({ ...base, client: fake(answers, 500) });
    const r = await j.decide(ask);
    expect(r).toMatchObject({ ok: true, choice: "APE_PENGU", conviction: 2, inputTokens: 500 });
    expect(r.ok && r.costUsd).toBeCloseTo((500 * 0.042) / 1e6, 12);
    expect(j.spentTodayUsd).toBeCloseTo(0.000021, 12);
  });

  it("sends the menu as a choice question and the conviction rubric as a score", async () => {
    const f = fake(answers);
    await new Jev({ ...base, client: f }).decide(ask);
    const req = f.calls[0] as { model: string; questions: { action: { type: string; criteria: object }; conviction: { type: string; criteria: string[] } } };
    expect(req.model).toBe("jev-1.13.0");
    expect(req.questions.action.type).toBe("choice");
    expect(Object.keys(req.questions.action.criteria)).toEqual(["APE_PENGU", "APE_BTC"]);
    expect(req.questions.conviction.criteria).toEqual(["tipsy", "buzzed", "wasted", "legendary"]);
  });

  it("trips the daily cap and stops calling", async () => {
    const f = fake(answers, 1_000_000); // $0.042 per call
    const j = new Jev({ ...base, dailyUsdCap: 0.05, client: f });
    expect((await j.decide(ask)).ok).toBe(true);
    expect((await j.decide(ask)).ok).toBe(true);
    const third = await j.decide(ask);
    expect(third).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(f.calls.length).toBe(2);
  });

  it("the cap resets at 00:00 UTC", async () => {
    let now = Date.UTC(2026, 8, 24, 23, 59);
    const j = new Jev({ ...base, dailyUsdCap: 0.01, spentTodayUsd: 0.02, client: fake(answers), now: () => now });
    expect(j.capTripped).toBe(true);
    now = Date.UTC(2026, 8, 25, 0, 1);
    expect(j.capTripped).toBe(false);
  });

  it("fails closed on errors and backs off on 429", async () => {
    let now = 1_000_000;
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const f = fake(() => err);
    const j = new Jev({ ...base, client: f, now: () => now });
    expect(await j.decide(ask)).toMatchObject({ ok: false, reason: "error" });
    expect(j.downSince).toBe(1_000_000);
    expect(await j.decide(ask)).toMatchObject({ ok: false, reason: "backoff" });
    expect(f.calls.length).toBe(1);
    now += 2_001;
    await j.decide(ask);
    expect(f.calls.length).toBe(2);
  });

  it("rejects an off-menu choice", async () => {
    const bad = { ...answers, action: { ...answers.action, choice: "YOLO" } };
    expect(await new Jev({ ...base, client: fake(bad) }).decide(ask)).toMatchObject({ ok: false, error: { code: "OFF_MENU" } });
  });

  it("never calls with an empty menu", async () => {
    const f = fake(answers);
    expect(await new Jev({ ...base, client: f }).decide({ ...ask, menu: {} })).toMatchObject({ ok: false });
    expect(f.calls.length).toBe(0);
  });
});

describe("Jev via Vercel AI Gateway", () => {
  const evalResult = {
    answers: {
      action: { type: "choice", choice: "APE_PENGU", probabilities: { APE_PENGU: 0.7, APE_BTC: 0.3 } },
      conviction: { type: "score", score: 2.2, probabilities: { "0": 0, "1": 0.1, "2": 0.6, "3": 0.3 } },
    },
    usage: { inputTokens: 640, outputTokens: 70 },
    providerMetadata: { typesafe: { confidence: { action: 0.9, conviction: 0.4 } } },
    response: { modelId: "typesafe-ai/jev" },
  };

  it("picks the gateway only for vck_ keys", () => {
    expect(isGatewayKey("vck_abc")).toBe(true);
    expect(isGatewayKey("ts_abc")).toBe(false);
  });

  it("passes the questions through and maps answers, confidence and usage back", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const evaluate = (async (o: Record<string, unknown>) => (calls.push(o), evalResult)) as never;
    const j = new Jev({ ...base, apiKey: "vck_test", client: gatewayClient("vck_test", evaluate) });
    const r = await j.decide(ask);
    expect(r).toMatchObject({ ok: true, choice: "APE_PENGU", confidence: 0.9, conviction: 2, inputTokens: 640, model: "typesafe-ai/jev" });
    expect(r.ok && r.costUsd).toBeCloseTo((640 * 0.042) / 1e6, 12);
    const q = calls[0]!.questions as { action: { type: string; criteria: object } };
    expect(q.action.type).toBe("choice");
    expect(Object.keys(q.action.criteria)).toEqual(["APE_PENGU", "APE_BTC"]);
    expect(calls[0]!.maxRetries).toBe(0);
  });

  it("backs off on a gateway 429", async () => {
    const now = 1_000_000;
    const evaluate = (async () => {
      throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    }) as never;
    const j = new Jev({ ...base, apiKey: "vck_test", client: gatewayClient("vck_test", evaluate), now: () => now });
    expect(await j.decide(ask)).toMatchObject({ ok: false, reason: "error" });
    expect(await j.decide(ask)).toMatchObject({ ok: false, reason: "backoff" });
  });
});
