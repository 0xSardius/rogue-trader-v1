import { describe, it, expect } from "vitest";
import { JlpDeltaNeutralStrategy } from "../src/strategy/jlp-delta-neutral";
import { Logger } from "../src/lib/logger";
import { DiscordNotifier } from "../src/lib/discord";
import { JupiterPriceClient } from "../src/providers/jupiter/price";
import { JupiterPerpsClient, JlpComposition, PerpMarket } from "../src/providers/jupiter/perps";
import { Ctx, DEFAULT_CONFIG, Position } from "../src/strategy/types";

function mkt(symbol: "SOL" | "BTC" | "ETH", mark: number, borrow: number): PerpMarket {
  return { symbol, custody: symbol, markPriceUsd: mark, borrowAprPct: borrow, utilizationPct: 50, maxPositionSizeUsd: 1e9 };
}

const WEIGHTS = { SOL: 0.45, BTC: 0.1, ETH: 0.08, USDC: 0.25, USDT: 0.12 };
function comp(weights: Record<string, number> = WEIGHTS): JlpComposition {
  const volatileWeight = (weights.SOL ?? 0) + (weights.BTC ?? 0) + (weights.ETH ?? 0);
  return { aumUsd: 1e8, weights, volatileWeight, fetchedAt: 0 };
}

function fakePerps(markets: PerpMarket[], composition: JlpComposition): JupiterPerpsClient {
  return {
    getMarkets: async () => markets,
    getJlpComposition: async () => composition,
    getPositions: async () => [],
  } as unknown as JupiterPerpsClient;
}

function fakePrice(jlpUsd: number | null): JupiterPriceClient {
  return {
    getPrice: async () => (jlpUsd === null ? null : { usdPrice: jlpUsd, decimals: 6 }),
    getPrices: async () => new Map(),
  } as unknown as JupiterPriceClient;
}

function makeCtx(over: { perps: JupiterPerpsClient; price: JupiterPriceClient; positions?: Position[]; params?: Record<string, unknown> }): Ctx {
  const logger = new Logger();
  return {
    env: { SOLANA_RPC_URL: "", JUPITER_API_KEY: "" } as Ctx["env"],
    config: { ...DEFAULT_CONFIG, paper_trading: true, max_position_usd: 25, strategy_params: over.params ?? {} },
    logger,
    solenrich: {} as Ctx["solenrich"],
    llm: {} as Ctx["llm"],
    solana: null,
    discord: new DiscordNotifier(undefined, logger),
    positions: over.positions ?? [],
    paperTrading: true,
  };
}

const healthyMarkets = [mkt("SOL", 200, 10), mkt("BTC", 60_000, 8), mkt("ETH", 3_000, 8)];

function jlpPos(over: Partial<Position> = {}): Position {
  const sizeUsd = 25;
  const jlpEntry = 4;
  return {
    id: "jlp-dn",
    strategy: "jlp-delta-neutral",
    asset: "JLP",
    label: "JLP delta-neutral",
    side: "long",
    entryPrice: jlpEntry,
    currentPrice: jlpEntry,
    sizeUsd,
    pnl: 0,
    pnlPercent: 0,
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    paperTrade: true,
    meta: {
      jlpTokens: sizeUsd / jlpEntry,
      jlpEntry,
      volatileWeight: 0.63,
      expectedJlpApr: 25,
      legs: [
        { asset: "SOL", shortUsd: sizeUsd * 0.45, entryMark: 200, tokens: (sizeUsd * 0.45) / 200 },
        { asset: "BTC", shortUsd: sizeUsd * 0.1, entryMark: 60_000, tokens: (sizeUsd * 0.1) / 60_000 },
        { asset: "ETH", shortUsd: sizeUsd * 0.08, entryMark: 3_000, tokens: (sizeUsd * 0.08) / 3_000 },
      ],
      accruedCarry: 0,
      lastAccrualTs: Date.now() - 3_600_000,
    },
    ...over,
  };
}

