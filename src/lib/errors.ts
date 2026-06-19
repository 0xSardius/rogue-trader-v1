export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class SwapApiError extends AgentError {
  constructor(message: string, public readonly status?: number) {
    super(message, "SWAP_API_ERROR", status === 429 || (status !== undefined && status >= 500));
    this.name = "SwapApiError";
  }
}

export class SolanaTransactionError extends AgentError {
  constructor(message: string, public readonly signature?: string) {
    super(message, "SOLANA_TX_ERROR", false);
    this.name = "SolanaTransactionError";
  }
}

export class SolEnrichError extends AgentError {
  constructor(message: string, public readonly status?: number) {
    super(message, "SOLENRICH_ERROR", status !== 402);
    this.name = "SolEnrichError";
  }
}

export class LLMError extends AgentError {
  constructor(message: string, public readonly status?: number) {
    super(message, "LLM_ERROR", status === undefined || status >= 500);
    this.name = "LLMError";
  }
}

export class PolicyViolation extends AgentError {
  constructor(message: string) {
    super(message, "POLICY_VIOLATION", false);
    this.name = "PolicyViolation";
  }
}

export class RateLimitError extends AgentError {
  constructor(message: string) {
    super(message, "RATE_LIMIT", true);
    this.name = "RateLimitError";
  }
}
