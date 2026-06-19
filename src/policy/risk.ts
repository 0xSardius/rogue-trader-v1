import { AgentConfig, Position, TradeIntent } from "../strategy/types";

export class RiskManager {
  /** Total notional currently at risk. */
  exposure(positions: Position[]): number {
    return positions.reduce((sum, p) => sum + p.sizeUsd, 0);
  }

  /** Daily drawdown as a fraction of exposure (0..1). */
  drawdown(dailyPnl: number, exposure: number): number {
    if (exposure <= 0) return 0;
    return Math.abs(Math.min(0, dailyPnl)) / exposure;
  }

  /** Cooldown end timestamp after a losing close. */
  cooldownEnd(config: AgentConfig): string {
    return new Date(Date.now() + config.cooldown_minutes * 60 * 1000).toISOString();
  }

  /**
   * Clamp an OPEN intent's requested size to the configured caps.
   * Returns a new intent with a safe sizeUsd. CLOSE intents pass through.
   */
  size(intent: TradeIntent, config: AgentConfig): TradeIntent {
    if (intent.action !== "OPEN") return intent;
    const sizeUsd = Math.max(0, Math.min(intent.sizeUsd, config.max_position_usd));
    return { ...intent, sizeUsd };
  }
}
