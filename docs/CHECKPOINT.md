# Rogue Trader Checkpoint

## Status: Phases 0–3 strategies + deploy-readiness done — turnkey to first income (operator deploy pending)
_Session checkpoint 2026-06-25 · tsc clean · vitest 59/59 · wrangler dry-run builds (1.57 MB / 277 KiB gzip)._

**Resume here:** the path to autonomous income is now turnkey — the only thing left before income is the
OPERATOR DEPLOY (your Cloudflare Paid account + secrets + funded wallet; can't be done headlessly).
Follow `docs/DEPLOY.md` (start with Metis): deploy paper → `GET /api/preflight` → validate SolEnrich
envelope → paper-shadow 24–48h → tiny live caps → `start`. Then: (a) repeat for Io; (b) **Phase 4 —
portfolio overlay** (shared treasury + cross-agent caps + kill-all) for running the full swarm on shared
capital; (c) devnet-validate Amalthea's perp writes.

## Deploy readiness (2026-06-25)
- **`GET /api/preflight`** — readiness gate: checks ops secrets, SolEnrich reachability, Jupiter price feed,
  and (live) wallet present + SOL balance + strategy-specific gates (e.g. Amalthea's devnet_validated).
  `ready` reflects only the REQUIRED checks for the current mode. Run before `/start` and before going live.
- **`docs/DEPLOY.md`** — turnkey runbook: per-agent `wrangler deploy --name rt-<x> --var STRATEGY:<key>`,
  secrets, preflight, a live SolEnrich-envelope validation curl, paper-shadow steps, go-live with tiny caps,
  emergency-control verification, and multi-agent deploy. Each agent = own Worker name, own DO state + wallet.

## Phase 3 — memecoin sniper "Io" (paper-complete 2026-06-22)
- Convex/lottery leg: small fixed tickets on fresh/trending tokens, hard rug-filtered, aggressive TP +
  trailing + fast time-stop. Edge = speed + filtering, not prediction.
- **Verified SolEnrich contracts:** `trending-signals` + `new-tokens` return mint/price/liquidity/risk_score/
  recommendation/holder_count (+ composite_signal & whale flow for trending) — discovery AND first veto in
  one call. Added typed `trendingSignals()`/`newTokens()` to the client.
- **Files:** `src/strategy/sniper.ts` (gather→filter→decide→execute→manage), registered `sniper`. Reuses
  Jupiter price + Ultra (same as Metis); optional second due-diligence veto; SAFE-only by default.
- **Note:** sniper agents should run with a LOW `min_confidence` (~0.4) — fresh tokens are lower-conviction
  than smart-money consensus. Position sizing is the lottery ticket; fund from realized PnL of 1 & 2.
- **Verified:** tsc clean · vitest 59/59 (10 Io tests) · wrangler dry-run builds (276 KiB gzip).

## Phase 2 — JLP delta-neutral "Amalthea" (paper-complete 2026-06-21)
- **Why not classic funding carry:** Jupiter Perps is a BORROW-fee model (both sides pay), so naked carry
  there is negative. Instead: hold JLP (fee yield), short SOL/BTC/ETH on Jupiter Perps to hedge the basket
  → keep the yield, delta-neutral. Net carry = est. JLP APR − weighted short borrow (read live) − costs.
- **Verified on-chain (from SolEnrich, not memory):** perps program `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`,
  Doves `DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e`, JLP pool `5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq`,
  JLP mint `27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4`, custodies SOL/BTC/ETH/USDC/USDT.
- **Files:** ported verified IDLs (`src/providers/jupiter/idl/`), `perps.ts` (read: markets/borrow/mark +
  JLP composition + positions, via @coral-xyz/anchor 0.29), `perps-write.ts` (open/close short — DEVNET-GATED,
  throws until validated; documents the verified ABI), `src/strategy/jlp-delta-neutral.ts` (Amalthea),
  registered `jlp-delta-neutral`. Added deps `@coral-xyz/anchor@0.29`, `@solana/spl-token`.
- **Paper-complete:** gather (net-carry gate) → decide → execute (composite JLP+shorts position) → manage
  (carry accrual, carry-collapse exit, delta-drift exit). Live OPEN refuses to half-open (shorts first; the
  gated writer throws → ok:false). `expected_jlp_apr_pct` is an operator estimate (monitor jup.ag); borrow is live.
- **Verified:** tsc clean · vitest 49/49 (9 Amalthea tests) · wrangler dry-run builds (Anchor bundles fine).

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
- **Phase 1 + close-all fix added:** copy-trade strategy, Jupiter price/ultra clients, SolEnrich rewrite,
  harness `liquidateAll`, `test/harness.test.ts`. (Current cumulative verification totals at top of file.)

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
5. Then flip `paper_trading: false` with smallest caps + funded wallet. (close-all/kill now liquidate on-chain
   — see Resolved.) Verify `/api/close-all` and `/api/kill` against the funded wallet before sizing up.

## Resolved
- **`/api/close-all` now liquidates on-chain** (was: cleared state). `harness.liquidateAll()` runs a real
  CLOSE per position through `strategy.execute` (Ultra token→USDC sell live, simulated fill paper), reuses
  applyClose for PnL/records/cooldown/notify. Positions that fail to sell are KEPT and returned in `failed`
  (HTTP 207) — never reports flat while holding. `/api/kill` halts-then-flattens the same way. Proven by
  `test/harness.test.ts` (fake DO state + injected strategy): full-close, partial-close (207), kill auth,
  kill flatten. **Live blocker cleared.**

## Open / watch-outs
- **Amalthea live perp writes are DEVNET-GATED** — perps-write.ts throws until the PDA seeds
  (position/positionRequest) + createIncreasePositionMarketRequest build are validated on devnet. Required
  before `paper_trading: false` for jlp-delta-neutral.
- **JLP composition is approximated** — weights = owned×price/AUM, ignoring trader-PnL liabilities. Refine
  the hedge ratio (true JLP delta) before live capital.
- `expected_jlp_apr_pct` is an operator estimate, not measured — set/monitor from jup.ag perps-earn.
- Anchor + IDL adds ~800 KiB to the bundle (274 KiB gzip, well under limits); confirm Anchor Program runs
  in the Workers runtime on first real deploy (SolEnrich runs it on Bun/Railway, not Workers).
- `strategy_params` thresholds — start with each strategy's DEFAULTS, tune live.
- Phase 3 (memecoin sniper) + portfolio overlay plug into the same seam next.
