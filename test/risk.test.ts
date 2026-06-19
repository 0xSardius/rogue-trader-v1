import { describe, it, expect } from "vitest";
import { RiskManager } from "../src/policy/risk";
import { DEFAULT_CONFIG, Position, TradeIntent } from "../src/strategy/types";

const risk = new RiskManager();

function pos(sizeUsd: number): Position {
  return {
    id: `p${sizeUsd}`,
    strategy: "echo",
    asset: "X",
    label: "x",
    side: "long",
    entryPrice: 1,
    currentPrice: 1,
    sizeUsd,
    pnl: 0,
    pnlPercent: 0,
    openedAt: new Date().toISOString(),
    paperTrade: true,
  };
}

const openIntent: TradeIntent = {
  action: "OPEN",
  asset: "X",
  label: "x",
  side: "long",
  sizeUsd: 1000,
  reason: "test",
};

describe("RiskManager", () => {
  it("sums exposure", () => {
    expect(risk.exposure([pos(10), pos(15)])).toBe(25);
  });

  it("computes drawdown only on losses", () => {
    expect(risk.drawdown(-50, 100)).toBeCloseTo(0.5);
    expect(risk.drawdown(50, 100)).toBe(0); // gains don't count
    expect(risk.drawdown(-50, 0)).toBe(0); // no exposure
  });

  it("clamps OPEN size to max_position_usd", () => {
    const sized = risk.size(openIntent, { ...DEFAULT_CONFIG, max_position_usd: 25 });
    expect(sized.sizeUsd).toBe(25);
  });

  it("passes CLOSE intents through unchanged", () => {
    const close: TradeIntent = { ...openIntent, action: "CLOSE", sizeUsd: 0, positionId: "p1" };
    expect(risk.size(close, DEFAULT_CONFIG)).toEqual(close);
  });

  it("produces a future cooldown timestamp", () => {
    const end = new Date(risk.cooldownEnd({ ...DEFAULT_CONFIG, cooldown_minutes: 30 })).getTime();
    expect(end).toBeGreaterThan(Date.now());
  });
});
