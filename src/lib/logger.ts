export type LogLevel = "info" | "warn" | "error" | "trade" | "debug";

export type Component =
  | "harness"
  | "strategy"
  | "solenrich"
  | "llm"
  | "solana"
  | "jupiter"
  | "policy"
  | "storage"
  | "discord";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: Component;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_LOG_ENTRIES = 500;

export class Logger {
  private entries: LogEntry[] = [];

  log(level: LogLevel, component: Component, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      data,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries = this.entries.slice(-MAX_LOG_ENTRIES);
    }

    const prefix = `[${entry.level.toUpperCase()}][${entry.component}]`;
    const msg = `${prefix} ${entry.message}`;
    if (data) {
      console.log(msg, JSON.stringify(data));
    } else {
      console.log(msg);
    }
  }

  info(component: Component, message: string, data?: Record<string, unknown>): void {
    this.log("info", component, message, data);
  }

  warn(component: Component, message: string, data?: Record<string, unknown>): void {
    this.log("warn", component, message, data);
  }

  error(component: Component, message: string, data?: Record<string, unknown>): void {
    this.log("error", component, message, data);
  }

  trade(component: Component, message: string, data?: Record<string, unknown>): void {
    this.log("trade", component, message, data);
  }

  debug(component: Component, message: string, data?: Record<string, unknown>): void {
    this.log("debug", component, message, data);
  }

  getEntries(limit?: number): LogEntry[] {
    if (limit) {
      return this.entries.slice(-limit);
    }
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
