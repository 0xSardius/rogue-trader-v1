import {
  Connection,
  Keypair,
  VersionedTransaction,
  Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Logger } from "../lib/logger";

export interface SignAndSendResult {
  signature: string;
  confirmed: boolean;
  error?: string;
}

export class SolanaClient {
  private readonly connection: Connection;
  private readonly keypair: Keypair;
  private readonly commitment: Commitment;
  private readonly logger: Logger;

  constructor(
    rpcUrl: string,
    privateKey: string,
    logger: Logger,
    commitment: Commitment = "confirmed",
  ) {
    this.connection = new Connection(rpcUrl, commitment);
    this.keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    this.commitment = commitment;
    this.logger = logger;
  }

  get publicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  /** Sign a base64-encoded VersionedTransaction (e.g. from Jupiter), submit, and confirm. */
  async signAndSend(transactionBase64: string): Promise<SignAndSendResult> {
    try {
      const txBuffer = Buffer.from(transactionBase64, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);

      transaction.sign([this.keypair]);

      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight: true,
          maxRetries: 2,
        },
      );

      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash(this.commitment);

      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        this.commitment,
      );

      if (confirmation.value.err) {
        this.logger.error("solana", "Transaction confirmed with error", {
          signature,
          error: JSON.stringify(confirmation.value.err),
        });
        return { signature, confirmed: false, error: JSON.stringify(confirmation.value.err) };
      }

      this.logger.info("solana", "Transaction confirmed", { signature });
      return { signature, confirmed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error("solana", "signAndSend failed", { error: errorMessage });
      return { signature: "", confirmed: false, error: errorMessage };
    }
  }

  async getBalance(): Promise<number> {
    return this.connection.getBalance(this.keypair.publicKey);
  }

  async getBalanceSol(): Promise<number> {
    const lamports = await this.getBalance();
    return lamports / 1e9;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.connection.getSlot();
      return true;
    } catch {
      return false;
    }
  }
}
