import {
  SolEnrichConfig,
  DEFAULT_SOLENRICH_CONFIG,
  DueDiligenceResponse,
  WhaleWatchResponse,
  CopyTradeSignalsResponse,
  TokenEnrichmentResponse,
  WalletEnrichmentResponse,
} from "./types";
import { Logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rate-limiter";

/**
 * SolEnrich client — the swarm's onchain-intelligence brain.
 *
 * NOTE (Phase 1 TODO): SolEnrich's current public surface is
 * `POST /entrypoints/{key}/invoke` with body `{ input: {...} }` (x402-paywalled).
 * The REST paths below mirror Pythia's older client shape and MUST be verified
 * against `/openapi.json` (or a live response) before copy-trade wiring. Prefer
 * internal-free mode via the `X-Internal-Key` header so the swarm doesn't pay
 * itself circular x402 fees.
 */
export class SolEnrichClient {
  private readonly config: SolEnrichConfig;
  private readonly logger: Logger;
  private readonly rateLimiter: RateLimiter;

  constructor(logger: Logger, config?: Partial<SolEnrichConfig>) {
    this.config = { ...DEFAULT_SOLENRICH_CONFIG, ...config };
    this.logger = logger;
    this.rateLimiter = new RateLimiter({ maxRequests: 10, windowMs: 10_000 });
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    if (!this.config.enabled) return null;

    const url = new URL(`${this.config.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    if (this.config.format) {
      url.searchParams.set("format", this.config.format);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      await this.rateLimiter.waitForSlot();
      this.rateLimiter.record();

      const headers: Record<string, string> = {};
      if (this.config.internalKey) {
        headers["X-Internal-Key"] = this.config.internalKey;
      }

      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers,
      });

      if (response.status === 402) {
        this.logger.warn("solenrich", "Payment required (x402) — check wallet balance or set internalKey", { path });
        return null;
      }

      if (!response.ok) {
        this.logger.error("solenrich", `API error ${response.status}`, { path, status: response.status });
        return null;
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logger.warn("solenrich", "Request timed out", { path });
      } else {
        this.logger.error("solenrich", "Request failed", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async dueDiligence(mint: string): Promise<DueDiligenceResponse | null> {
    return this.request<DueDiligenceResponse>(`/due-diligence/${mint}`);
  }

  async whaleWatch(mint: string): Promise<WhaleWatchResponse | null> {
    return this.request<WhaleWatchResponse>(`/whale-watch/${mint}`);
  }

  async copyTradeSignals(address: string): Promise<CopyTradeSignalsResponse | null> {
    return this.request<CopyTradeSignalsResponse>(`/copy-trade-signals/${address}`);
  }

  async enrichToken(mint: string, depth: "light" | "full" = "light"): Promise<TokenEnrichmentResponse | null> {
    return this.request<TokenEnrichmentResponse>(`/enrich/token/${mint}`, { depth });
  }

  async enrichWallet(address: string, depth: "light" | "full" = "light"): Promise<WalletEnrichmentResponse | null> {
    return this.request<WalletEnrichmentResponse>(`/enrich/wallet/${address}`, { depth });
  }

  async healthCheck(): Promise<boolean> {
    if (!this.config.enabled) return false;
    try {
      const response = await fetch(`${this.config.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
