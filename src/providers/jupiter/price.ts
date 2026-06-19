import { Logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rate-limiter";

export interface TokenPrice {
  usdPrice: number;
  decimals: number;
  priceChange24h?: number;
  blockId?: number;
}

/**
 * Jupiter Price API v3 client. GET /price/v3?ids={comma-separated mints} (max 50).
 * Response: { [mint]: { usdPrice, blockId, decimals, priceChange24h } }.
 * Unreliable tokens are omitted/null — we fail closed (skip) for safety-sensitive trades.
 */
export class JupiterPriceClient {
  private readonly baseUrl = "https://api.jup.ag/price/v3";
  private readonly apiKey?: string;
  private readonly logger: Logger;
  private readonly rateLimiter: RateLimiter;

  constructor(logger: Logger, apiKey?: string) {
    this.logger = logger;
    this.apiKey = apiKey;
    this.rateLimiter = new RateLimiter({ maxRequests: 50, windowMs: 10_000 });
  }

  /** Fetch USD prices for up to 50 mints. Missing/unreliable mints are absent from the map. */
  async getPrices(mints: string[]): Promise<Map<string, TokenPrice>> {
    const out = new Map<string, TokenPrice>();
    const unique = [...new Set(mints)].filter(Boolean);
    if (unique.length === 0) return out;
    if (unique.length > 50) {
      this.logger.warn("jupiter", "price request capped at 50 mints", { requested: unique.length });
      unique.length = 50;
    }

    try {
      await this.rateLimiter.waitForSlot();
      this.rateLimiter.record();

      const headers: Record<string, string> = {};
      if (this.apiKey) headers["x-api-key"] = this.apiKey;

      const response = await fetch(`${this.baseUrl}?ids=${unique.join(",")}`, { headers });
      if (!response.ok) {
        this.logger.error("jupiter", `price API ${response.status}`);
        return out;
      }

      const data = (await response.json()) as Record<string, TokenPrice | null>;
      for (const [mint, info] of Object.entries(data)) {
        if (info && typeof info.usdPrice === "number" && info.usdPrice > 0) {
          out.set(mint, info);
        }
      }
      return out;
    } catch (err) {
      this.logger.error("jupiter", "price fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return out;
    }
  }

  /** Convenience: single-mint price (null if unreliable/missing). */
  async getPrice(mint: string): Promise<TokenPrice | null> {
    return (await this.getPrices([mint])).get(mint) ?? null;
  }
}
