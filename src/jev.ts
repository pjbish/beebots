// Jev (TypeSafe AI) client: 2 s timeout, exponential backoff on 429/529, daily USD cap, cost accounting.
// Fail-closed: any failure returns { ok: false } and the risk layer holds.

import { createRequire } from "node:module";
import type * as SDK from "@typesafe-ai/sdk" with { "resolution-mode": "require" };
import { createGateway, experimental_evaluate } from "ai";
import type { Menu } from "./bees/types.js";
import { safeError } from "./redact.js";

// @typesafe-ai/sdk 0.6.0 ships only the CJS build (its ESM export path is missing), so load it via require.
const require = createRequire(import.meta.url);
const { TypeSafeClient, choice, score } = require("@typesafe-ai/sdk") as typeof SDK;

/** Jev through Vercel AI Gateway: no TypeSafe account needed, same price. Gateway keys start with vck_. */
export const GATEWAY_JEV_MODEL = "typesafe-ai/jev";
export const isGatewayKey = (key: string) => key.startsWith("vck_");

type Evaluate = typeof experimental_evaluate;

/** A SystemOne over AI SDK experimental_evaluate. The questions are the same shape; answers are mapped back. */
export function gatewayClient(apiKey: string, evaluate: Evaluate = experimental_evaluate): SystemOne {
  const model = createGateway({ apiKey }).evaluationModel(GATEWAY_JEV_MODEL);
  return {
    async systemOne(req, opts) {
      try {
        const r = await evaluate({
          model,
          state: req.state as never,
          questions: req.questions as never,
          maxRetries: 0,
          abortSignal: opts?.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
        });
        const conf = (r.providerMetadata?.typesafe?.confidence ?? {}) as Record<string, number>;
        const answers = Object.fromEntries(Object.entries(r.answers).map(([id, a]) => [id, { ...(a as object), confidence: conf[id] ?? 0 }]));
        return {
          model: r.response?.modelId ?? GATEWAY_JEV_MODEL,
          usage: { input_tokens: r.usage?.inputTokens ?? 0, output_tokens: r.usage?.outputTokens ?? 0 },
          answers,
        } as never;
      } catch (err) {
        // Surface the HTTP status where the TypeSafe SDK puts it, so 429/5xx back off the same way.
        const status = (err as { statusCode?: number }).statusCode;
        if (status !== undefined) Object.assign(err as object, { status });
        throw err;
      }
    },
  };
}

export interface JevAsk {
  strategy: string;
  state: Record<string, unknown>;
  menu: Menu;
  convictionLabels: readonly string[];
}

