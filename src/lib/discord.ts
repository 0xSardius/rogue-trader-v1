import { Logger } from "./logger";

export type NotificationLevel = "trade" | "alert" | "error" | "info";

const LEVEL_COLORS: Record<NotificationLevel, number> = {
  trade: 0x00c853, // green
  alert: 0xffd600, // yellow
  error: 0xff1744, // red
  info: 0x2979ff, // blue
};

const LEVEL_EMOJI: Record<NotificationLevel, string> = {
  trade: "\u{1F4B0}",
  alert: "\u{26A0}\u{FE0F}",
  error: "\u{1F6A8}",
  info: "\u{2139}\u{FE0F}",
};

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
  footer?: { text: string };
}

export class DiscordNotifier {
  private readonly webhookUrl: string | undefined;
  private readonly logger: Logger;
  private readonly agentName: string;

  constructor(webhookUrl: string | undefined, logger: Logger, agentName = "Rogue Trader") {
    this.webhookUrl = webhookUrl;
    this.logger = logger;
    this.agentName = agentName;
  }

  get enabled(): boolean {
    return !!this.webhookUrl;
  }

  async notify(
    level: NotificationLevel,
    title: string,
    fields?: Record<string, string | number | boolean>,
    description?: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    const embed: DiscordEmbed = {
      title: `${LEVEL_EMOJI[level]} ${title}`,
      color: LEVEL_COLORS[level],
      timestamp: new Date().toISOString(),
      footer: { text: this.agentName },
    };

    if (description) {
      embed.description = description;
    }

    if (fields) {
      embed.fields = Object.entries(fields).map(([name, value]) => ({
        name,
        value: String(value),
        inline: String(value).length < 30,
      }));
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        this.logger.warn("discord", `Webhook returned ${response.status}`);
      }
    } catch (err) {
      this.logger.warn("discord", "Webhook delivery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Convenience methods (generic, strategy-agnostic) ───────────

  async tradeOpened(label: string, side: string, sizeUsd: number, price: number, paper: boolean): Promise<void> {
    await this.notify("trade", `${paper ? "[PAPER] " : ""}OPEN ${side.toUpperCase()}`, {
      Asset: label.slice(0, 100),
      Size: `$${sizeUsd.toFixed(2)}`,
      Price: `$${price.toFixed(6)}`,
    });
  }

  async tradeClosed(reason: string, label: string, pnl: number, paper: boolean): Promise<void> {
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    await this.notify(pnl >= 0 ? "trade" : "alert", `${paper ? "[PAPER] " : ""}CLOSE: ${reason}`, {
      Asset: label.slice(0, 100),
      "P&L": pnlStr,
    });
  }

  async killSwitchActivated(): Promise<void> {
    await this.notify("error", "KILL SWITCH ACTIVATED", {}, "All positions closed. Agent halted. Manual intervention required.");
  }

  async cycleError(error: string, cycleCount: number): Promise<void> {
    await this.notify("error", "Cycle Failed", {
      Cycle: cycleCount,
      Error: error.slice(0, 200),
    });
  }

  async agentStarted(strategy: string, config: { paper_trading: boolean; max_positions: number; max_position_usd: number }): Promise<void> {
    await this.notify("info", "Agent Started", {
      Strategy: strategy,
      Mode: config.paper_trading ? "Paper Trading" : "LIVE TRADING",
      "Max Positions": config.max_positions,
      "Max Position $": `$${config.max_position_usd}`,
    });
  }
}
