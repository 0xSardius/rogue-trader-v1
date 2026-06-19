import { Ctx, ExecResult, Position, Strategy, TradeIntent } from "./types";
import { JupiterPriceClient } from "../providers/jupiter/price";
import { JupiterUltraClient } from "../providers/jupiter/ultra";
import { AccumulatedToken, SmartMoneyFlowResult } from "../providers/solenrich/types";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // 6 decimals

/** Tunable copy-trade parameters (read from config.strategy_params, merged with defaults). */
export interface CopyTradeParams {
  /** Optional seed wallet list (max 30); omit to use SolEnrich's curated default. */
  seed_wallets?: string[];
  lookback_days: number;
  min_win_rate: number;
  /** Consensus gate: only buy tokens this many smart wallets are accumulating. */
  min_smart_money_buyers: number;
  /** Favor accumulators over scalpers — we are always behind on-chain, so patience wins. */
  min_hold_time_days: number;
  min_buy_volume_usd: number;
  /** Accept CAUTION due-diligence verdicts (default false = SAFE only). RISKY is always vetoed. */
  allow_caution: boolean;
  take_profit_pct: number; // 0.5 = +50%
  stop_loss_pct: number; // 0.25 = -25%
  max_hold_hours: number;
  /** Mirror-exit: sell when the token drops out of the smart-money accumulation set. */
  exit_on_consensus_loss: boolean;
  usdc_mint: string;
  slippage_bps: number;
}

const DEFAULTS: CopyTradeParams = {
  lookback_days: 14,
  min_win_rate: 0.55,
  min_smart_money_buyers: 2,
  min_hold_time_days: 1,
  min_buy_volume_usd: 5_000,
  allow_caution: false,
  take_profit_pct: 0.5,
  stop_loss_pct: 0.25,
  max_hold_hours: 72,
  exit_on_consensus_loss: true,
  usdc_mint: USDC_MINT,
  slippage_bps: 100,
};

const FLOW_TTL_MS = 60_000;

/**
 * Metis — copy-trade smart money. Thesis: the WALLET is the alpha, the LLM/due-diligence
 * is a rug VETO, not a predictor. Signal source is SolEnrich `smart-money-flow`:
 * tokens that N+ proven wallets are accumulating (consensus), filtered to accumulators
 * (not scalpers), rug-vetoed, then bought single-leg via Jupiter Ultra. Exits mirror the
 * smart money (token leaves the accumulation set) plus SL/TP/stale backstops.
 */
export class CopyTradeStrategy implements Strategy<AccumulatedToken> {
  readonly key = "copy-trade";

  private price?: JupiterPriceClient;
  private ultra?: JupiterUltraClient;
  private flowCache?: { ts: number; data: SmartMoneyFlowResult | null };

  constructor(deps?: { price?: JupiterPriceClient; ultra?: JupiterUltraClient }) {
    this.price = deps?.price;
    this.ultra = deps?.ultra;
  }

  private init(ctx: Ctx): void {
    if (!this.price) this.price = new JupiterPriceClient(ctx.logger, ctx.env.JUPITER_API_KEY);
    if (!this.ultra) this.ultra = new JupiterUltraClient(ctx.logger, ctx.env.JUPITER_API_KEY);
  }

  private params(ctx: Ctx): CopyTradeParams {
    return { ...DEFAULTS, ...(ctx.config.strategy_params as Partial<CopyTradeParams>) };
  }

  /** Cached smart-money snapshot (manage + gather share it within a cycle). */
  private async getFlow(ctx: Ctx, p: CopyTradeParams): Promise<SmartMoneyFlowResult | null> {
    const now = Date.now();
    if (this.flowCache && now - this.flowCache.ts < FLOW_TTL_MS) return this.flowCache.data;
    const data = await ctx.solenrich.smartMoneyFlow({
      wallets: p.seed_wallets,
      lookback_days: p.lookback_days,
      min_win_rate: p.min_win_rate,
      top_n_tokens: 20,
      include_graph: false,
    });
    this.flowCache = { ts: now, data };
    return data;
  }

  // ─── gather ───────────────────────────────────────────────────────

