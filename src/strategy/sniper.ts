import { Ctx, ExecResult, Position, Strategy, TradeIntent } from "./types";
import { JupiterPriceClient } from "../providers/jupiter/price";
import { JupiterUltraClient } from "../providers/jupiter/ultra";
import { DueDiligenceRecommendation } from "../providers/solenrich/types";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Unified candidate from either discovery source. */
interface SnipeCandidate {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidity: number;
  riskScore: number;
  holderCount: number;
  recommendation: DueDiligenceRecommendation;
  compositeSignal: number; // 0..1 (new-tokens has none → 1 - riskScore)
  whaleNetFlow?: "accumulating" | "distributing" | "neutral";
  source: "trending" | "new";
}

export interface SniperParams {
  source: "trending" | "new" | "both";
  min_liquidity_usd: number;
  max_risk_score: number; // 0..1 (lower = stricter)
  min_holder_count: number;
  min_composite_signal: number; // trending only
  require_whale_accumulation: boolean; // trending only
  allow_caution: boolean; // accept CAUTION (default SAFE-only); RISKY always vetoed
  confirm_due_diligence: boolean; // extra per-candidate dd veto (trending already scores)
  take_profit_pct: number; // 1.0 = +100%
  stop_loss_pct: number; // 0.4 = -40%
  trailing_stop_pct: number; // 0 = off; e.g. 0.3 trails 30% off peak
  max_hold_hours: number;
  slippage_bps: number;
  usdc_mint: string;
}

const DEFAULTS: SniperParams = {
  source: "trending",
  min_liquidity_usd: 20_000,
  max_risk_score: 0.5,
  min_holder_count: 100,
  min_composite_signal: 0.5,
  require_whale_accumulation: false,
  allow_caution: false,
  confirm_due_diligence: false,
  take_profit_pct: 1.0,
  stop_loss_pct: 0.4,
  trailing_stop_pct: 0,
  max_hold_hours: 24,
  slippage_bps: 300,
  usdc_mint: USDC_MINT,
};

/**
 * Io — memecoin sniper. The convex/lottery leg of the swarm: small fixed tickets on
 * fresh/trending tokens, hard rug-filtered, aggressive TP + fast time-stop. Edge is
 * speed + filtering, not prediction. SolEnrich trending-signals/new-tokens already
 * risk-score + rank, so they double as discovery AND the first veto; due-diligence is
 * an optional second veto. Sniper agents typically run with a LOW config.min_confidence
 * (~0.4) since fresh tokens are inherently lower-conviction than smart-money consensus.
 */
export class SniperStrategy implements Strategy<SnipeCandidate> {
  readonly key = "sniper";

  private price?: JupiterPriceClient;
  private ultra?: JupiterUltraClient;

  constructor(deps?: { price?: JupiterPriceClient; ultra?: JupiterUltraClient }) {
    this.price = deps?.price;
    this.ultra = deps?.ultra;
  }

  private init(ctx: Ctx): void {
    if (!this.price) this.price = new JupiterPriceClient(ctx.logger, ctx.env.JUPITER_API_KEY);
    if (!this.ultra) this.ultra = new JupiterUltraClient(ctx.logger, ctx.env.JUPITER_API_KEY);
  }

  private params(ctx: Ctx): SniperParams {
    return { ...DEFAULTS, ...(ctx.config.strategy_params as Partial<SniperParams>) };
  }

  private vetoed(rec: DueDiligenceRecommendation, p: SniperParams): boolean {
    return rec === "RISKY" || (rec === "CAUTION" && !p.allow_caution);
  }

  // ─── gather ───────────────────────────────────────────────────────

