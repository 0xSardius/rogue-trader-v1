import { describe, it, expect } from "vitest";
import { EchoStrategy } from "../src/strategy/echo";
import { createStrategy } from "../src/strategy/registry";
import { Logger } from "../src/lib/logger";
import { DiscordNotifier } from "../src/lib/discord";
import { SolEnrichClient } from "../src/providers/solenrich/client";
import { LLMProvider } from "../src/providers/llm/provider";
import { PolicyEngine } from "../src/policy/engine";
import { RiskManager } from "../src/policy/risk";
import { AgentState, Ctx, DEFAULT_CONFIG, Position } from "../src/strategy/types";

function buildCtx(positions: Position[] = []): Ctx {
  const logger = new Logger();
  return {
    env: {} as Ctx["env"],
    config: DEFAULT_CONFIG,
    logger,
    solenrich: new SolEnrichClient(logger, { enabled: false }),
    llm: new LLMProvider(logger, {}),
    solana: null,
    discord: new DiscordNotifier(undefined, logger),
    positions,
    paperTrading: true,
  };
}

describe("registry", () => {
  it("returns EchoStrategy for 'echo'", () => {
    expect(createStrategy("echo").key).toBe("echo");
  });
  it("falls back to echo for unknown/undefined keys", () => {
    expect(createStrategy(undefined).key).toBe("echo");
    expect(createStrategy("does-not-exist").key).toBe("echo");
  });
});

describe("EchoStrategy seam", () => {
  it("gathers nothing, decides nothing, closes nothing", async () => {
    const echo = new EchoStrategy();
    const ctx = buildCtx();
    expect(await echo.gather(ctx)).toEqual([]);
    expect(await echo.decide()).toBeNull();
    expect(await echo.manage()).toEqual([]);
    const res = await echo.execute({ action: "OPEN", asset: "X", label: "x", side: "long", sizeUsd: 1, reason: "t" });
    expect(res.ok).toBe(false);
  });

  it("a simulated cycle opens no positions (proves the orchestration seam)", async () => {
    const echo = new EchoStrategy();
    const policy = new PolicyEngine(new Logger());
    const risk = new RiskManager();
    const state: AgentState = {
      running: true, config: DEFAULT_CONFIG, positions: [], recentTrades: [],
      cycleCount: 0, totalPnl: 0, dailyPnl: 0, dailyPnlDate: "2026-01-01",
      killSwitch: false, llmCostTotal: 0, lastCandidates: [],
    };
    const ctx = buildCtx(state.positions);

    // Mirror harness.runCycle orchestration with the no-op strategy.
    for (const intent of await echo.manage()) {
      void intent; // no closes
    }
    const candidates = await echo.gather(ctx);
    for (const _c of candidates) {
      const intent = await echo.decide();
      if (!intent || intent.action !== "OPEN") continue;
      if (!policy.validate(intent, state, state.config).approved) continue;
      const res = await echo.execute(risk.size(intent, state.config));
      if (res.ok && res.position) state.positions.push(res.position);
    }

    expect(state.positions).toHaveLength(0);
    expect(state.totalPnl).toBe(0);
  });
});
