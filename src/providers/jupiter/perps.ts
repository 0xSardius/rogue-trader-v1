// Jupiter Perps on-chain read client. No REST API exists — data lives in Anchor accounts.
// Constants + decode logic ported from SolEnrich's verified client (src/sources/jupiter-perps.ts).
// Read-only here; the write path (short open/close) lives in perps-write.ts.

import {
  AnchorProvider,
  BN,
  Program,
  type IdlAccounts,
  type Wallet as AnchorWallet,
} from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { IDL as PERPS_IDL, type Perpetuals } from "./idl/jupiter-perpetuals-idl";
import { IDL as DOVES_IDL, type Doves } from "./idl/doves-idl";

// ─── Verified constants (from SolEnrich src/sources/jupiter-perps.ts) ────────

export const JUPITER_PERPS_PROGRAM_ID = new PublicKey("PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu");
export const DOVES_PROGRAM_ID = new PublicKey("DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e");
export const JLP_POOL = new PublicKey("5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq");
export const JLP_MINT = new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");

export const CUSTODY_PUBKEY = {
  SOL: new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz"),
  BTC: new PublicKey("5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm"),
  ETH: new PublicKey("AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn"),
  USDC: new PublicKey("G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa"),
  USDT: new PublicKey("4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk"),
} as const;

export type PerpAsset = "SOL" | "BTC" | "ETH";

const TRADABLE: Array<{ symbol: PerpAsset; custody: PublicKey }> = [
  { symbol: "SOL", custody: CUSTODY_PUBKEY.SOL },
  { symbol: "BTC", custody: CUSTODY_PUBKEY.BTC },
  { symbol: "ETH", custody: CUSTODY_PUBKEY.ETH },
];

const USDC_DECIMALS = 6;
const BPS_POWER = 10_000;
const DBPS_POWER = 100_000;
const RATE_POWER = 1_000_000_000;

type Custody = IdlAccounts<Perpetuals>["custody"];
type PositionAccount = IdlAccounts<Perpetuals>["position"];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PerpMarket {
  symbol: PerpAsset;
  custody: string;
  markPriceUsd: number | null;
  borrowAprPct: number; // annualized; both longs and shorts PAY this (JLP borrow-fee model)
  utilizationPct: number;
  maxPositionSizeUsd: number;
}

/** Per-asset share of JLP's value — the hedge ratio for delta-neutral. */
export interface JlpComposition {
  aumUsd: number;
  weights: Record<string, number>; // symbol -> fraction of AUM (SOL/BTC/ETH/USDC/USDT)
  volatileWeight: number; // SOL+BTC+ETH share (the part that needs hedging)
  fetchedAt: number;
}

export interface PerpPosition {
  custody: string;
  symbol: string;
  side: "long" | "short";
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  entryPriceUsd: number;
  openTime: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function toNumber(bn: BN | undefined | null): number {
  if (!bn) return 0;
  try {
    return bn.toNumber();
  } catch {
    return Number(bn.toString());
  }
}

function bnDivScaled(num: BN, decimals: number): number {
  const str = num.toString();
  const sign = str.startsWith("-") ? -1 : 1;
  const abs = str.startsWith("-") ? str.slice(1) : str;
  if (abs.length <= decimals) return sign * (Number(abs) / 10 ** decimals);
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals);
  return sign * Number(`${whole}.${frac}`);
}

function computeBorrowApr(custody: Custody): { aprPct: number; utilizationPct: number } {
  const locked = custody.assets.locked as BN;
  const owned = custody.assets.owned as BN;
  const utilization = owned.isZero() ? 0 : toNumber(locked) / toNumber(owned);

  const jump = custody.jumpRateState;
  const maxRateBps = toNumber(jump.maxRateBps as BN);
  let annualBps = 0;

  if (maxRateBps > 0) {
    const minBps = toNumber(jump.minRateBps as BN);
    const targetBps = toNumber(jump.targetRateBps as BN);
    const targetUtil = toNumber(jump.targetUtilizationRate as BN) / RATE_POWER;
    if (utilization <= targetUtil && targetUtil > 0) {
      annualBps = minBps + ((targetBps - minBps) * utilization) / targetUtil;
    } else if (targetUtil < 1) {
      annualBps = targetBps + ((maxRateBps - targetBps) * (utilization - targetUtil)) / (1 - targetUtil);
    } else {
      annualBps = targetBps;
    }
  } else {
    const dbps = toNumber(custody.fundingRateState.hourlyFundingDbps as BN);
    annualBps = (dbps / DBPS_POWER) * 24 * 365 * BPS_POWER;
  }

  return { aprPct: (annualBps / BPS_POWER) * 100, utilizationPct: utilization * 100 };
}