  async gather(ctx: Ctx): Promise<SnipeCandidate[]> {
    this.init(ctx);
    const p = this.params(ctx);
    const held = new Set(ctx.positions.filter((x) => x.strategy === this.key).map((x) => x.meta?.mint as string));
    const out: SnipeCandidate[] = [];
    const seen = new Set<string>();

    if (p.source === "trending" || p.source === "both") {
      const res = await ctx.solenrich.trendingSignals({
        min_liquidity_usd: p.min_liquidity_usd,
        max_risk_score: p.max_risk_score,
        limit: 20,
        include_whale_watch: true,
      });
      for (const t of res?.tokens ?? []) {
        out.push({
          mint: t.mint,
          symbol: t.symbol,
          priceUsd: t.price_usd,
          liquidity: t.liquidity,
          riskScore: t.risk_score,
          holderCount: t.holder_count,
          recommendation: t.recommendation,
          compositeSignal: t.composite_signal,
          whaleNetFlow: t.whale_net_flow,
          source: "trending",
        });
      }
    }
    if (p.source === "new" || p.source === "both") {
      const res = await ctx.solenrich.newTokens({
        min_liquidity_usd: p.min_liquidity_usd,
        max_risk_score: p.max_risk_score,
        limit: 20,
      });
      for (const t of res?.tokens ?? []) {
        out.push({
          mint: t.mint,
          symbol: t.symbol,
          priceUsd: t.price_usd,
          liquidity: t.liquidity,
          riskScore: t.risk_score,
          holderCount: t.holder_count,
          recommendation: t.recommendation,
          compositeSignal: Math.max(0, 1 - t.risk_score),
          source: "new",
        });
      }
    }

    const filtered = out.filter((c) => {
      if (seen.has(c.mint) || held.has(c.mint)) return false;
      seen.add(c.mint);
      if (this.vetoed(c.recommendation, p)) return false;
      if (c.riskScore > p.max_risk_score) return false;
      if (c.liquidity < p.min_liquidity_usd) return false;
      if (c.holderCount < p.min_holder_count) return false;
      if (c.priceUsd <= 0) return false;
      if (c.source === "trending") {
        if (c.compositeSignal < p.min_composite_signal) return false;
        if (p.require_whale_accumulation && c.whaleNetFlow !== "accumulating") return false;
      }
      return true;
    });

    ctx.logger.info("strategy", `sniper: ${filtered.length} candidates (${out.length} scanned)`);
    return filtered;
  }

  // ─── decide ───────────────────────────────────────────────────────

  async decide(c: SnipeCandidate, ctx: Ctx): Promise<TradeIntent | null> {
    this.init(ctx);
    const p = this.params(ctx);

    if (p.confirm_due_diligence) {
      const dd = await ctx.solenrich.dueDiligence(c.mint);
      if (!dd || this.vetoed(dd.recommendation, p)) {
        ctx.logger.info("strategy", "sniper: due-diligence veto", { mint: c.mint, rec: dd?.recommendation });
        return null;
      }
    }

    const confidence = Math.min(1, Math.max(c.compositeSignal, 1 - c.riskScore));
    return {
      action: "OPEN",
      asset: c.mint,
      label: c.symbol || c.mint.slice(0, 6),
      side: "long",
      sizeUsd: ctx.config.max_position_usd,
      confidence,
      reason: `${c.source} snipe; risk ${c.riskScore.toFixed(2)}, ${c.holderCount} holders, dd ${c.recommendation}`,
      meta: { mint: c.mint, symbol: c.symbol, entryPrice: c.priceUsd, source: c.source },
    };
  }

  // ─── manage ───────────────────────────────────────────────────────

