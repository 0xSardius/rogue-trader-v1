export interface SolEnrichConfig {
  baseUrl: string;
  enabled: boolean;
  format: "json" | "llm" | "both";
  timeout: number;
  /** Internal-free bypass key — swarm calls SolEnrich without paying x402 (see scope). */
  internalKey?: string;
}

export const DEFAULT_SOLENRICH_CONFIG: SolEnrichConfig = {
  baseUrl: "https://api.solenrich.com",
  enabled: true,
  format: "json",
  timeout: 10_000,
};

export interface DueDiligenceResponse {
  mint: string;
  tokenName?: string;
  riskVerdict: "SAFE" | "CAUTION" | "RISKY";
  securityAnalysis: {
    mintAuthority: boolean;
    freezeAuthority: boolean;
    isVerified: boolean;
    flags: string[];
  };
  whaleTracking: {
    topHolders: Array<{
      address: string;
      balance: number;
      percentOfSupply: number;
      change24h?: number;
    }>;
    concentration: number; // % held by top 10
  };
  holderDistribution: {
    totalHolders: number;
    retailPercentage: number;
    whalePercentage: number;
  };
  summary: string;
}

export interface WhaleWatchResponse {
  mint: string;
  topHolders: Array<{
    address: string;
    balance: number;
    percentOfSupply: number;
    balanceChange24h: number;
    label?: string;
  }>;
  pattern: "accumulating" | "distributing" | "stable" | "unknown";
  netFlow24h: number;
  summary: string;
}

export interface CopyTradeSignalsResponse {
  address: string;
  pnl30d: number;
  winRate: number;
  tradeCount: number;
  consistency: number; // 0-1
  smartMoneyLabel: boolean;
  topTokens: Array<{
    mint: string;
    symbol: string;
    pnl: number;
  }>;
  summary: string;
}

export interface TokenEnrichmentResponse {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  marketCap?: number;
  volume24h: number;
  liquidity: number;
  riskFlags: string[];
  summary: string;
}

export interface WalletEnrichmentResponse {
  address: string;
  solBalance: number;
  tokenCount: number;
  topHoldings: Array<{
    mint: string;
    symbol: string;
    balance: number;
    valueUsd: number;
  }>;
  labels: string[];
  riskScore: number; // 0-100
  summary: string;
}

export interface SolEnrichErrorResponse {
  error: string;
  code: string;
  details?: string;
}
