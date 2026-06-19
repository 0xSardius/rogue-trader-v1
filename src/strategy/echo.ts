import { Ctx, ExecResult, Strategy, TradeIntent } from "./types";

/**
 * No-op strategy that proves the seam. Gathers nothing, decides nothing,
 * closes nothing, executes nothing. The harness should run a full cycle
 * cleanly with EchoStrategy active — the Phase 0 acceptance test.
 */
export class EchoStrategy implements Strategy<never> {
  readonly key = "echo";

  async gather(ctx: Ctx): Promise<never[]> {
    ctx.logger.info("strategy", "echo: gather (no-op)");
    return [];
  }

  async decide(): Promise<TradeIntent | null> {
    return null;
  }

  async manage(): Promise<TradeIntent[]> {
    return [];
  }

  async execute(intent: TradeIntent): Promise<ExecResult> {
    return { ok: false, error: `echo strategy does not execute (${intent.action})` };
  }
}
