import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/policy/engine";
import { Logger } from "../src/lib/logger";
import { AgentState, DEFAULT_CONFIG, Position, TradeIntent } from "../src/strategy/types";

const policy = new PolicyEngine(new Logger());

function baseState(over: Partial<AgentState> = {}): AgentState {
  return {
    running: true,
    config: DEFAULT_CONFIG,
    positions: [],
    recentTrades: [],
    cycleCount: 0,
    totalPnl: 0,
    dailyPnl: 0,
    dailyPnlDate: new Date().toISOString().split("T")[0],
    killSwitch: false,
    llmCostTotal: 0,
    lastCandidates: [],
    ...over,
  };
}

const open: TradeIntent = { action: "OPEN", asset: "X", label: "x", side: "long", sizeUsd: 10, reason: "t" };

function fillPositions(n: number): Position[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, strategy: "echo", asset: "X", label: "x", side: "long" as const,
    entryPrice: 1, currentPrice: 1, sizeUsd: 10, pnl: 0, pnlPercent: 0,
    openedAt: new Date().toISOString(), paperTrade: true,
  }));
}

describe("PolicyEngine", () => {
  it("approves a clean OPEN", () => {
    expect(policy.validate(open, baseState(), DEFAULT_CONFIG).approved).toBe(true);
  });

  it("always approves CLOSE, even under kill switch", () => {
    const close: TradeIntent = { ...open, action: "CLOSE", positionId: "p0" };
    expect(policy.validate(close, baseState({ killSwitch: true }), DEFAULT_CONFIG).approved).toBe(true);
  });

  it("blocks OPEN when kill switch is active", () => {
    const r = policy.validate(open, baseState({ killSwitch: true }), DEFAULT_CONFIG);
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/kill switch/i);
  });

  it("blocks OPEN during cooldown", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(policy.validate(open, baseState({ cooldownUntil: future }), DEFAULT_CONFIG).approved).toBe(false);
  });

  it("blocks OPEN at max positions", () => {
    const cfg = { ...DEFAULT_CONFIG, max_positions: 2 };
    const r = policy.validate(open, baseState({ positions: fillPositions(2) }), cfg);
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/max positions/i);
  });

  it("blocks OPEN below confidence threshold", () => {
    const lowConf: TradeIntent = { ...open, confidence: 0.2 };
    expect(policy.validate(lowConf, baseState(), DEFAULT_CONFIG).approved).toBe(false);
  });

  it("blocks OPEN when daily loss limit is exceeded", () => {
    const state = baseState({ positions: fillPositions(3), dailyPnl: -10 }); // 10 / 30 = 33% > 5%
    expect(policy.validate(open, state, DEFAULT_CONFIG).approved).toBe(false);
  });

  it("warns (but approves) when requested size exceeds the cap", () => {
    const big: TradeIntent = { ...open, sizeUsd: 9999 };
    const r = policy.validate(big, baseState(), DEFAULT_CONFIG);
    expect(r.approved).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
