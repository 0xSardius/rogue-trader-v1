import { Env } from "./env";

export { Harness } from "./durable-objects/harness";
export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — no auth
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        agent: "rogue-trader",
        strategy: env.STRATEGY ?? "echo",
        timestamp: new Date().toISOString(),
      });
    }

    // Dashboard API — forward to the Durable Object (one instance per strategy)
    if (url.pathname.startsWith("/api/")) {
      const instance = (env.STRATEGY ?? "echo").toLowerCase();
      const id = env.HARNESS.idFromName(`rt-${instance}`);
      const stub = env.HARNESS.get(id);

      const doPath = url.pathname.replace("/api", "");
      const doUrl = new URL(doPath + url.search, request.url);

      return stub.fetch(
        new Request(doUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    // Root — help text
    return new Response(
      [
        "Rogue Trader — Solana autonomous trading swarm",
        "",
        "Endpoints:",
        "  GET  /health         — Health check (no auth)",
        "  GET  /api/preflight  — Readiness gate (run before going live)",
        "  GET  /api/status     — Agent status",
        "  GET  /api/positions  — Open positions",
        "  GET  /api/candidates — Last gathered candidates",
        "  GET  /api/history    — Recent trade records",
        "  GET  /api/logs       — Recent log entries",
        "  GET  /api/config     — Agent configuration",
        "  PUT  /api/config     — Update configuration",
        "  POST /api/start      — Start agent loop",
        "  POST /api/stop       — Stop agent loop",
        "  POST /api/run-once   — Run a single cycle now",
        "  POST /api/close-all  — Emergency close all",
        "  POST /api/kill       — Kill switch (body: { secret })",
        "",
        "All /api/* endpoints require Bearer auth (API_TOKEN).",
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
};
