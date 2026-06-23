import { describe, it, expect } from "vitest";
import { SniperStrategy } from "../src/strategy/sniper";
import { Logger } from "../src/lib/logger";
import { DiscordNotifier } from "../src/lib/discord";
import { JupiterPriceClient, TokenPrice } from "../src/providers/jupiter/price";
import { SolEnrichClient } from "../src/providers/solenrich/client";
import { DueDiligenceRecommendation, TrendingTokenSignal } from "../src/providers/solenrich/types";
import { Ctx, DEFAULT_CONFIG, Position } from "../src/strategy/types";

function trendTok(over: Partial<TrendingTokenSignal> & { mint: string }): TrendingTokenSignal {
  return {
    mint: over.mint,
    symbol: over.symbol ?? over.mint,
    name: over.mint,
    price_usd: over.price_usd ?? 1,
    market_cap: 0,
    liquidity: over.liquidity ?? 50_000,
    risk_score: over.risk_score ?? 0.2,
    risk_level: "low",
    risk_flags: [],
    verified: true,
    holder_count: over.holder_count ?? 500,
    concentration_hhi: null,
    whale_net_flow: over.whale_net_flow,
    composite_signal: over.composite_signal ?? 0.8,
    reasoning: [],
    recommendation: over.recommendation ?? "SAFE",
  };
}

function fakeSolenrich(tokens: TrendingTokenSignal[], dd?: Record<string, DueDiligenceRecommendation>): SolEnrichClient {
  return {
    trendingSignals: async () => ({ tokens, total_scanned: tokens.length, overall_sentiment: "mixed", last_updated: "x" }),
    newTokens: async () => null,
    dueDiligence: async (mint: string) => (dd?.[mint] ? { overall_risk_score: 0, risk_level: "low", risk_factors: [], recommendation: dd[mint], last_updated: "x" } : null),
  } as unknown as SolEnrichClient;
}

function fakePrice(map: Record<string, TokenPrice>): JupiterPriceClient {
  return {
    getPrices: async (mints: string[]) => {
      const m = new Map<string, TokenPrice>();
      for (const x of mints) if (map[x]) m.set(x, map[x]);
      return m;
    },
    getPrice: async (mint: string) => map[mint] ?? null,
  } as unknown as JupiterPriceClient;
}

function makeCtx(over: { solenrich: SolEnrichClient; positions?: Position[]; params?: Record<string, unknown> }): Ctx {
  const logger = new Logger();
  return {
    env: { JUPITER_API_KEY: "" } as Ctx["env"],
    config: { ...DEFAULT_CONFIG, paper_trading: true, max_position_usd: 10, strategy_params: over.params ?? {} },
    logger,
    solenrich: over.solenrich,
    llm: {} as Ctx["llm"],
    solana: null,
    discord: new DiscordNotifier(undefined, logger),
    positions: over.positions ?? [],
    paperTrading: true,
  };
}

function snipePos(mint: string, entry: number, tokens: number, ageHours = 1, over: Partial<Position> = {}): Position {
  return {
    id: `snipe-${mint}`, strategy: "sniper", asset: mint, label: mint, side: "long",
    entryPrice: entry, currentPrice: entry, sizeUsd: 10, pnl: 0, pnlPercent: 0,
    openedAt: new Date(Date.now() - ageHours * 3_600_000).toISOString(), paperTrade: true,
    meta: { mint, symbol: mint, decimals: 9, tokenAmount: tokens, peakPrice: entry }, ...over,
  };
}

describe("SniperStrategy.gather (filters)", () => {
  it("keeps clean candidates, drops risky/illiquid/low-holder/low-signal/held", async () => {
    const tokens = [
      trendTok({ mint: "A" }), // clean
      trendTok({ mint: "B", recommendation: "RISKY" }),
      trendTok({ mint: "C", risk_score: 0.9 }), // > max_risk_score
      trendTok({ mint: "D", liquidity: 1_000 }), // < min liquidity
      trendTok({ mint: "E", holder_count: 10 }), // < min holders
      trendTok({ mint: "F", composite_signal: 0.1 }), // < min composite
      trendTok({ mint: "G" }), // held
    ];
    const strat = new SniperStrategy({ price: fakePrice({}) });
    const ctx = makeCtx({ solenrich: fakeSolenrich(tokens), positions: [snipePos("G", 1, 10)] });
    const got = await strat.gather(ctx);
    expect(got.map((c) => c.mint)).toEqual(["A"]);
  });

  it("can require whale accumulation", async () => {
    const tokens = [
      trendTok({ mint: "A", whale_net_flow: "accumulating" }),
      trendTok({ mint: "B", whale_net_flow: "distributing" }),
    ];
    const strat = new SniperStrategy({ price: fakePrice({}) });
    const ctx = makeCtx({ solenrich: fakeSolenrich(tokens), params: { require_whale_accumulation: true } });
    expect((await strat.gather(ctx)).map((c) => c.mint)).toEqual(["A"]);
  });
});

