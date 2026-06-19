# Rogue Trader Checkpoint

## Status: Phase 1 complete (copy-trade "Metis") — ready for paper-shadow run, then small live caps

## Phase 1 — copy-trade "Metis" (DONE 2026-06-19)
- **Verified SolEnrich contracts first** (API rule): endpoints are `POST /entrypoints/{key}/invoke`
  with `{input}`, response `{output: data}` (format:"json"). Rewrote the client off the old guessed
  REST paths. Used keys: `smart-money-flow`, `copy-trade-signals`, `due-diligence`.
- **Design refinement from the real API:** signal source is `smart-money-flow.accumulated_tokens`
  (tokens N+ proven wallets are accumulating) — a consensus signal, cleaner than per-wallet mirroring.
  Mirror-exit = token leaves the accumulation set. The wallet is the alpha; due-diligence is the rug VETO.
- **Files:** `src/strategy/copy-trade.ts` (gather→decide→manage→execute), `src/providers/jupiter/price.ts`
  (Price v3, fail-closed), `src/providers/jupiter/ultra.ts` (Ultra order→sign→execute), `signOnly()` on
  SolanaClient, SolEnrich client+types rewrite. Registered `copy-trade` in registry.
- **Safety:** mandatory rug veto (RISKY always blocked; CAUTION blocked unless allow_caution); fail-closed
  on missing due-diligence or unreliable price; consensus + hold-time filters favor accumulators not scalpers.
- **Verified:** tsc clean · vitest 40/40 · wrangler dry-run builds (761 KiB).

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

## Next steps (paper-shadow → live)
1. Deploy with `STRATEGY=copy-trade`, `paper_trading: true`; set secrets (JUPITER_API_KEY,
   SOLENRICH_INTERNAL_KEY, ANTHROPIC_API_KEY, API_TOKEN, KILL_SWITCH_SECRET). Run `POST /api/run-once`
   then `/api/start`; watch `/api/candidates`, `/api/positions`, `/api/history`, `/api/logs`.
2. Confirm against LIVE SolEnrich that `{output}` envelope + field names match (esp. `accumulated_tokens`).
3. Add the `X-Internal-Key` bypass to SolEnrich itself (~10 lines) so the swarm calls it free.
4. Tune `strategy_params` (min_smart_money_buyers, min_hold_time_days, TP/SL, max_hold_hours) from output.
5. Then flip `paper_trading: false` with smallest caps + funded wallet. **First fix close-all (below).**

## Resolved
- **`/api/close-all` now liquidates on-chain** (was: cleared state). `harness.liquidateAll()` runs a real
  CLOSE per position through `strategy.execute` (Ultra token→USDC sell live, simulated fill paper), reuses
  applyClose for PnL/records/cooldown/notify. Positions that fail to sell are KEPT and returned in `failed`
  (HTTP 207) — never reports flat while holding. `/api/kill` halts-then-flattens the same way. Proven by
  `test/harness.test.ts` (fake DO state + injected strategy): full-close, partial-close (207), kill auth,
  kill flatten. **Live blocker cleared.**

## Open / watch-outs
- **Jupiter Ultra is flagged superseded by Swap V2** — fine for paper + small size; revisit before scaling.
- `strategy_params` thresholds — start with copy-trade.ts DEFAULTS, tune live.
- Confirm `{output}` envelope + `accumulated_tokens` field names against LIVE SolEnrich before live caps.
- Phase 2 (funding carry) + Phase 3 (sniper) plug into the same seam next.
