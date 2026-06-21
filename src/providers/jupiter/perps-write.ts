import { SolanaClient } from "../solana";
import { PerpAsset } from "./perps";

/**
 * Jupiter Perps WRITE path (open/close short hedge legs) — DEVNET-GATED.
 *
 * Why gated: opening a Jupiter Perps position is a request-based on-chain flow
 * (`createIncreasePositionMarketRequest` → keeper fulfils via `increasePosition4`).
 * The verified instruction shape (from the published IDL) is:
 *
 *   accounts: owner(signer,mut), fundingAccount(mut), perpetuals, pool, position(mut),
 *             positionRequest(mut), positionRequestAta(mut), custody, collateralCustody,
 *             inputMint, referral?(optional), tokenProgram, associatedTokenProgram,
 *             systemProgram, eventAuthority, program
 *   params (CreateIncreasePositionMarketRequestParams):
 *             sizeUsdDelta(u64), collateralTokenDelta(u64), side(Long|Short),
 *             priceSlippage(u64), jupiterMinimumOut(Option<u64>), counter(u64)
 *
 * What's NOT yet verified (and must be, on devnet, before live capital):
 *   - PDA seed derivations for `position` and `positionRequest` (not in the IDL —
 *     need the community SDK / Jupiter docs; guessing risks lost/stuck funds)
 *   - the `eventAuthority` PDA + exact `perpetuals` account address
 *   - collateral custody = USDC custody for a SOL/BTC/ETH short; sizing of
 *     collateralTokenDelta vs leverage; priceSlippage units
 *   - keeper fulfilment latency + failure handling
 *
 * Until a devnet run validates the full open→fulfil→close cycle, the live methods
 * throw. Paper mode never calls this — Amalthea simulates the hedge legs there.
 */
export class PerpsWriteNotValidatedError extends Error {
  constructor(op: string) {
    super(
      `Jupiter Perps live ${op} is not devnet-validated yet — PDA seeds + instruction build must be ` +
        `verified on devnet before risking capital. Run Amalthea in paper_trading mode.`,
    );
    this.name = "PerpsWriteNotValidatedError";
  }
}

export interface OpenShortParams {
  asset: PerpAsset;
  sizeUsd: number; // notional to short
  collateralUsd: number; // USDC collateral to post
  slippageBps: number;
}

export interface PerpsWriteResult {
  ok: boolean;
  signature?: string;
  error?: string;
}

export class JupiterPerpsWriter {
  constructor(
    private readonly rpcUrl: string,
    private readonly solana: SolanaClient | null,
    private readonly devnetValidated: boolean,
  ) {}

  /** Open a short hedge leg. Throws until devnet-validated. */
  async openShort(_params: OpenShortParams): Promise<PerpsWriteResult> {
    if (!this.devnetValidated || !this.solana) throw new PerpsWriteNotValidatedError("openShort");
    // Build createIncreasePositionMarketRequest (side=Short) per the documented ABI above,
    // sign via this.solana, submit, await keeper fulfilment. Implement after devnet validation.
    void this.rpcUrl;
    throw new PerpsWriteNotValidatedError("openShort");
  }

  /** Close (decrease to zero) a short hedge leg. Throws until devnet-validated. */
  async closeShort(_asset: PerpAsset, _slippageBps: number): Promise<PerpsWriteResult> {
    if (!this.devnetValidated || !this.solana) throw new PerpsWriteNotValidatedError("closeShort");
    throw new PerpsWriteNotValidatedError("closeShort");
  }
}
