import {
  SolEnrichConfig,
  DEFAULT_SOLENRICH_CONFIG,
  SmartMoneyFlowInput,
  SmartMoneyFlowResult,
  CopyTradeEnrichment,
  DueDiligenceEnrichment,
} from "./types";
import { Logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rate-limiter";

/**
 * SolEnrich client — the swarm's onchain-intelligence brain.
 *
 * Calls `POST /entrypoints/{key}/invoke` with body `{ input: { ...args, format } }`.
 * With format:"json" the response body is `{ output: <data> }`. Prefer internal-free
 * mode (X-Internal-Key) so the swarm doesn't pay itself circular x402 fees.
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

  /** Invoke a SolEnrich entrypoint. Returns the unwrapped `output` payload, or null on failure. */
  async invoke<T>(key: string, input: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.config.enabled) return null;

    const url = `${this.config.baseUrl}/entrypoints/${key}/invoke`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      await this.rateLimiter.waitForSlot();
      this.rateLimiter.record();

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.config.internalKey) headers["X-Internal-Key"] = this.config.internalKey;

      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({ input: { ...input, format: this.config.format } }),
      });

      if (response.status === 402) {
        this.logger.warn("solenrich", "Payment required (x402) — fund wallet or set internalKey", { key });
        return null;
      }
      if (!response.ok) {
        this.logger.error("solenrich", `API error ${response.status}`, { key, status: response.status });
        return null;
      }

      const body = (await response.json()) as { output?: T } & Record<string, unknown>;
      // Lucid wraps handler returns as { output }. Fall back to the raw body if absent.
      return (body.output ?? (body as unknown as T)) ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logger.warn("solenrich", "Request timed out", { key });
      } else {
        this.logger.error("solenrich", "Request failed", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Orchestrated smart-money intelligence: qualifying wallets + tokens they're accumulating. */
  smartMoneyFlow(input: SmartMoneyFlowInput = {}): Promise<SmartMoneyFlowResult | null> {
    return this.invoke<SmartMoneyFlowResult>("smart-money-flow", { ...input });
  }

  /** Per-wallet copyability metrics (win rate, hold time, consistency). */
  copyTradeSignals(address: string, lookbackDays = 30): Promise<CopyTradeEnrichment | null> {
    return this.invoke<CopyTradeEnrichment>("copy-trade-signals", { address, lookback_days: lookbackDays });
  }

  /** Token research with a SAFE/CAUTION/RISKY recommendation — the rug veto. */
  dueDiligence(mint: string): Promise<DueDiligenceEnrichment | null> {
    return this.invoke<DueDiligenceEnrichment>("due-diligence", { mint });
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
