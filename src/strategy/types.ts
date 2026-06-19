import { Env } from "../env";
import { Logger } from "../lib/logger";
import { DiscordNotifier } from "../lib/discord";
import { SolEnrichClient } from "../providers/solenrich/client";
import { LLMProvider } from "../providers/llm/provider";
import { SolanaClient } from "../providers/solana";

// ─── Config (strategy-agnostic) ─────────────────────────────────────

export interface AgentConfig {
  /** Max concurrent open positions across the active strategy. */
  max_positions: number;
  /** Hard cap on a single position's notional in USD. */
  max_position_usd: number;
  /** Daily loss limit as % of current exposure; trips the daily kill. */
  daily_loss_limit_pct: number;
  /** Cooldown (minutes) after a losing close before opening again. */
  cooldown_minutes: number;
  /** Cycle interval in ms (DO alarm). */
  poll_interval_ms: number;
  /** Paper trading: simulate fills, never sign/submit on-chain. */
  paper_trading: boolean;
  /** Minimum confidence (0..1) for OPEN intents that carry one. */
  min_confidence: number;
  /** LLM model id (provider/model) for any strategy that uses the LLM. */
  llm_model: string;
  /** Per-strategy config bag (e.g. watchlist, thresholds). */
  strategy_params: Record<string, unknown>;
}

export const DEFAULT_CONFIG: AgentConfig = {
  max_positions: 3,
  max_position_usd: 25,
  daily_loss_limit_pct: 5,
  cooldown_minutes: 30,
  poll_interval_ms: 300_000, // 5 min
  paper_trading: true,
  min_confidence: 0.6,
  llm_model: "anthropic/claude-sonnet-4",
  strategy_params: {},
};

/** Returns a list of human-readable validation errors (empty = valid). */
export function validateConfig(c: Partial<AgentConfig>): string[] {
  const errors: string[] = [];
  const num = (k: keyof AgentConfig, min: number, max: number) => {
    const v = c[k];
    if (v !== undefined && (typeof v !== "number" || Number.isNaN(v) || v < min || v > max)) {
      errors.push(`${k} must be a number in [${min}, ${max}]`);
    }
  };
  num("max_positions", 1, 50);
  num("max_position_usd", 1, 1_000_000);
  num("daily_loss_limit_pct", 0.1, 100);
  num("cooldown_minutes", 0, 1440);
  num("poll_interval_ms", 10_000, 86_400_000);
  num("min_confidence", 0, 1);
  if (c.paper_trading !== undefined && typeof c.paper_trading !== "boolean") {
    errors.push("paper_trading must be a boolean");
  }
  if (c.llm_model !== undefined && typeof c.llm_model !== "string") {
    errors.push("llm_model must be a string");
  }
  return errors;
}

// ─── Positions, intents, records ────────────────────────────────────

export type Side = "long" | "short";

export interface Position {
  id: string; // unique: order id / tx sig / mint+wallet
  strategy: string;
  asset: string; // mint or symbol
  label: string; // human description
  side: Side;
  entryPrice: number; // USD
  currentPrice: number; // USD
  sizeUsd: number; // notional cost basis
  pnl: number; // unrealized, USD
  pnlPercent: number;
  openedAt: string;
  paperTrade: boolean;
  meta?: Record<string, unknown>; // strategy-specific (sourceWallet, mint, ...)
}

export type TradeAction = "OPEN" | "CLOSE";

export interface TradeIntent {
  action: TradeAction;
  asset: string;
  label: string;
  side: Side;
  sizeUsd: number; // requested notional (risk may resize)
  confidence?: number; // 0..1, for policy gating (OPEN only)
  reason: string;
  /** For CLOSE: the Position.id being closed. */
  positionId?: string;
  meta?: Record<string, unknown>;
}

export interface ExecResult {
  ok: boolean;
  position?: Position; // present for a successful OPEN
  closedId?: string; // present for a successful CLOSE
  realizedPnl?: number; // present for a successful CLOSE
  price?: number; // fill price (USD)
  txSignature?: string;
  error?: string;
}

export interface TradeRecord {
  ts: string;
  strategy: string;
  action: TradeAction;
  asset: string;
  label: string;
  side: Side;
  sizeUsd: number;
  price: number;
  pnl?: number;
  paperTrade: boolean;
  txSignature?: string;
}

// ─── Agent state (persisted to DO storage) ──────────────────────────

export interface AgentState {
  running: boolean;
  config: AgentConfig;
  positions: Position[];
  recentTrades: TradeRecord[];
  cycleCount: number;
  totalPnl: number;
  dailyPnl: number;
  dailyPnlDate: string;
  killSwitch: boolean;
  llmCostTotal: number;
  cooldownUntil?: string;
  lastCycleAt?: string;
  lastCandidates: unknown[];
  lastError?: string;
}

// ─── The Strategy seam ──────────────────────────────────────────────

/** Shared services + live state handed to every strategy method. */
export interface Ctx {
  env: Env;
  config: AgentConfig;
  logger: Logger;
  solenrich: SolEnrichClient;
  llm: LLMProvider;
  solana: SolanaClient | null;
  discord: DiscordNotifier;
  /** Live view of currently-open positions for the active strategy. */
  positions: Position[];
  paperTrading: boolean;
}

/**
 * A trading strategy. The harness is a thin orchestrator that drives this seam:
 *   manage (close) → gather → decide (open) → policy gate → execute.
 * All strategy-specific logic lives here; core harness files never change per-agent.
 */
export interface Strategy<C = unknown> {
  readonly key: string;
  /** Discover candidate opportunities (typically SolEnrich-driven). */
  gather(ctx: Ctx): Promise<C[]>;
  /** Turn a candidate into an OPEN intent, or null to pass. */
  decide(candidate: C, ctx: Ctx): Promise<TradeIntent | null>;
  /** Re-price open positions and return CLOSE intents for any exits. */
  manage(ctx: Ctx): Promise<TradeIntent[]>;
  /** Apply an OPEN or CLOSE intent (paper or live). */
  execute(intent: TradeIntent, ctx: Ctx): Promise<ExecResult>;
}
