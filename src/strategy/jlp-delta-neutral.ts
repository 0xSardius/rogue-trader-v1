import { Ctx, ExecResult, Position, Strategy, TradeIntent } from "./types";
import { JupiterPriceClient } from "../providers/jupiter/price";
import { JupiterUltraClient } from "../providers/jupiter/ultra";
import { JupiterPerpsClient, JLP_MINT, PerpAsset, PerpMarket, JlpComposition } from "../providers/jupiter/perps";
import { JupiterPerpsWriter } from "../providers/jupiter/perps-write";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JLP_MINT_STR = JLP_MINT.toBase58();
const MS_PER_YEAR = 365 * 24 * 3_600_000;
const HEDGE_ASSETS: PerpAsset[] = ["SOL", "BTC", "ETH"];
const POSITION_ID = "jlp-dn"; // singleton composite position

/**
 * Amalthea — JLP delta-neutral yield. Hold JLP (earns the pool's fee yield), short
 * SOL/BTC/ETH on Jupiter Perps to hedge JLP's basket price exposure → keep the fee
 * yield, market-neutral. Jupiter Perps is a BORROW-fee model (both sides pay), so the
 * shorts cost borrow — the trade only works while JLP yield > short borrow + costs.
 *
 * NOTE: JLP yield is an operator estimate (`expected_jlp_apr_pct`, monitor on jup.ag);
 * the short borrow APR is read live on-chain. Live perp writes are devnet-gated
 * (see perps-write.ts) — paper mode runs the full logic against live data.
 */
export interface JlpDeltaNeutralParams {
  expected_jlp_apr_pct: number; // operator estimate of JLP fee yield
  min_net_carry_apr_pct: number; // enter when (jlp apr − weighted short borrow) ≥ this
  exit_net_carry_apr_pct: number; // exit when net carry falls below this
  hedge_ratio: number; // fraction of JLP volatile exposure to hedge (1.0 = full)
  delta_drift_exit_pct: number; // exit when |net delta| / sizeUsd exceeds this
  max_hold_hours: number; // 0 = no time cap
  collateral_ratio: number; // USDC collateral per $ of short notional (0.5 = 2x lev)
  slippage_bps: number;
  devnet_validated: boolean; // gate live perp writes
}

const DEFAULTS: JlpDeltaNeutralParams = {
  expected_jlp_apr_pct: 25,
  min_net_carry_apr_pct: 8,
  exit_net_carry_apr_pct: 2,
  hedge_ratio: 1.0,
  delta_drift_exit_pct: 15,
  max_hold_hours: 0,
  collateral_ratio: 0.5,
  slippage_bps: 100,
  devnet_validated: false,
};

interface HedgeLeg {
  asset: PerpAsset;
  shortUsd: number;
  borrowApr: number;
  markPrice: number;
}

interface HedgePlan {
  jlpPrice: number;
  netCarryApr: number;
  volatileWeight: number;
  legs: HedgeLeg[];
}

export class JlpDeltaNeutralStrategy implements Strategy<HedgePlan> {
  readonly key = "jlp-delta-neutral";

  private price?: JupiterPriceClient;
  private ultra?: JupiterUltraClient;
  private perps?: JupiterPerpsClient;
  private writer?: JupiterPerpsWriter;

  constructor(deps?: {
    price?: JupiterPriceClient;
    ultra?: JupiterUltraClient;
    perps?: JupiterPerpsClient;
    writer?: JupiterPerpsWriter;
  }) {
    this.price = deps?.price;
    this.ultra = deps?.ultra;
    this.perps = deps?.perps;
    this.writer = deps?.writer;
  }

  private init(ctx: Ctx): void {
    const rpc = ctx.env.SOLANA_RPC_URL ?? "";
    const p = this.params(ctx);
    if (!this.price) this.price = new JupiterPriceClient(ctx.logger, ctx.env.JUPITER_API_KEY);
    if (!this.ultra) this.ultra = new JupiterUltraClient(ctx.logger, ctx.env.JUPITER_API_KEY);
    if (!this.perps) this.perps = new JupiterPerpsClient(rpc);
    if (!this.writer) this.writer = new JupiterPerpsWriter(rpc, ctx.solana, p.devnet_validated);
  }

  private params(ctx: Ctx): JlpDeltaNeutralParams {
    return { ...DEFAULTS, ...(ctx.config.strategy_params as Partial<JlpDeltaNeutralParams>) };
  }

  /** Weighted short-borrow APR as a % of total JLP notional, given the hedge legs. */
  private weightedBorrowApr(legs: HedgeLeg[], sizeUsd: number): number {
    if (sizeUsd <= 0) return 0;
    return legs.reduce((s, l) => s + (l.shortUsd * l.borrowApr) / sizeUsd, 0);
  }