  async gather(ctx: Ctx): Promise<AccumulatedToken[]> {
    this.init(ctx);
    const p = this.params(ctx);
    const flow = await this.getFlow(ctx, p);
    if (!flow) {
      ctx.logger.warn("strategy", "copy-trade: no smart-money flow this cycle");
      return [];
    }

    const held = new Set(ctx.positions.filter((x) => x.strategy === this.key).map((x) => x.meta?.mint as string));
    const candidates = flow.accumulated_tokens.filter(
      (t) =>
        t.smart_money_buyers >= p.min_smart_money_buyers &&
        t.total_buy_volume_usd >= p.min_buy_volume_usd &&
        (t.avg_avg_hold_time_days ?? 0) >= p.min_hold_time_days &&
        !held.has(t.mint),
    );
    ctx.logger.info("strategy", `copy-trade: ${candidates.length} consensus candidates`, {
      considered: flow.accumulated_tokens.length,
      seedSource: flow.seed_source,
    });
    return candidates;
  }

  // ─── decide ───────────────────────────────────────────────────────

  async decide(candidate: AccumulatedToken, ctx: Ctx): Promise<TradeIntent | null> {
    this.init(ctx);
    const p = this.params(ctx);

    // Rug veto — fail closed if due-diligence is unavailable (never buy blind).
    const dd = await ctx.solenrich.dueDiligence(candidate.mint);
    if (!dd) {
      ctx.logger.warn("strategy", "copy-trade: due-diligence unavailable, skipping", { mint: candidate.mint });
      return null;
    }
    if (dd.recommendation === "RISKY" || (dd.recommendation === "CAUTION" && !p.allow_caution)) {
      ctx.logger.info("strategy", `copy-trade: rug veto (${dd.recommendation})`, {
        mint: candidate.mint,
        factors: dd.risk_factors?.slice(0, 3),
      });
      return null;
    }

    // Entry price — fail closed on unreliable pricing.
    const price = await this.price!.getPrice(candidate.mint);
    if (!price) {
      ctx.logger.warn("strategy", "copy-trade: no reliable price, skipping", { mint: candidate.mint });
      return null;
    }

    const confidence = Math.max(0, Math.min(1, 0.6 + 0.1 * (candidate.smart_money_buyers - p.min_smart_money_buyers)));

    return {
      action: "OPEN",
      asset: candidate.mint,
      label: candidate.symbol || candidate.mint.slice(0, 6),
      side: "long",
      sizeUsd: ctx.config.max_position_usd,
      confidence,
      reason: `${candidate.smart_money_buyers} smart wallets accumulating; dd ${dd.recommendation}`,
      meta: {
        mint: candidate.mint,
        symbol: candidate.symbol,
        entryPrice: price.usdPrice,
        decimals: price.decimals,
        smartMoneyBuyers: candidate.smart_money_buyers,
      },
    };
  }

  // ─── manage ───────────────────────────────────────────────────────

  async manage(ctx: Ctx): Promise<TradeIntent[]> {
    this.init(ctx);
    const p = this.params(ctx);
    const mine = ctx.positions.filter((x) => x.strategy === this.key);
    if (mine.length === 0) return [];

    // Re-price open positions.
    const prices = await this.price!.getPrices(mine.map((x) => x.meta!.mint as string));
    for (const pos of mine) {
      const pr = prices.get(pos.meta!.mint as string);
      if (pr) {
        const tokens = pos.meta!.tokenAmount as number;
        pos.currentPrice = pr.usdPrice;
        pos.pnl = (pos.currentPrice - pos.entryPrice) * tokens;
        pos.pnlPercent = pos.entryPrice > 0 ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      }
    }

    // Mirror-exit set: which held mints are still being accumulated.
    let accumulated: Set<string> | null = null;
    if (p.exit_on_consensus_loss) {
      const flow = await this.getFlow(ctx, p);
      if (flow) {
        accumulated = new Set(
          flow.accumulated_tokens.filter((t) => t.smart_money_buyers >= p.min_smart_money_buyers).map((t) => t.mint),
        );
      }
    }

    const intents: TradeIntent[] = [];
    for (const pos of mine) {
      const reason = this.exitReason(pos, p, accumulated);
      if (reason) {
        intents.push({
          action: "CLOSE",
          asset: pos.asset,
          label: pos.label,
          side: pos.side,
          sizeUsd: 0,
          positionId: pos.id,
          reason,
          meta: pos.meta,
        });
      }
    }
    return intents;
  }

