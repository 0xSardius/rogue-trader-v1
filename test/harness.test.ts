import { describe, it, expect } from "vitest";
import { Harness } from "../src/durable-objects/harness";
import { Env } from "../src/env";
import { ExecResult, Position, Strategy, TradeIntent } from "../src/strategy/types";

// ─── Minimal in-memory DurableObjectState ───────────────────────────

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: async (cb: () => Promise<void>) => cb(),
  };
}

function makeEnv(over: Partial<Env> = {}): Env {
  return { API_TOKEN: "tok", KILL_SWITCH_SECRET: "sek", STRATEGY: "echo", ...over } as Env;
}

function makeHarness(over: Partial<Env> = {}) {
  return new Harness(fakeState() as unknown as DurableObjectState, makeEnv(over));
}

function pos(id: string): Position {
  return {
    id, strategy: "fake", asset: id, label: id, side: "long",
    entryPrice: 1, currentPrice: 1, sizeUsd: 25, pnl: 0, pnlPercent: 0,
    openedAt: new Date().toISOString(), paperTrade: true, meta: { mint: id, tokenAmount: 10, decimals: 6 },
  };
}

/** Strategy whose CLOSE either succeeds (realizing a fixed pnl) or fails (won't liquidate). */
class FakeStrategy implements Strategy {
  readonly key = "fake";
  constructor(private opts: { pnl?: number; failIds?: Set<string> } = {}) {}
  async gather(): Promise<unknown[]> { return []; }
  async decide(): Promise<TradeIntent | null> { return null; }
  async manage(): Promise<TradeIntent[]> { return []; }
  async execute(intent: TradeIntent): Promise<ExecResult> {
    if (intent.action !== "CLOSE") return { ok: false, error: "fake opens nothing" };
    if (this.opts.failIds?.has(intent.positionId!)) return { ok: false, error: "swap failed" };
    return { ok: true, closedId: intent.positionId, realizedPnl: this.opts.pnl ?? 1, price: 1 };
  }
}

function inject(h: Harness, strategy: Strategy, positions: Position[]) {
  // Reach into private state for an integration test (no production seam needed).
  (h as unknown as { strategy: Strategy }).strategy = strategy;
  (h as unknown as { agentState: { positions: Position[] } }).agentState.positions = positions;
}

const auth = { Authorization: "Bearer tok" };
function post(path: string, body?: unknown, headers: Record<string, string> = auth): Request {
  return new Request(`https://rt${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Harness emergency liquidation", () => {
  it("close-all liquidates every position and realizes P&L", async () => {
    const h = makeHarness();
    inject(h, new FakeStrategy({ pnl: 2 }), [pos("A"), pos("B")]);

    const res = await h.fetch(post("/close-all"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; closed: number; failed: string[] };
    expect(body.closed).toBe(2);
    expect(body.failed).toEqual([]);

    const status = (await (await h.fetch(new Request("https://rt/status", { headers: auth })).then((r) => r)).json()) as {
      positionsCount: number; totalPnl: number;
    };
    expect(status.positionsCount).toBe(0);
    expect(status.totalPnl).toBeCloseTo(4); // 2 + 2
  });

  it("close-all keeps positions it cannot liquidate (207, never reports flat while holding)", async () => {
    const h = makeHarness();
    inject(h, new FakeStrategy({ failIds: new Set(["B"]) }), [pos("A"), pos("B")]);

    const res = await h.fetch(post("/close-all"));
    expect(res.status).toBe(207);
    const body = (await res.json()) as { closed: number; failed: string[] };
    expect(body.closed).toBe(1);
    expect(body.failed).toEqual(["B"]);
  });

  it("kill switch rejects a bad secret", async () => {
    const h = makeHarness();
    inject(h, new FakeStrategy(), [pos("A")]);
    const res = await h.fetch(post("/kill", { secret: "wrong" }));
    expect(res.status).toBe(403);
  });

  it("kill switch halts, flattens, and trips the switch", async () => {
    const h = makeHarness();
    inject(h, new FakeStrategy({ pnl: 0 }), [pos("A")]);
    const res = await h.fetch(post("/kill", { secret: "sek" }));
    expect(res.status).toBe(200);

    const status = (await (await h.fetch(new Request("https://rt/status", { headers: auth }))).json()) as {
      killSwitch: boolean; running: boolean; positionsCount: number;
    };
    expect(status.killSwitch).toBe(true);
    expect(status.running).toBe(false);
    expect(status.positionsCount).toBe(0);
  });

  it("requires auth", async () => {
    const h = makeHarness();
    const res = await h.fetch(new Request("https://rt/status"));
    expect(res.status).toBe(401);
  });
});