export interface JevAnswer {
  ok: true;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Rounded expected conviction level, 0..3. */
  conviction: number;
  convictionRaw: number;
  inputTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface JevFailure {
  ok: false;
  reason: "daily_cap" | "backoff" | "error";
  error?: { code: string; message: string };
  latencyMs: number;
}

export type JevResult = JevAnswer | JevFailure;

/** Anything with the SDK's systemOne shape, so tests can inject a fake. */
export interface SystemOne {
  systemOne(req: SDK.SystemOneRequest, opts?: SDK.RequestOptions): PromiseLike<SDK.SystemOneResult<SDK.Questions>>;
}

export interface JevOpts {
  apiKey: string;
  model: string;
  timeoutMs: number;
  dailyUsdCap: number;
  usdPerMTok: number;
  /** Spend already recorded today (restored from the DB on restart). */
  spentTodayUsd?: number;
  client?: SystemOne;
  now?: () => number;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Jev {
  private client: SystemOne;
  private now: () => number;
  private day: string;
  spentTodayUsd: number;
  private backoffUntil = 0;
  private backoffStep = 0;
  /** First failure of the current outage, for the "Jev down > 5 min" alert. */
  downSince: number | null = null;

  constructor(private opts: JevOpts) {
    this.client =
      opts.client ??
      (isGatewayKey(opts.apiKey) ? gatewayClient(opts.apiKey) : null) ??
      new TypeSafeClient({
        apiKey: opts.apiKey,
        defaultModel: opts.model,
        timeout: opts.timeoutMs,
        retry: { maxRetries: 0 }, // we back off ourselves; a 2 s tick must not wait on SDK retries
        logLevel: "off", // SDK debug logging would print request bodies
      });
    this.now = opts.now ?? Date.now;
    this.day = dayKey(this.now());
    this.spentTodayUsd = opts.spentTodayUsd ?? 0;
  }

  get capTripped(): boolean {
    this.rollDay();
    return this.spentTodayUsd >= this.opts.dailyUsdCap;
  }

  private rollDay() {
    const d = dayKey(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spentTodayUsd = 0;
    }
  }

  async decide(ask: JevAsk): Promise<JevResult> {
    const t0 = this.now();
    if (this.capTripped) return { ok: false, reason: "daily_cap", latencyMs: 0 };
    if (t0 < this.backoffUntil) return { ok: false, reason: "backoff", latencyMs: 0 };

    const labels = Object.keys(ask.menu);
    if (labels.length === 0) return { ok: false, reason: "error", error: { code: "EMPTY_MENU", message: "no valid options" }, latencyMs: 0 };
    const criteria = Object.fromEntries(labels.map((l) => [l, ask.menu[l]!.desc]));
    const conv = ask.convictionLabels as unknown as readonly [string, string, ...string[]];

    try {
      const r = await this.client.systemOne(
        {
          model: this.opts.model,
          state: ask.state as SDK.EntryType,
          questions: {
            action: choice(`${ask.strategy} Pick your next move.`, criteria),
            conviction: score("Signal strength?", conv),
          },
        },
        { timeout: this.opts.timeoutMs, retry: { maxRetries: 0 } },
      );
      const latencyMs = this.now() - t0;
      const a = r.answers.action as SDK.ChoiceResponse;
      const c = r.answers.conviction as SDK.ScoreResponse;
      const inputTokens = r.usage?.input_tokens ?? 0;
      const costUsd = (inputTokens * this.opts.usdPerMTok) / 1e6;
      this.rollDay();
      this.spentTodayUsd += costUsd;
      this.backoffStep = 0;
      this.downSince = null;
      if (!labels.includes(a.choice)) {
        return { ok: false, reason: "error", error: { code: "OFF_MENU", message: `choice not in menu` }, latencyMs };
      }
      return {
        ok: true,
        choice: a.choice,
        probabilities: { ...a.probabilities },
        confidence: a.confidence,
        conviction: Math.max(0, Math.min(conv.length - 1, Math.round(c.score))),
        convictionRaw: c.score,
        inputTokens,
        costUsd,
        latencyMs,
        model: r.model,
      };
    } catch (err) {
      const latencyMs = this.now() - t0;
      const status = (err as { status?: number }).status;
      if (status === 429 || status === 529 || (status !== undefined && status >= 500)) {
        this.backoffStep = Math.min(this.backoffStep + 1, 6);
        this.backoffUntil = this.now() + Math.min(60_000, 1000 * 2 ** this.backoffStep);
      }
      this.downSince ??= t0;
      return { ok: false, reason: "error", error: safeError(err), latencyMs };
    }
  }
}

/** Setup page: one tiny real call proves the key works. Returns an error message, or null when the key is good. */
export async function checkJevKey(apiKey: string, model: string, timeoutMs = 10_000): Promise<string | null> {
  const client: SystemOne = isGatewayKey(apiKey)
    ? gatewayClient(apiKey)
    : new TypeSafeClient({ apiKey, defaultModel: model, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: "off" });
  try {
    await client.systemOne(
      { model, state: { check: "setup" }, questions: { ok: choice("Is this a connection test?", { YES: null, NO: null }) } },
      { timeout: timeoutMs, retry: { maxRetries: 0 } },
    );
    return null;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403)
      return "Jev rejected that key. Copy it again from console.typesafe.ai/keys (or Vercel AI Gateway → API keys for a vck_ key).";
    const e = safeError(err);
    return `Could not reach Jev (${e.code}: ${e.message})`;
  }
}
