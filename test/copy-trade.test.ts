import { describe, it, expect } from "vitest";
import { CopyTradeStrategy } from "../src/strategy/copy-trade";
import { Logger } from "../src/lib/logger";
import { DiscordNotifier } from "../src/lib/discord";
import { JupiterPriceClient, TokenPrice } from "../src/providers/jupiter/price";
import { SolEnrichClient } from "../src/providers/solenrich/client";
import {
  AccumulatedToken,
  DueDiligenceEnrichment,
  DueDiligenceRecommendation,
  SmartMoneyFlowResult,
} from "../src/providers/solenrich/types";
import { Ctx, DEFAULT_CONFIG, Position } from "../src/strategy/types";

function tok(mint: string, buyers: number, vol: number, hold: number, symbol = mint): AccumulatedToken {
  return { mint, symbol, smart_money_buyers: buyers, total_buy_volume_usd: vol, avg_avg_hold_time_days: hold };
}

function flow(tokens: AccumulatedToken[]): SmartMoneyFlowResult {
  return {
    seed_wallets_considered: 10,
    seed_source: "fallback",
    qualifying_smart_wallets: [],
    accumulated_tokens: tokens,
    clusters: [],
    last_updated: "2026-06-19T00:00:00Z",
  };
}

function dd(recommendation: DueDiligenceRecommendation): DueDiligenceEnrichment {
  return { overall_risk_score: 0.1, risk_level: "low", risk_factors: [], recommendation, last_updated: "x" };
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

function fakeSolenrich(opts: {
  flow?: SmartMoneyFlowResult | null;
  dd?: Record<string, DueDiligenceEnrichment>;
  ddDefault?: DueDiligenceEnrichment | null;
}): SolEnrichClient {
  return {
    smartMoneyFlow: async () => opts.flow ?? null,
    dueDiligence: async (mint: string) => opts.dd?.[mint] ?? opts.ddDefault ?? null,
  } as unknown as SolEnrichClient;
}

function makeCtx(over: {
  solenrich: SolEnrichClient;
  positions?: Position[];
  config?: Partial<typeof DEFAULT_CONFIG>;
}): Ctx {
  const logger = new Logger();
  return {
    env: { JUPITER_API_KEY: "" } as Ctx["env"],
    config: { ...DEFAULT_CONFIG, paper_trading: true, ...over.config },
    logger,
    solenrich: over.solenrich,
    llm: {} as Ctx["llm"],
    solana: null,
    discord: new DiscordNotifier(undefined, logger),
    positions: over.positions ?? [],
    paperTrading: true,
  };
}

function heldPosition(mint: string, entry: number, tokenAmount: number, ageHours = 1): Position {
  return {
    id: `ct-${mint}`,
    strategy: "copy-trade",
    asset: mint,
    label: mint,
    side: "long",
    entryPrice: entry,
    currentPrice: entry,
    sizeUsd: 25,
    pnl: 0,
    pnlPercent: 0,
    openedAt: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
    paperTrade: true,
    meta: { mint, symbol: mint, decimals: 6, tokenAmount },
  };
}

describe("CopyTradeStrategy.gather", () => {
  it("keeps only consensus candidates and drops already-held", async () => {
    const f = flow([
      tok("A", 3, 10_000, 2),
      tok("B", 1, 10_000, 2), // too few buyers
      tok("C", 3, 100, 2), // too little volume
      tok("D", 3, 10_000, 0), // hold time too short (scalper)
      tok("E", 3, 10_000, 2), // held
    ]);
    const strat = new CopyTradeStrategy({ price: fakePrice({}) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ flow: f }), positions: [heldPosition("E", 1, 1)] });
    const got = await strat.gather(ctx);
    expect(got.map((t) => t.mint)).toEqual(["A"]);
  });

  it("returns [] when smart-money flow is unavailable", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice({}) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ flow: null }) });
    expect(await strat.gather(ctx)).toEqual([]);
  });
});