  /** Build the hedge plan for a given JLP notional from live markets + composition. */
  private planFromMarkets(
    sizeUsd: number,
    jlpPrice: number,
    markets: PerpMarket[],
    comp: JlpComposition,
    p: JlpDeltaNeutralParams,
  ): HedgePlan {
    const markBy = new Map(markets.map((m) => [m.symbol, m]));
    const legs: HedgeLeg[] = [];
    for (const asset of HEDGE_ASSETS) {
      const m = markBy.get(asset);
      const weight = comp.weights[asset] ?? 0;
      if (!m || m.markPriceUsd === null || weight <= 0) continue;
      legs.push({
        asset,
        shortUsd: sizeUsd * weight * p.hedge_ratio,
        borrowApr: m.borrowAprPct,
        markPrice: m.markPriceUsd,
      });
    }
    const netCarryApr = p.expected_jlp_apr_pct - this.weightedBorrowApr(legs, sizeUsd);
    return { jlpPrice, netCarryApr, volatileWeight: comp.volatileWeight, legs };
  }

  // ─── gather ───────────────────────────────────────────────────────

  async gather(ctx: Ctx): Promise<HedgePlan[]> {
    this.init(ctx);
    const p = this.params(ctx);
    if (ctx.positions.some((x) => x.strategy === this.key)) return []; // singleton: already positioned

    const jlp = await this.price!.getPrice(JLP_MINT_STR);
    if (!jlp) {
      ctx.logger.warn("strategy", "jlp-dn: no JLP price, skipping");
      return [];
    }
    let markets: PerpMarket[];
    let comp: JlpComposition;
    try {
      markets = await this.perps!.getMarkets();
      comp = await this.perps!.getJlpComposition(markets);
    } catch (err) {
      ctx.logger.warn("strategy", "jlp-dn: perps read failed", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }

    const plan = this.planFromMarkets(ctx.config.max_position_usd, jlp.usdPrice, markets, comp, p);
    ctx.logger.info("strategy", `jlp-dn: net carry ${plan.netCarryApr.toFixed(1)}% APR`, {
      jlpApr: p.expected_jlp_apr_pct,
      volatileWeight: comp.volatileWeight,
    });
    return plan.netCarryApr >= p.min_net_carry_apr_pct ? [plan] : [];
  }

  // ─── decide ───────────────────────────────────────────────────────

  async decide(plan: HedgePlan, ctx: Ctx): Promise<TradeIntent | null> {
    const p = this.params(ctx);
    if (plan.legs.length === 0) return null;
    const confidence = Math.min(1, 0.65 + Math.max(0, plan.netCarryApr - p.min_net_carry_apr_pct) / 100);
    return {
      action: "OPEN",
      asset: "JLP",
      label: "JLP delta-neutral",
      side: "long",
      sizeUsd: ctx.config.max_position_usd,
      confidence,
      reason: `net carry ${plan.netCarryApr.toFixed(1)}% APR (JLP ${p.expected_jlp_apr_pct}% − borrow ${(p.expected_jlp_apr_pct - plan.netCarryApr).toFixed(1)}%)`,
      meta: { plan, expectedJlpApr: p.expected_jlp_apr_pct },
    };
  }

  // ─── execute ──────────────────────────────────────────────────────

  async execute(intent: TradeIntent, ctx: Ctx): Promise<ExecResult> {
    this.init(ctx);
    const p = this.params(ctx);
    return intent.action === "OPEN" ? this.open(intent, ctx, p) : this.close(intent, ctx);
  }

  private async open(intent: TradeIntent, ctx: Ctx, p: JlpDeltaNeutralParams): Promise<ExecResult> {
    const plan = intent.meta!.plan as HedgePlan;
    const sizeUsd = intent.sizeUsd;
    const jlpTokens = sizeUsd / plan.jlpPrice;

    if (!ctx.paperTrading) {
      if (!p.devnet_validated) {
        return { ok: false, error: "live JLP delta-neutral requires devnet-validated perp writes (set devnet_validated)" };
      }
      if (!ctx.solana) return { ok: false, error: "live execution requires a funded wallet (WALLET_PRIVATE_KEY)" };
      try {
        // Place the perp hedge FIRST — if the shorts can't open, we never buy JLP (no half-open).
        for (const leg of plan.legs) {
          const r = await this.writer!.openShort({
            asset: leg.asset,
            sizeUsd: leg.shortUsd,
            collateralUsd: leg.shortUsd * p.collateral_ratio,
            slippageBps: p.slippage_bps,
          });
          if (!r.ok) return { ok: false, error: `short ${leg.asset} failed: ${r.error}` };
        }
        // Then buy the JLP leg.
        const usdcNative = Math.round(sizeUsd * 1e6).toString();
        const buy = await this.ultra!.swap(USDC_MINT, JLP_MINT_STR, usdcNative, ctx.solana.publicKey, (tx) => ctx.solana!.signOnly(tx));
        if (!buy.ok) return { ok: false, error: `JLP buy failed: ${buy.error}` };
        // (Live position assembly happens once the perp write path is devnet-validated.)
        return { ok: false, error: "live JLP-DN assembly pending devnet validation of perp writes" };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const now = new Date().toISOString();
    const position: Position = {
      id: POSITION_ID,
      strategy: this.key,
      asset: "JLP",
      label: "JLP delta-neutral",
      side: "long",
      entryPrice: plan.jlpPrice,
      currentPrice: plan.jlpPrice,
      sizeUsd,
      pnl: 0,
      pnlPercent: 0,
      openedAt: now,
      paperTrade: true,
      meta: {
        jlpTokens,
        jlpEntry: plan.jlpPrice,
        volatileWeight: plan.volatileWeight,
        expectedJlpApr: p.expected_jlp_apr_pct,
        legs: plan.legs.map((l) => ({ asset: l.asset, shortUsd: l.shortUsd, entryMark: l.markPrice, tokens: l.shortUsd / l.markPrice })),
        accruedCarry: 0,
        lastAccrualTs: Date.now(),
      },
    };
    return { ok: true, price: plan.jlpPrice, position };
  }

  private async close(intent: TradeIntent, ctx: Ctx): Promise<ExecResult> {
    const pos = ctx.positions.find((x) => x.id === intent.positionId);
    if (!pos) return { ok: false, error: "position not found" };
    if (!pos.paperTrade) return { ok: false, error: "live JLP-DN close pending devnet validation" };
    return { ok: true, closedId: pos.id, realizedPnl: pos.pnl, price: pos.currentPrice };
  }

  // ─── manage ───────────────────────────────────────────────────────

  async manage(ctx: Ctx): Promise<TradeIntent[]> {
    this.init(ctx);
    const p = this.params(ctx);
    const pos = ctx.positions.find((x) => x.strategy === this.key);
    if (!pos) return [];

    const jlp = await this.price!.getPrice(JLP_MINT_STR);
    let markets: PerpMarket[] = [];
    try {
      markets = await this.perps!.getMarkets();
    } catch {
      /* keep last marks if read fails */
    }
    const markBy = new Map(markets.map((m) => [m.symbol, m]));

    const jlpTokens = pos.meta!.jlpTokens as number;
    const jlpEntry = pos.meta!.jlpEntry as number;
    const legs = pos.meta!.legs as Array<{ asset: PerpAsset; shortUsd: number; entryMark: number; tokens: number }>;
    const jlpPrice = jlp?.usdPrice ?? pos.currentPrice;

    // Mark-to-market both legs (in a good hedge these roughly cancel).
    const jlpMtm = (jlpPrice - jlpEntry) * jlpTokens;
    let shortsMtm = 0;
    let shortNotionalNow = 0;
    let borrowCostApr = 0;
    for (const leg of legs) {
      const m = markBy.get(leg.asset);
      const mark = m?.markPriceUsd ?? leg.entryMark;
      shortsMtm += (leg.entryMark - mark) * leg.tokens; // short gains when price falls
      shortNotionalNow += mark * leg.tokens;
      if (m) borrowCostApr += (leg.shortUsd * m.borrowAprPct) / pos.sizeUsd;
    }

    // Accrue carry since last cycle at the CURRENT net rate.
    const now = Date.now();
    const last = (pos.meta!.lastAccrualTs as number) ?? now;
    const expectedJlpApr = pos.meta!.expectedJlpApr as number;
    const netCarryApr = expectedJlpApr - borrowCostApr;
    const dtYears = Math.max(0, (now - last) / MS_PER_YEAR);
    const accrued = ((pos.meta!.accruedCarry as number) ?? 0) + pos.sizeUsd * (netCarryApr / 100) * dtYears;
    pos.meta!.accruedCarry = accrued;
    pos.meta!.lastAccrualTs = now;

    pos.currentPrice = jlpPrice;
    pos.pnl = jlpMtm + shortsMtm + accrued;
    pos.pnlPercent = pos.sizeUsd > 0 ? (pos.pnl / pos.sizeUsd) * 100 : 0;

    // Net delta = unhedged volatile exposure of the JLP leg vs the short notional.
    const jlpVolatileValue = jlpTokens * jlpPrice * (pos.meta!.volatileWeight as number);
    const netDelta = jlpVolatileValue - shortNotionalNow;
    const driftPct = pos.sizeUsd > 0 ? (Math.abs(netDelta) / pos.sizeUsd) * 100 : 0;

    const reason = this.exitReason(netCarryApr, driftPct, pos, p);
    if (!reason) return [];
    return [{ action: "CLOSE", asset: "JLP", label: pos.label, side: pos.side, sizeUsd: 0, positionId: pos.id, reason, meta: pos.meta }];
  }

  private exitReason(netCarryApr: number, driftPct: number, pos: Position, p: JlpDeltaNeutralParams): string | null {
    if (netCarryApr < p.exit_net_carry_apr_pct) return `carry collapsed (${netCarryApr.toFixed(1)}% APR)`;
    if (driftPct > p.delta_drift_exit_pct) return `delta drift ${driftPct.toFixed(1)}%`;
    if (p.max_hold_hours > 0) {
      const ageHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
      if (ageHours >= p.max_hold_hours) return "max hold";
    }
    return null;
  }
}