function makeReadOnlyWallet(keypair: Keypair): AnchorWallet {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    async signTransaction<T extends Transaction | VersionedTransaction>(): Promise<T> {
      throw new Error("read-only wallet");
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(): Promise<T[]> {
      throw new Error("read-only wallet");
    },
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class JupiterPerpsClient {
  private readonly conn: Connection;
  private readonly perps: Program<Perpetuals>;
  private readonly doves: Program<Doves>;

  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, "confirmed");
    const provider = new AnchorProvider(this.conn, makeReadOnlyWallet(Keypair.generate()), AnchorProvider.defaultOptions());
    this.perps = new Program<Perpetuals>(PERPS_IDL, JUPITER_PERPS_PROGRAM_ID, provider);
    this.doves = new Program<Doves>(DOVES_IDL, DOVES_PROGRAM_ID, provider);
  }

  private async oraclePrice(oraclePda: PublicKey): Promise<number | null> {
    try {
      const ag = await this.doves.account.agPriceFeed.fetch(oraclePda);
      return toNumber(ag.price as BN) * 10 ** (ag.expo as number);
    } catch {
      /* fall through */
    }
    try {
      const f = await this.doves.account.priceFeed.fetch(oraclePda);
      return toNumber(f.price as BN) * 10 ** (f.expo as number);
    } catch {
      return null;
    }
  }

  private async markPrice(custody: Custody): Promise<number | null> {
    const ag = (custody.dovesAgOracle as PublicKey) ?? null;
    if (ag) {
      const p = await this.oraclePrice(ag);
      if (p !== null) return p;
    }
    const o = (custody.dovesOracle as PublicKey) ?? null;
    return o ? this.oraclePrice(o) : null;
  }

  /** Per-asset borrow APR, mark price, utilization, max position size for SOL/BTC/ETH. */
  async getMarkets(): Promise<PerpMarket[]> {
    const custodies = await Promise.all(TRADABLE.map((m) => this.perps.account.custody.fetch(m.custody)));
    const marks = await Promise.all(custodies.map((c) => this.markPrice(c as Custody)));
    return custodies.map((custody, i) => {
      const { aprPct, utilizationPct } = computeBorrowApr(custody as Custody);
      return {
        symbol: TRADABLE[i].symbol,
        custody: TRADABLE[i].custody.toBase58(),
        markPriceUsd: marks[i],
        borrowAprPct: aprPct,
        utilizationPct,
        maxPositionSizeUsd: bnDivScaled((custody as Custody).maxPositionSizeUsd as BN, USDC_DECIMALS),
      };
    });
  }

  /**
   * JLP basket weights (the delta-neutral hedge ratios). Approximation: weight =
   * (owned tokens × mark price) / AUM per custody, stables at $1. Ignores trader-PnL
   * liabilities (guaranteedUsd / global shorts) — a known simplification; good enough
   * for first-pass hedge sizing, refine before live capital.
   */
  async getJlpComposition(markets?: PerpMarket[]): Promise<JlpComposition> {
    const m = markets ?? (await this.getMarkets());
    const markBySymbol = new Map(m.map((x) => [x.symbol, x.markPriceUsd]));

    const all: Array<{ symbol: string; custody: PublicKey; price: number | null }> = [
      { symbol: "SOL", custody: CUSTODY_PUBKEY.SOL, price: markBySymbol.get("SOL") ?? null },
      { symbol: "BTC", custody: CUSTODY_PUBKEY.BTC, price: markBySymbol.get("BTC") ?? null },
      { symbol: "ETH", custody: CUSTODY_PUBKEY.ETH, price: markBySymbol.get("ETH") ?? null },
      { symbol: "USDC", custody: CUSTODY_PUBKEY.USDC, price: 1 },
      { symbol: "USDT", custody: CUSTODY_PUBKEY.USDT, price: 1 },
    ];

    const custodies = await Promise.all(all.map((a) => this.perps.account.custody.fetch(a.custody)));
    const usdValues = custodies.map((c, i) => {
      const cust = c as Custody;
      const price = all[i].price;
      if (price === null) return 0;
      const owned = Number((cust.assets.owned as BN).toString()) / 10 ** (cust.decimals as number);
      return owned * price;
    });

    const aumUsd = usdValues.reduce((s, v) => s + v, 0);
    const weights: Record<string, number> = {};
    all.forEach((a, i) => (weights[a.symbol] = aumUsd > 0 ? usdValues[i] / aumUsd : 0));
    const volatileWeight = (weights.SOL ?? 0) + (weights.BTC ?? 0) + (weights.ETH ?? 0);

    return { aumUsd, weights, volatileWeight, fetchedAt: Date.now() };
  }

  /** Open Jupiter Perps positions for a wallet (for managing the hedge shorts). */
  async getPositions(owner: string): Promise<PerpPosition[]> {
    const symByCustody = new Map<string, string>([
      [CUSTODY_PUBKEY.SOL.toBase58(), "SOL"],
      [CUSTODY_PUBKEY.BTC.toBase58(), "BTC"],
      [CUSTODY_PUBKEY.ETH.toBase58(), "ETH"],
    ]);
    const accounts = await this.perps.account.position.all([
      { memcmp: { offset: 8, bytes: new PublicKey(owner).toBase58() } },
    ]);
    return accounts
      .filter((p) => !(p.account.sizeUsd as BN).isZero())
      .map(({ account }) => {
        const pos = account as PositionAccount;
        const sideKey = Object.keys(pos.side as object)[0]?.toLowerCase() ?? "long";
        const sizeUsd = bnDivScaled(pos.sizeUsd as BN, USDC_DECIMALS);
        const collateralUsd = bnDivScaled(pos.collateralUsd as BN, USDC_DECIMALS);
        const custody = (pos.custody as PublicKey).toBase58();
        return {
          custody,
          symbol: symByCustody.get(custody) ?? "UNKNOWN",
          side: sideKey === "long" ? "long" : "short",
          sizeUsd,
          collateralUsd,
          leverage: collateralUsd > 0 ? sizeUsd / collateralUsd : 0,
          entryPriceUsd: bnDivScaled(pos.price as BN, USDC_DECIMALS),
          openTime: toNumber(pos.openTime as BN),
        };
      });
  }
}
