# Rogue Trader Checkpoint

## Status: Phase 0 complete (thin scaffold) — ready for Phase 1 (copy-trade "Metis")

## What exists
- `docs/rogue-trader-scope.md` — frozen scope for Phase 0 + Phase 1.
- **Phase 0 scaffold (MAHORAGA pattern, extracted from Pythia):**
  - `src/strategy/types.ts` — the Strategy seam: `Strategy`, `Ctx`, generic `Position`, `TradeIntent`,
    `ExecResult`, `TradeRecord`, `AgentConfig`/`DEFAULT_CONFIG`/`validateConfig`, `AgentState`.
  - `src/strategy/echo.ts` — no-op `EchoStrategy` proving the seam. `src/strategy/registry.ts` — select by `STRATEGY`.
  - `src/durable-objects/harness.ts` — thin DO orchestrator: cycle (manage→gather→decide→policy→execute),
    alarm scheduling, state persistence, kill switch, dashboard API. Strategy-agnostic; never changes per-agent.
  - `src/policy/{engine,risk}.ts` — generic OPEN gating (kill switch, cooldown, max positions, daily loss,
    confidence) + position sizing. CLOSE intents bypass the gate (always allow exit).
  - Ported infra: `src/lib/{logger,errors,rate-limiter,discord}`, `src/providers/solana.ts`,
    `src/providers/solenrich/{client,types}`, `src/providers/llm/provider.ts` (+ `parseLLMResponse`).
  - `src/index.ts` + `src/env.ts` — worker entry, `/health` + `/api/*` → DO.
  - `wrangler.toml`, `vitest.config.ts`, repo config.
- **Verified:** `tsc --noEmit` clean · `vitest` 22/22 passing · `wrangler deploy --dry-run` builds (744 KiB).

## Key decisions
- Reuse Pythia's hardened harness as a strategy seam (extract, not rebuild). Dropped prediction-market
  specifics (jupiter events/orders, reddit). LLM kept as a *veto*, not a predictor.
- Generic Position/TradeIntent so all strategies share policy/risk/treasury.
- Used **plain vitest** (not @cloudflare/vitest-pool-workers) to avoid Pythia's borsh/workers test issues.
- Persistence: DO storage holds AgentState incl. a capped `recentTrades` log. D1 deferred to Phase 1.
- Each swarm agent = same Worker image, different `STRATEGY` env (one DO instance per strategy: `rt-<key>`).

## Next steps (Phase 1 — copy-trade "Metis")
1. **Verify SolEnrich endpoint shape** (`/entrypoints/{key}/invoke` vs REST in client.ts) against
   `/openapi.json`; wire `smart-money-seeds`, `smart-money-flow`, `copy-trade-signals`, `rug-pull`.
   Prefer internal-free mode (`SOLENRICH_INTERNAL_KEY`).
2. `src/providers/jupiter/swap.ts` — Jupiter Ultra spot-swap client (USDC↔token) using `solana.ts`.
3. `src/strategy/copy-trade.ts` — gather (watched-wallet buys) → decide (rug veto + track-record filter +
   size) → execute (Ultra swap) → manage (mirror-exit + SL/TP + stale). Register in `registry.ts`.
4. Paper-shadow first; then small real caps. Tune wallet-selection thresholds from live output.

## Open / watch-outs
- **`/api/close-all` currently just clears state** — for LIVE capital it must liquidate on-chain first.
  Make the strategy expose a `closeAll(ctx)` before flipping `paper_trading: false`.
- Wallet-selection thresholds (hold time, min win rate/PnL) — start simple, tune live.
- Add the `X-Internal-Key` bypass to SolEnrich itself (one ~10-line change) when wiring Phase 1.
