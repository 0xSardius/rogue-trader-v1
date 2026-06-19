/** Worker environment bindings + secrets. Defined separately to avoid circular imports. */
export interface Env {
  // Durable Object + storage
  HARNESS: DurableObjectNamespace;
  CACHE?: KVNamespace;

  // Strategy selection
  STRATEGY?: string; // "echo" | "copy-trade" | ... (defaults to "echo")

  // Solana / execution
  SOLANA_RPC_URL?: string;
  WALLET_PUBKEY?: string;
  WALLET_PRIVATE_KEY?: string; // live trading only — never log
  JUPITER_API_KEY?: string;

  // SolEnrich (the brain)
  SOLENRICH_URL?: string;
  SOLENRICH_ENABLED?: string;
  SOLENRICH_INTERNAL_KEY?: string;

  // LLM (rug/sanity veto)
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;

  // Ops
  API_TOKEN: string;
  KILL_SWITCH_SECRET: string;
  DISCORD_WEBHOOK_URL?: string;
}
