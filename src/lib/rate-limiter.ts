export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 50,
  windowMs: 10_000,
};

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.config.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  canProceed(): boolean {
    this.pruneExpired();
    return this.timestamps.length < this.config.maxRequests;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  async waitForSlot(): Promise<void> {
    while (!this.canProceed()) {
      const oldest = this.timestamps[0];
      const waitMs = oldest + this.config.windowMs - Date.now() + 1;
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 10)));
    }
  }

  get remaining(): number {
    this.pruneExpired();
    return Math.max(0, this.config.maxRequests - this.timestamps.length);
  }

  reset(): void {
    this.timestamps = [];
  }
}