describe("JlpDeltaNeutral.gather", () => {
  it("enters when net carry clears the threshold", async () => {
    const strat = new JlpDeltaNeutralStrategy({ perps: fakePerps(healthyMarkets, comp()), price: fakePrice(4) });
    const plans = await strat.gather(makeCtx({ perps: fakePerps(healthyMarkets, comp()), price: fakePrice(4) }));
    expect(plans).toHaveLength(1);
    // 25% JLP APR − (0.45*10 + 0.10*8 + 0.08*8) = 25 − 5.94 = 19.06%
    expect(plans[0].netCarryApr).toBeCloseTo(19.06, 1);
  });

  it("skips when borrow eats the carry", async () => {
    const spiked = [mkt("SOL", 200, 60), mkt("BTC", 60_000, 8), mkt("ETH", 3_000, 8)];
    const strat = new JlpDeltaNeutralStrategy({ perps: fakePerps(spiked, comp()), price: fakePrice(4) });
    expect(await strat.gather(makeCtx({ perps: fakePerps(spiked, comp()), price: fakePrice(4) }))).toEqual([]);
  });

  it("is a singleton — no new entry while positioned", async () => {
    const strat = new JlpDeltaNeutralStrategy({ perps: fakePerps(healthyMarkets, comp()), price: fakePrice(4) });
    const ctx = makeCtx({ perps: fakePerps(healthyMarkets, comp()), price: fakePrice(4), positions: [jlpPos()] });
    expect(await strat.gather(ctx)).toEqual([]);
  });

  it("fails closed when JLP price is unavailable", async () => {
    const strat = new JlpDeltaNeutralStrategy({ perps: fakePerps(healthyMarkets, comp()), price: fakePrice(null) });
    expect(await strat.gather(makeCtx({ perps: fakePerps(healthyMarkets, comp()), price: fakePrice(null) }))).toEqual([]);
  });
});

describe("JlpDeltaNeutral.decide + execute (paper)", () => {
  it("opens a composite position with JLP + hedge legs", async () => {
    const perps = fakePerps(healthyMarkets, comp());
    const price = fakePrice(4);
    const strat = new JlpDeltaNeutralStrategy({ perps, price });
    const ctx = makeCtx({ perps, price });
    const plan = (await strat.gather(ctx))[0];
    const intent = await strat.decide(plan, ctx);
    expect(intent?.action).toBe("OPEN");
    expect(intent?.sizeUsd).toBe(25);

    const res = await strat.execute(intent!, ctx);
    expect(res.ok).toBe(true);
    expect(res.position?.id).toBe("jlp-dn");
    expect(res.position?.meta?.jlpTokens).toBeCloseTo(6.25); // 25 / 4
    expect((res.position?.meta?.legs as unknown[]).length).toBe(3);
  });
});

describe("JlpDeltaNeutral.manage (exits + carry accrual)", () => {
  it("holds and accrues carry when healthy", async () => {
    const perps = fakePerps(healthyMarkets, comp());
    const price = fakePrice(4); // flat vs entry → no drift
    const strat = new JlpDeltaNeutralStrategy({ perps, price });
    const pos = jlpPos();
    const ctx = makeCtx({ perps, price, positions: [pos] });
    const intents = await strat.manage(ctx);
    expect(intents).toEqual([]);
    expect(pos.pnl).toBeGreaterThan(0); // ~1h of positive carry accrued
  });

  it("exits when carry collapses (borrow spike)", async () => {
    const spiked = [mkt("SOL", 200, 60), mkt("BTC", 60_000, 8), mkt("ETH", 3_000, 8)];
    const perps = fakePerps(spiked, comp());
    const price = fakePrice(4);
    const strat = new JlpDeltaNeutralStrategy({ perps, price });
    const ctx = makeCtx({ perps, price, positions: [jlpPos()] });
    const intents = await strat.manage(ctx);
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toMatch(/carry collapsed/);
  });

  it("exits on delta drift when the hedge falls out of balance", async () => {
    const perps = fakePerps(healthyMarkets, comp()); // carry healthy
    const price = fakePrice(5.2); // JLP +30% vs entry, short marks unchanged → big drift
    const strat = new JlpDeltaNeutralStrategy({ perps, price });
    const ctx = makeCtx({ perps, price, positions: [jlpPos()] });
    const intents = await strat.manage(ctx);
    expect(intents).toHaveLength(1);
    expect(intents[0].reason).toMatch(/delta drift/);
  });
});

describe("JlpDeltaNeutral.close (paper)", () => {
  it("realizes the position's marked P&L", async () => {
    const perps = fakePerps(healthyMarkets, comp());
    const price = fakePrice(4);
    const strat = new JlpDeltaNeutralStrategy({ perps, price });
    const pos = jlpPos({ pnl: 1.5 });
    const ctx = makeCtx({ perps, price, positions: [pos] });
    const res = await strat.execute(
      { action: "CLOSE", asset: "JLP", label: pos.label, side: "long", sizeUsd: 0, positionId: pos.id, reason: "carry collapsed", meta: pos.meta },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.realizedPnl).toBeCloseTo(1.5);
  });
});
