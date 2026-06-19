import { Strategy } from "./types";
import { EchoStrategy } from "./echo";

/**
 * Select the active strategy by key (from the STRATEGY env var).
 * Each agent in the swarm is the same Worker image with a different STRATEGY.
 *
 * Phase 1 will register: case "copy-trade": return new CopyTradeStrategy();
 */
export function createStrategy(key: string | undefined): Strategy {
  switch ((key ?? "echo").toLowerCase()) {
    case "echo":
      return new EchoStrategy();
    default:
      // Unknown key: fall back to the safe no-op rather than trading blind.
      return new EchoStrategy();
  }
}

export const KNOWN_STRATEGIES = ["echo"] as const;
