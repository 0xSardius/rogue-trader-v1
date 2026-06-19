import { Env } from "../env";
import { Logger } from "../lib/logger";
import { DiscordNotifier } from "../lib/discord";
import { SolEnrichClient } from "../providers/solenrich/client";
import { LLMProvider } from "../providers/llm/provider";
import { SolanaClient } from "../providers/solana";
import { PolicyEngine } from "../policy/engine";
import { RiskManager } from "../policy/risk";
import { createStrategy } from "../strategy/registry";
import {
  AgentConfig,
  AgentState,
  Ctx,
  DEFAULT_CONFIG,
  Strategy,
  TradeIntent,
  TradeRecord,
  validateConfig,
} from "../strategy/types";

const MAX_TRADE_RECORDS = 100;

/**
 * Thin orchestrator (MAHORAGA pattern). Owns the DO lifecycle, alarm scheduling,
 * persisted state, config, kill switch, and dashboard API. All trading logic
 * lives behind the Strategy seam — this file never changes per-agent.
 */
export class Harness implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private logger: Logger;
  private discord: DiscordNotifier;
  private solenrich: SolEnrichClient;
  private llm: LLMProvider;
  private solana: SolanaClient | null;
  private policy: PolicyEngine;
  private risk: RiskManager;
  private strategy: Strategy;
  private agentState: AgentState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.logger = new Logger();

    const requiredEnv = ["API_TOKEN", "KILL_SWITCH_SECRET"] as const;
    for (const key of requiredEnv) {
      if (!env[key]) this.logger.error("harness", `Missing required environment variable: ${key}`);
    }

    this.strategy = createStrategy(env.STRATEGY);
    this.discord = new DiscordNotifier(env.DISCORD_WEBHOOK_URL, this.logger);
    this.policy = new PolicyEngine(this.logger);
    this.risk = new RiskManager();

    this.solenrich = new SolEnrichClient(this.logger, {
      baseUrl: env.SOLENRICH_URL ?? undefined,
      enabled: env.SOLENRICH_ENABLED !== "false",
      internalKey: env.SOLENRICH_INTERNAL_KEY,
    });

    this.llm = new LLMProvider(this.logger, {
      anthropicKey: env.ANTHROPIC_API_KEY,
      openaiKey: env.OPENAI_API_KEY,
    });

    // SolanaClient only when live-trading secrets are present (graceful paper degradation).
    this.solana = env.WALLET_PRIVATE_KEY && env.SOLANA_RPC_URL
      ? new SolanaClient(env.SOLANA_RPC_URL, env.WALLET_PRIVATE_KEY, this.logger)
      : null;

    this.agentState = {
      running: false,
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
    };

    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<AgentState>("agentState");
      if (saved) {
        this.agentState = { ...this.agentState, ...saved };
        this.agentState.config = { ...DEFAULT_CONFIG, ...this.agentState.config };
        const errs = validateConfig(this.agentState.config);
        if (errs.length > 0) {
          this.logger.warn("harness", "Saved config invalid, reverting to defaults", { errors: errs });
          this.agentState.config = DEFAULT_CONFIG;
        }
      }
    });
  }

  private buildCtx(): Ctx {
    return {
      env: this.env,
      config: this.agentState.config,
      logger: this.logger,
      solenrich: this.solenrich,
      llm: this.llm,
      solana: this.solana,
      discord: this.discord,
      positions: this.agentState.positions,
      paperTrading: this.agentState.config.paper_trading,
    };
  }

  private recordTrade(rec: TradeRecord): void {
    this.agentState.recentTrades.push(rec);
    if (this.agentState.recentTrades.length > MAX_TRADE_RECORDS) {
      this.agentState.recentTrades = this.agentState.recentTrades.slice(-MAX_TRADE_RECORDS);
    }
  }

  // ─── Core loop ──────────────────────────────────────────────────

  async runCycle(): Promise<void> {
    if (this.agentState.killSwitch) {
      this.logger.warn("harness", "Kill switch active — skipping cycle");
      return;
    }

    this.logger.info("harness", `Cycle #${this.agentState.cycleCount + 1} (strategy: ${this.strategy.key})`);

    // Reset daily P&L at UTC midnight
    const today = new Date().toISOString().split("T")[0];
    if (today !== this.agentState.dailyPnlDate) {
      this.agentState.dailyPnl = 0;
      this.agentState.dailyPnlDate = today;
    }

    try {
      const ctx = this.buildCtx();

      // 1. Manage existing positions → close intents (never policy-gated)
      const closeIntents = await this.strategy.manage(ctx);
      for (const intent of closeIntents) {
        await this.applyClose(intent, ctx);
      }

      // 2. Gather candidates
      const candidates = await this.strategy.gather(ctx);
      this.agentState.lastCandidates = candidates.slice(0, 20);

      // 3. Decide → policy gate → size → execute
      for (const candidate of candidates) {
        const intent = await this.strategy.decide(candidate, ctx);
        if (!intent || intent.action !== "OPEN") continue;

        const result = this.policy.validate(intent, this.agentState, this.agentState.config);
        if (!result.approved) {
          this.logger.info("harness", `OPEN rejected: ${result.reason}`, { asset: intent.asset });
          continue;
        }

        await this.applyOpen(this.risk.size(intent, this.agentState.config), ctx);
      }

      this.agentState.cycleCount++;
      this.agentState.lastCycleAt = new Date().toISOString();
      this.agentState.llmCostTotal = this.llm.stats.totalCost;
      this.agentState.lastError = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.agentState.lastError = msg;
      this.logger.error("harness", "Cycle failed", { error: msg });
      await this.discord.cycleError(msg, this.agentState.cycleCount);
    }

    await this.saveState();
    await this.scheduleNextCycle();
  }

  private async applyOpen(intent: TradeIntent, ctx: Ctx): Promise<void> {
    if (intent.sizeUsd <= 0) {
      this.logger.warn("harness", "Skipping OPEN with zero size", { asset: intent.asset });
      return;
    }
    try {
      const res = await this.strategy.execute(intent, ctx);
      if (!res.ok || !res.position) {
        if (!res.ok) this.logger.warn("harness", "OPEN execute failed", { asset: intent.asset, error: res.error });
        return;
      }
      this.agentState.positions.push(res.position);
      this.recordTrade({
        ts: new Date().toISOString(),
        strategy: this.strategy.key,
        action: "OPEN",
        asset: intent.asset,
        label: intent.label,
        side: intent.side,
        sizeUsd: res.position.sizeUsd,
        price: res.price ?? res.position.entryPrice,
        paperTrade: res.position.paperTrade,
        txSignature: res.txSignature,
      });
      this.logger.trade("harness", "OPEN executed", { asset: intent.asset, sizeUsd: res.position.sizeUsd });
      await this.discord.tradeOpened(intent.label, intent.side, res.position.sizeUsd, res.price ?? res.position.entryPrice, res.position.paperTrade);
    } catch (err) {
      this.logger.error("harness", "OPEN execute threw", {
        asset: intent.asset,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async applyClose(intent: TradeIntent, ctx: Ctx): Promise<void> {
    try {
      const res = await this.strategy.execute(intent, ctx);
      if (!res.ok || !res.closedId) {
        if (!res.ok) this.logger.warn("harness", "CLOSE execute failed", { asset: intent.asset, error: res.error });
        return;
      }
      const pnl = res.realizedPnl ?? 0;
      const paper = this.agentState.positions.find((p) => p.id === res.closedId)?.paperTrade ?? this.agentState.config.paper_trading;
      this.agentState.positions = this.agentState.positions.filter((p) => p.id !== res.closedId);
      this.agentState.dailyPnl += pnl;
      this.agentState.totalPnl += pnl;
      this.recordTrade({
        ts: new Date().toISOString(),
        strategy: this.strategy.key,
        action: "CLOSE",
        asset: intent.asset,
        label: intent.label,
        side: intent.side,
        sizeUsd: 0,
        price: res.price ?? 0,
        pnl,
        paperTrade: paper,
        txSignature: res.txSignature,
      });
      if (pnl < 0) this.agentState.cooldownUntil = this.risk.cooldownEnd(this.agentState.config);
      this.logger.trade("harness", "CLOSE executed", { asset: intent.asset, pnl });
      await this.discord.tradeClosed(intent.reason, intent.label, pnl, paper);
    } catch (err) {
      this.logger.error("harness", "CLOSE execute threw", {
        asset: intent.asset,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put("agentState", this.agentState);
  }

  private async scheduleNextCycle(): Promise<void> {
    if (this.agentState.running) {
      await this.state.storage.setAlarm(Date.now() + this.agentState.config.poll_interval_ms);
    }
  }

  async alarm(): Promise<void> {
    await this.runCycle();
  }

  // ─── Dashboard API ──────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const token = request.headers.get("Authorization")?.replace("Bearer ", "");
    if (token !== this.env.API_TOKEN) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      if (method === "GET") {
        switch (path) {
          case "/status":
            return Response.json({
              strategy: this.strategy.key,
              running: this.agentState.running,
              cycleCount: this.agentState.cycleCount,
              lastCycleAt: this.agentState.lastCycleAt,
              positionsCount: this.agentState.positions.length,
              totalPnl: this.agentState.totalPnl,
              dailyPnl: this.agentState.dailyPnl,
              llmCost: this.agentState.llmCostTotal,
              killSwitch: this.agentState.killSwitch,
              paperTrading: this.agentState.config.paper_trading,
              cooldownUntil: this.agentState.cooldownUntil,
              lastError: this.agentState.lastError,
            });
          case "/positions":
            return Response.json(this.agentState.positions);
          case "/candidates":
            return Response.json(this.agentState.lastCandidates);
          case "/history":
            return Response.json(this.agentState.recentTrades.slice(-100).reverse());
          case "/logs":
            return Response.json(this.logger.getEntries(100));
          case "/config":
            return Response.json(this.agentState.config);
        }
      }

      if (method === "PUT" && path === "/config") {
        const update = (await request.json()) as Partial<AgentConfig>;
        const proposed = { ...this.agentState.config, ...update };
        const errs = validateConfig(proposed);
        if (errs.length > 0) {
          return Response.json({ error: "Invalid config", details: errs }, { status: 400 });
        }
        this.agentState.config = proposed;
        await this.saveState();
        return Response.json(this.agentState.config);
      }

      if (method === "POST") {
        switch (path) {
          case "/start":
            this.agentState.running = true;
            await this.saveState();
            await this.scheduleNextCycle();
            this.logger.info("harness", "Agent started");
            await this.discord.agentStarted(this.strategy.key, this.agentState.config);
            return Response.json({ status: "started" });

          case "/stop":
            this.agentState.running = false;
            await this.state.storage.deleteAlarm();
            await this.saveState();
            this.logger.info("harness", "Agent stopped");
            return Response.json({ status: "stopped" });

          case "/run-once":
            await this.runCycle();
            return Response.json({ status: "cycle complete", cycleCount: this.agentState.cycleCount });

          case "/close-all":
            this.agentState.positions = [];
            await this.saveState();
            this.logger.warn("harness", "Emergency close-all (state cleared)");
            return Response.json({ status: "all positions cleared" });

          case "/kill": {
            const body = (await request.json().catch(() => ({}))) as { secret?: string };
            if (body.secret !== this.env.KILL_SWITCH_SECRET) {
              return Response.json({ error: "Invalid kill switch secret" }, { status: 403 });
            }
            this.agentState.killSwitch = true;
            this.agentState.running = false;
            await this.state.storage.deleteAlarm();
            this.agentState.positions = [];
            await this.saveState();
            this.logger.error("harness", "KILL SWITCH ACTIVATED");
            await this.discord.killSwitchActivated();
            return Response.json({ status: "killed" });
          }
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      this.logger.error("harness", "API error", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
    }
  }
}
