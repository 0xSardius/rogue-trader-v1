import { Strategy } from "./types";
import { EchoStrategy } from "./echo";
import { CopyTradeStrategy } from "./copy-trade";
import { JlpDeltaNeutralStrategy } from "./jlp-delta-neutral";

/**
 * Select the active strategy by key (from the STRATEGY env var).
 * Each agent in the swarm is the same Worker image with a different STRATEGY.
 */
export function createStrategy(key: string | undefined): Strategy {
  switch ((key ?? "echo").toLowerCase()) {
    case "copy-trade":
      return new CopyTradeStrategy();
    case "jlp-delta-neutral":
      return new JlpDeltaNeutralStrategy();
    case "echo":
      return new EchoStrategy();
    default:
      // Unknown key: fall back to the safe no-op rather than trading blind.
      return new EchoStrategy();
  }
}

export const KNOWN_STRATEGIES = ["echo", "copy-trade", "jlp-delta-neutral"] as const;