  private exitReason(pos: Position, p: CopyTradeParams, accumulated: Set<string> | null): string | null {
    if (pos.pnlPercent <= -p.stop_loss_pct * 100) return "stop-loss";
    if (pos.pnlPercent >= p.take_profit_pct * 100) return "take-profit";
    const ageHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
    if (ageHours >= p.max_hold_hours) return "stale";
    if (accumulated && !accumulated.has(pos.meta!.mint as string)) return "mirror-exit (smart money exited)";
    return null;
  }

  // ─── execute ──────────────────────────────────────────────────────

  async execute(intent: TradeIntent, ctx: Ctx): Promise<ExecResult> {
    this.init(ctx);
    const p = this.params(ctx);
    return intent.action === "OPEN" ? this.open(intent, ctx, p) : this.close(intent, ctx, p);
  }

  private async open(intent: TradeIntent, ctx: Ctx, p: CopyTradeParams): Promise<ExecResult> {
    const mint = intent.meta!.mint as string;
    const entryPrice = intent.meta!.entryPrice as number;
    const decimals = intent.meta!.decimals as number;

    if (ctx.paperTrading) {
      const tokens = intent.sizeUsd / entryPrice;
      return { ok: true, price: entryPrice, position: this.makePosition(intent, mint, entryPrice, intent.sizeUsd, tokens, decimals, true) };
    }

    if (!ctx.solana) return { ok: false, error: "live trading requires a funded wallet (WALLET_PRIVATE_KEY)" };
    const usdcNative = Math.round(intent.sizeUsd * 1e6).toString();
    const res = await this.ultra!.swap(p.usdc_mint, mint, usdcNative, ctx.solana.publicKey, (tx) => ctx.solana!.signOnly(tx));
    if (!res.ok) return { ok: false, error: res.error };

    const tokens = Number(res.outAmount ?? 0) / 10 ** decimals;
    const fillPrice = tokens > 0 ? intent.sizeUsd / tokens : entryPrice;
    return {
      ok: true,
      price: fillPrice,
      txSignature: res.signature,
      position: this.makePosition(intent, mint, fillPrice, intent.sizeUsd, tokens, decimals, false, res.signature),
    };
  }

  private async close(intent: TradeIntent, ctx: Ctx, p: CopyTradeParams): Promise<ExecResult> {
    const pos = ctx.positions.find((x) => x.id === intent.positionId);
    if (!pos) return { ok: false, error: "position not found" };
    const mint = pos.meta!.mint as string;
    const tokens = pos.meta!.tokenAmount as number;
    const decimals = pos.meta!.decimals as number;

    const pr = await this.price!.getPrice(mint);
    const currentPrice = pr?.usdPrice ?? pos.currentPrice;

    if (pos.paperTrade) {
      const realizedPnl = (currentPrice - pos.entryPrice) * tokens;
      return { ok: true, closedId: pos.id, realizedPnl, price: currentPrice };
    }

    if (!ctx.solana) return { ok: false, error: "live close requires a funded wallet" };
    const tokensNative = Math.round(tokens * 10 ** decimals).toString();
    const res = await this.ultra!.swap(mint, p.usdc_mint, tokensNative, ctx.solana.publicKey, (tx) => ctx.solana!.signOnly(tx));
    if (!res.ok) return { ok: false, error: res.error };

    const usdcOut = Number(res.outAmount ?? 0) / 1e6;
    return { ok: true, closedId: pos.id, realizedPnl: usdcOut - pos.sizeUsd, price: currentPrice, txSignature: res.signature };
  }

  private makePosition(
    intent: TradeIntent,
    mint: string,
    entryPrice: number,
    sizeUsd: number,
    tokens: number,
    decimals: number,
    paper: boolean,
    txSignature?: string,
  ): Position {
    return {
      id: `ct-${mint}`,
      strategy: this.key,
      asset: mint,
      label: intent.label,
      side: "long",
      entryPrice,
      currentPrice: entryPrice,
      sizeUsd,
      pnl: 0,
      pnlPercent: 0,
      openedAt: new Date().toISOString(),
      paperTrade: paper,
      meta: { mint, symbol: intent.meta!.symbol, decimals, tokenAmount: tokens, txSignature },
    };
  }
}