describe("SniperStrategy.decide", () => {
  const cand = { mint: "A", symbol: "AAA", priceUsd: 2, liquidity: 50_000, riskScore: 0.2, holderCount: 500, recommendation: "SAFE" as const, compositeSignal: 0.8, source: "trending" as const };

  it("opens with composite-scaled confidence", async () => {
    const strat = new SniperStrategy({ price: fakePrice({}) });
    const intent = await strat.decide(cand, makeCtx({ solenrich: fakeSolenrich([]) }));
    expect(intent?.action).toBe("OPEN");
    expect(intent?.confidence).toBeCloseTo(0.8);
    expect(intent?.sizeUsd).toBe(10);
  });

  it("applies an optional second due-diligence veto", async () => {
    const strat = new SniperStrategy({ price: fakePrice({}) });
    const ctx = makeCtx({ solenrich: fakeSolenrich([], { A: "RISKY" }), params: { confirm_due_diligence: true } });
    expect(await strat.decide(cand, ctx)).toBeNull();
  });
});

describe("SniperStrategy.manage (exits)", () => {
  it("take-profit at the configured multiple", async () => {
    const strat = new SniperStrategy({ price: fakePrice({ A: { usdPrice: 2.1, decimals: 9 } }) }); // +110% vs entry 1
    const ctx = makeCtx({ solenrich: fakeSolenrich([]), positions: [snipePos("A", 1, 10)] });
    expect((await strat.manage(ctx))[0].reason).toBe("take-profit");
  });

  it("stop-loss", async () => {
    const strat = new SniperStrategy({ price: fakePrice({ A: { usdPrice: 0.55, decimals: 9 } }) }); // -45%
    const ctx = makeCtx({ solenrich: fakeSolenrich([]), positions: [snipePos("A", 1, 10)] });
    expect((await strat.manage(ctx))[0].reason).toBe("stop-loss");
  });

  it("stale exit after max hold", async () => {
    const strat = new SniperStrategy({ price: fakePrice({ A: { usdPrice: 1.05, decimals: 9 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich([]), positions: [snipePos("A", 1, 10, 48)], params: { max_hold_hours: 24 } });
    expect((await strat.manage(ctx))[0].reason).toBe("stale");
  });

  it("trailing-stop fires after a run-up then pullback", async () => {
    // entry 1, peak already 3 in meta, price now 2.0; trailing 0.3 → exit if <= 3*0.7=2.1
    const strat = new SniperStrategy({ price: fakePrice({ A: { usdPrice: 2.0, decimals: 9 } }) });
    const pos = snipePos("A", 1, 10, 1, { meta: { mint: "A", symbol: "A", decimals: 9, tokenAmount: 10, peakPrice: 3 } });
    const ctx = makeCtx({ solenrich: fakeSolenrich([]), positions: [pos], params: { trailing_stop_pct: 0.3, take_profit_pct: 5, stop_loss_pct: 0.9 } });
    expect((await strat.manage(ctx))[0].reason).toBe("trailing-stop");
  });

  it("holds inside the band", async () => {
    const strat = new SniperStrategy({ price: fakePrice({ A: { usdPrice: 1.1, decimals: 9 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich([]), positions: [snipePos("A", 1, 10)] });
    expect(await strat.manage(ctx)).toEqual([]);
  });
});

describe("SniperStrategy.execute (paper)", () => {
  it("opens then realizes paper P&L", async () => {
    const strat = new SniperStrategy({ price: fakePrice({ A: { usdPrice: 3, decimals: 9 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich([]) });
    const open = await strat.execute(
      { action: "OPEN", asset: "A", label: "AAA", side: "long", sizeUsd: 10, reason: "t", meta: { mint: "A", symbol: "AAA", entryPrice: 1, source: "trending" } },
      ctx,
    );
    expect(open.position?.meta?.tokenAmount).toBe(10); // 10 / 1

    const close = await strat.execute(
      { action: "CLOSE", asset: "A", label: "AAA", side: "long", sizeUsd: 0, positionId: "snipe-A", reason: "take-profit", meta: open.position!.meta },
      { ...ctx, positions: [open.position!] },
    );
    expect(close.realizedPnl).toBeCloseTo(20); // (3 - 1) * 10
  });
});
