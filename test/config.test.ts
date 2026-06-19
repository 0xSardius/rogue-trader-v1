import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../src/strategy/types";

describe("validateConfig", () => {
  it("accepts the default config", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it("accepts a valid partial update", () => {
    expect(validateConfig({ max_positions: 5, max_position_usd: 100 })).toEqual([]);
  });

  it("rejects out-of-range numbers", () => {
    const errs = validateConfig({ max_positions: 0, min_confidence: 2, daily_loss_limit_pct: -1 });
    expect(errs.length).toBe(3);
  });

  it("rejects wrong types", () => {
    // @ts-expect-error testing runtime guard
    const errs = validateConfig({ paper_trading: "yes", llm_model: 42 });
    expect(errs.length).toBe(2);
  });

  it("rejects an absurd poll interval", () => {
    expect(validateConfig({ poll_interval_ms: 1000 }).length).toBe(1);
  });
});
