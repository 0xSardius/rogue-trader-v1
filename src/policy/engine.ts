import { Logger } from "../lib/logger";
import { AgentConfig, AgentState, TradeIntent } from "../strategy/types";

export interface PolicyResult {
  approved: boolean;
  reason?: string;
  warnings: string[];
}

/**
 * Strategy-agnostic gate for OPEN intents. CLOSE intents bypass this entirely —
 * we always allow exiting (even under cooldown / kill switch).
 */
export class PolicyEngine {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  validate(intent: TradeIntent, state: AgentState, config: AgentConfig): PolicyResult {
    const warnings: string[] = [];

    if (intent.action !== "OPEN") {
      // Closes are never blocked.
      return { approved: true, warnings };
    }

    // Kill switch
    if (state.killSwitch) {
      return { approved: false, reason: "Kill switch is active", warnings };
    }

    // Cooldown
    if (state.cooldownUntil && Date.now() < new Date(state.cooldownUntil).getTime()) {
      return { approved: false, reason: `In cooldown until ${state.cooldownUntil}`, warnings };
    }

    // Daily loss limit (drawdown vs current exposure)
    const exposure = state.positions.reduce((sum, p) => sum + p.sizeUsd, 0);
    if (exposure > 0 && state.dailyPnl < 0) {
      const drawdownPct = (Math.abs(state.dailyPnl) / exposure) * 100;
      if (drawdownPct >= config.daily_loss_limit_pct) {
        return {
          approved: false,
          reason: `Daily loss limit hit: ${drawdownPct.toFixed(1)}% >= ${config.daily_loss_limit_pct}%`,
          warnings,
        };
      }
    }

    // Position count
    if (state.positions.length >= config.max_positions) {
      return {
        approved: false,
        reason: `Max positions reached: ${state.positions.length}/${config.max_positions}`,
        warnings,
      };
    }

    // Confidence threshold (only when the intent carries one)
    if (intent.confidence !== undefined && intent.confidence < config.min_confidence) {
      return {
        approved: false,
        reason: `Confidence too low: ${intent.confidence.toFixed(2)} < ${config.min_confidence}`,
        warnings,
      };
    }

    // Position size (risk manager clamps; we just warn)
    if (intent.sizeUsd > config.max_position_usd) {
      warnings.push(`Requested size $${intent.sizeUsd} exceeds max $${config.max_position_usd} (will be clamped)`);
    }

    this.logger.info("policy", "OPEN approved", {
      asset: intent.asset,
      sizeUsd: intent.sizeUsd,
      confidence: intent.confidence,
      warnings,
    });

    return { approved: true, warnings };
  }
}
