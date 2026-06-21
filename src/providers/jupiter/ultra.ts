import { Logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rate-limiter";

export interface UltraOrder {
  transaction: string; // base64 tx to sign
  requestId: string;
  inAmount?: string; // native units
  outAmount?: string; // native units
  slippageBps?: number;
  swapType?: string;
}

export interface UltraExecuteResult {
  status: string; // "Success" on success
  signature?: string;
  code?: number;
  slot?: number;
  error?: string;
}

export interface SwapResult {
  ok: boolean;
  signature?: string;
  inAmount?: string;
  outAmount?: string;
  error?: string;
}

/**
 * Jupiter Ultra Swap client. Flow: GET /ultra/v1/order -> sign -> POST /ultra/v1/execute
 * (Ultra lands the transaction itself; we only sign). x-api-key required.
 *
 * Ultra is Jupiter's current recommended swap path (Iris routing engine, best-route +
 * gasless RTSE) — not deprecated. Signed orders have a ~2 min TTL. Slippage failures surface
 * as execute code -1001 / on-chain 6001; treat as retryable by re-quoting.
 */
export class JupiterUltraClient {
  private readonly baseUrl = "https://api.jup.ag/ultra/v1";
  private readonly apiKey?: string;
  private readonly logger: Logger;
  private readonly rateLimiter: RateLimiter;

  constructor(logger: Logger, apiKey?: string) {
    this.logger = logger;
    this.apiKey = apiKey;
    this.rateLimiter = new RateLimiter({ maxRequests: 40, windowMs: 10_000 });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async order(inputMint: string, outputMint: string, amount: string, taker: string): Promise<UltraOrder | null> {
    try {
      await this.rateLimiter.waitForSlot();
      this.rateLimiter.record();
      const qs = new URLSearchParams({ inputMint, outputMint, amount, taker });
      const res = await fetch(`${this.baseUrl}/order?${qs.toString()}`, { headers: this.headers() });
      if (!res.ok) {
        this.logger.error("jupiter", `ultra order ${res.status}`, { inputMint, outputMint });
        return null;
      }
      return (await res.json()) as UltraOrder;
    } catch (err) {
      this.logger.error("jupiter", "ultra order failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async execute(signedTransaction: string, requestId: string): Promise<UltraExecuteResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/execute`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ signedTransaction, requestId }),
      });
      if (!res.ok) {
        this.logger.error("jupiter", `ultra execute ${res.status}`);
        return null;
      }
      return (await res.json()) as UltraExecuteResult;
    } catch (err) {
      this.logger.error("jupiter", "ultra execute failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Full swap: order -> sign -> execute. `sign` returns the signed base64 tx (or null).
   * `amount` is in native units of `inputMint`.
   */
  async swap(
    inputMint: string,
    outputMint: string,
    amount: string,
    taker: string,
    sign: (txBase64: string) => string | null,
  ): Promise<SwapResult> {
    const order = await this.order(inputMint, outputMint, amount, taker);
    if (!order?.transaction || !order.requestId) {
      return { ok: false, error: "no order/transaction" };
    }

    const signed = sign(order.transaction);
    if (!signed) return { ok: false, error: "signing failed" };

    const result = await this.execute(signed, order.requestId);
    if (!result || result.status !== "Success") {
      return { ok: false, error: result?.error ?? `execute status ${result?.status} (code ${result?.code})` };
    }

    return { ok: true, signature: result.signature, inAmount: order.inAmount, outAmount: order.outAmount };
  }
}
