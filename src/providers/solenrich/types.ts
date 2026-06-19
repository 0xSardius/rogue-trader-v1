// SolEnrich response types — mirrored from the SolEnrich enricher return shapes.
// Source of truth: solenrich/src/enrichers/{copy-trade-analyzer,smart-money-flow,due-diligence}.ts
// Endpoints are POST /entrypoints/{key}/invoke with body { input: {...} }; with
// format:"json" the HTTP body is { output: <data below> }.

export interface SolEnrichConfig {
  baseUrl: string;
  enabled: boolean;
  format: "json" | "llm" | "both";
  timeout: number;
  /** Internal-free bypass key — swarm calls SolEnrich without paying x402. */
  internalKey?: string;
}

export const DEFAULT_SOLENRICH_CONFIG: SolEnrichConfig = {
  baseUrl: "https://api.solenrich.com",
  enabled: true,
  format: "json",
  timeout: 12_000,
};

// ─── smart-money-flow ───────────────────────────────────────────────

export interface SmartMoneyFlowInput {
  wallets?: string[]; // optional seed list (max 30); omit to use SolEnrich's curated default
  lookback_days?: number; // default 14
  min_win_rate?: number; // default 0.55
  top_n_tokens?: number; // default 10
  include_graph?: boolean; // default true
}

export interface SmartWallet {
  address: string;
  win_rate: number;
  total_pnl_usd: number;
  trades_analyzed: number;
  sharpe_ratio: number | null;
  consistency_score: number;
  labels: string[];
}

export interface AccumulatedToken {
  mint: string;
  symbol: string;
  smart_money_buyers: number; // count of seed wallets accumulating this token
  total_buy_volume_usd: number;
  avg_avg_hold_time_days: number | null; // avg holding period across accumulators
}

export interface WalletCluster {
  members: string[];
  size: number;
  suspicious_pattern: string | null;
}

export interface SmartMoneyFlowResult {
  seed_wallets_considered: number;
  seed_source: "user" | "derived" | "fallback";
  qualifying_smart_wallets: SmartWallet[];
  accumulated_tokens: AccumulatedToken[];
  clusters: WalletCluster[];
  last_updated: string;
}

// ─── copy-trade-signals ─────────────────────────────────────────────

export interface CopyTradeEnrichment {
  address: string;
  lookback_days: number;
  trades_analyzed: number;
  win_rate: number;
  total_pnl_usd: number;
  avg_pnl_per_trade_usd: number;
  avg_hold_time_days: number;
  consistency_score: number;
  trade_frequency_per_day: number;
  labels: string[];
  last_updated: string;
}

// ─── due-diligence (rug veto) ───────────────────────────────────────

export type DueDiligenceRecommendation = "SAFE" | "CAUTION" | "RISKY";

export interface DueDiligenceEnrichment {
  overall_risk_score: number;
  risk_level: string;
  risk_factors: string[];
  recommendation: DueDiligenceRecommendation;
  last_updated: string;
}