  async manage(ctx: Ctx): Promise<TradeIntent[]> {
    this.init(ctx);
    const p = this.params(ctx);
    const mine = ctx.positions.filter((x) => x.strategy === this.key);
    if (mine.length === 0) return [];

    const prices = await this.price!.getPrices(mine.map((x) => x.meta!.mint as string));
    const intents: TradeIntent[] = [];
    for (const pos of mine) {
      const pr = prices.get(pos.meta!.mint as string);
      if (pr) {
        const tokens = pos.meta!.tokenAmount as number;
        pos.currentPrice = pr.usdPrice;
        pos.pnl = (pos.currentPrice - pos.entryPrice) * tokens;
        pos.pnlPercent = pos.entryPrice > 0 ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
        // Track peak for trailing stop.
        const peak = Math.max((pos.meta!.peakPrice as number) ?? pos.entryPrice, pos.currentPrice);
        pos.meta!.peakPrice = peak;
      }
      const reason = this.exitReason(pos, p);
      if (reason) {
        intents.push({ action: "CLOSE", asset: pos.asset, label: pos.label, side: pos.side, sizeUsd: 0, positionId: pos.id, reason, meta: pos.meta });
      }
    }
    return intents;
  }

  private exitReason(pos: Position, p: SniperParams): string | null {
    if (pos.pnlPercent <= -p.stop_loss_pct * 100) return "stop-loss";
    if (pos.pnlPercent >= p.take_profit_pct * 100) return "take-profit";
    if (p.trailing_stop_pct > 0) {
      const peak = (pos.meta!.peakPrice as number) ?? pos.entryPrice;
      if (peak > pos.entryPrice && pos.currentPrice <= peak * (1 - p.trailing_stop_pct)) return "trailing-stop";
    }
    const ageHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
    if (ageHours >= p.max_hold_hours) return "stale";
    return null;
  }

  // ─── execute ──────────────────────────────────────────────────────

  async execute(intent: TradeIntent, ctx: Ctx): Promise<ExecResult> {
    this.init(ctx);
    const p = this.params(ctx);
    return intent.action === "OPEN" ? this.open(intent, ctx, p) : this.close(intent, ctx, p);
  }

  private async open(intent: TradeIntent, ctx: Ctx, p: SniperParams): Promise<ExecResult> {
    const mint = intent.meta!.mint as string;
    const entryPrice = intent.meta!.entryPrice as number;

    if (ctx.paperTrading) {
      const tokens = intent.sizeUsd / entryPrice;
      return { ok: true, price: entryPrice, position: this.makePosition(intent, mint, entryPrice, intent.sizeUsd, tokens, 9, true) };
    }

    if (!ctx.solana) return { ok: false, error: "live trading requires a funded wallet (WALLET_PRIVATE_KEY)" };
    const usdcNative = Math.round(intent.sizeUsd * 1e6).toString();
    const res = await this.ultra!.swap(p.usdc_mint, mint, usdcNative, ctx.solana.publicKey, (tx) => ctx.solana!.signOnly(tx));
    if (!res.ok) return { ok: false, error: res.error };

    const pr = await this.price!.getPrice(mint);
    const decimals = pr?.decimals ?? 9;
    const tokens = Number(res.outAmount ?? 0) / 10 ** decimals;
    const fillPrice = tokens > 0 ? intent.sizeUsd / tokens : entryPrice;
    return {
      ok: true,
      price: fillPrice,
      txSignature: res.signature,
      position: this.makePosition(intent, mint, fillPrice, intent.sizeUsd, tokens, decimals, false, res.signature),
    };
  }

  private async close(intent: TradeIntent, ctx: Ctx, p: SniperParams): Promise<ExecResult> {
    const pos = ctx.positions.find((x) => x.id === intent.positionId);
    if (!pos) return { ok: false, error: "position not found" };
    const mint = pos.meta!.mint as string;
    const tokens = pos.meta!.tokenAmount as number;
    const decimals = pos.meta!.decimals as number;
    const pr = await this.price!.getPrice(mint);
    const currentPrice = pr?.usdPrice ?? pos.currentPrice;

    if (pos.paperTrade) {
      return { ok: true, closedId: pos.id, realizedPnl: (currentPrice - pos.entryPrice) * tokens, price: currentPrice };
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
      id: `snipe-${mint}`,
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
      meta: { mint, symbol: intent.meta!.symbol, decimals, tokenAmount: tokens, peakPrice: entryPrice, source: intent.meta!.source, txSignature },
    };
  }
}