describe("CopyTradeStrategy.decide (rug veto = the safety gate)", () => {
  const cand = tok("A", 3, 10_000, 2, "AAA");
  const price = { A: { usdPrice: 2, decimals: 6 } };

  it("opens on SAFE with consensus-scaled confidence", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice(price) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ ddDefault: dd("SAFE"), flow: flow([cand]) }) });
    const intent = await strat.decide(cand, ctx);
    expect(intent?.action).toBe("OPEN");
    expect(intent?.asset).toBe("A");
    expect(intent?.sizeUsd).toBe(DEFAULT_CONFIG.max_position_usd);
    expect(intent?.confidence).toBeCloseTo(0.7); // 0.6 + 0.1*(3-2)
  });

  it("vetoes RISKY", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice(price) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ ddDefault: dd("RISKY") }) });
    expect(await strat.decide(cand, ctx)).toBeNull();
  });

  it("vetoes CAUTION by default, allows it when allow_caution=true", async () => {
    const ctxVeto = makeCtx({ solenrich: fakeSolenrich({ ddDefault: dd("CAUTION") }) });
    expect(await new CopyTradeStrategy({ price: fakePrice(price) }).decide(cand, ctxVeto)).toBeNull();

    const ctxAllow = makeCtx({
      solenrich: fakeSolenrich({ ddDefault: dd("CAUTION") }),
      config: { strategy_params: { allow_caution: true } },
    });
    expect((await new CopyTradeStrategy({ price: fakePrice(price) }).decide(cand, ctxAllow))?.action).toBe("OPEN");
  });

  it("fails closed when due-diligence is unavailable", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice(price) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ ddDefault: null }) });
    expect(await strat.decide(cand, ctx)).toBeNull();
  });

  it("fails closed when price is unreliable", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice({}) }); // no price for A
    const ctx = makeCtx({ solenrich: fakeSolenrich({ ddDefault: dd("SAFE") }) });
    expect(await strat.decide(cand, ctx)).toBeNull();
  });
});

describe("CopyTradeStrategy.manage (exits)", () => {
  it("triggers stop-loss", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice({ A: { usdPrice: 0.7, decimals: 6 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ flow: flow([tok("A", 3, 10_000, 2)]) }), positions: [heldPosition("A", 1, 10)] });
    const intents = await strat.manage(ctx);
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toBe("stop-loss");
  });

  it("triggers take-profit", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice({ A: { usdPrice: 1.6, decimals: 6 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ flow: flow([tok("A", 3, 10_000, 2)]) }), positions: [heldPosition("A", 1, 10)] });
    expect((await strat.manage(ctx))[0].reason).toBe("take-profit");
  });

  it("mirror-exits when smart money stops accumulating", async () => {
    // price flat (no SL/TP), recent (not stale), and A is NOT in the accumulated set.
    const strat = new CopyTradeStrategy({ price: fakePrice({ A: { usdPrice: 1.0, decimals: 6 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ flow: flow([tok("B", 3, 10_000, 2)]) }), positions: [heldPosition("A", 1, 10)] });
    const intents = await strat.manage(ctx);
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toMatch(/mirror-exit/);
  });

  it("holds when in profit-band and still accumulated", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice({ A: { usdPrice: 1.05, decimals: 6 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({ flow: flow([tok("A", 3, 10_000, 2)]) }), positions: [heldPosition("A", 1, 10)] });
    expect(await strat.manage(ctx)).toEqual([]);
  });
});

describe("CopyTradeStrategy.execute (paper)", () => {
  it("opens a paper position sized in tokens", async () => {
    const strat = new CopyTradeStrategy({ price: fakePrice({}) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({}) });
    const res = await strat.execute(
      { action: "OPEN", asset: "A", label: "AAA", side: "long", sizeUsd: 25, reason: "t", meta: { mint: "A", symbol: "AAA", entryPrice: 2, decimals: 6 } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.position?.paperTrade).toBe(true);
    expect(res.position?.meta?.tokenAmount).toBe(12.5); // 25 / 2
  });

  it("realizes paper P&L on close", async () => {
    const pos = heldPosition("A", 1, 10); // entry 1, 10 tokens
    const strat = new CopyTradeStrategy({ price: fakePrice({ A: { usdPrice: 1.5, decimals: 6 } }) });
    const ctx = makeCtx({ solenrich: fakeSolenrich({}), positions: [pos] });
    const res = await strat.execute(
      { action: "CLOSE", asset: "A", label: "A", side: "long", sizeUsd: 0, positionId: pos.id, reason: "take-profit", meta: pos.meta },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.closedId).toBe(pos.id);
    expect(res.realizedPnl).toBeCloseTo(5); // (1.5 - 1) * 10
  });
});
