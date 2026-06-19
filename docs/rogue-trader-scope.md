# Rogue Trader — Build Scope (Phase 0 + Phase 1)

> **What this is:** A sequential, actionable build scope for the first two phases of the `rogue-trader-v1`
> Solana trading **swarm**. Execute top-to-bottom. Architectural decisions are made — implement, don't
> re-decide. Same discipline as the Ananke `perps-signals-bot-scope.md`.
>
> **The swarm:** a shared thin harness + treasury + risk overlay running a portfolio of *uncorrelated*
> edges, all sighting against **SolEnrich** as the intelligence brain. Built on the **MAHORAGA pattern**
> (thin orchestrator, pluggable strategy modules) by reusing **Pythia's already-hardened harness** —
> Pythia is code-complete but was shelved because it bet on one thin venue (Jupiter prediction markets:
> illiquid + geo-blocked). We keep its infra, swap its strategy/venue.
>
> **Capital:** small REAL capital from day 1. Tight caps, live kill switch, short live-shadow before
> flipping `paper_trading` off.

---

## SWARM SEQUENCE (the whole roadmap, for context)

| Phase | Agent / work | Edge | Variance | Status |
|---|---|---|---|---|
| **0** | **Thin scaffold** — extract Pythia harness → strategy seam | — | — | **this scope** |
| **1** | **Copy-trade smart money** (agent #1, proposed name *Metis*) | real, if wallet selection good | medium | **this scope** |
| 2 | Delta-neutral funding carry (agent #2) | structural (funding), market-neutral | low | later |
| 3 | Memecoin sniper (agent #3) | speed + rug filter | very high (convex) | later |
| 4 | Portfolio overlay (treasury, cross-agent caps, kill-all) | — | — | matures across 1–3 |

Scaffold is **first and thin**, not a separate last phase — it grows with the agents. Carry comes *after*
copy-trade despite lower variance: it's two-leg and capital-hungry, a bad first *live* build at small size.

---

## WHY THIS ORDER (don't re-litigate)

- **Copy-trade before carry.** At small real capital, copy-trade is **single-leg** (one spot swap that
  mirrors a wallet), its **edge survives small size**, and it's **SolEnrich's actual differentiator**.
  Carry is the lowest-variance strategy but **two legs across two venues + margin/liquidation watch**, and
  the dollar funding on a few hundred USDC gets eaten by fees/gas. Fastest path to a *real, edge-bearing,
  live* agent wins for #1.
- **The Pythia lesson:** pick venues with deep liquidity + programmatic execution + a *structural* edge you
  don't have to predict your way into. Copy-trade trades liquid SPL tokens via Jupiter swap — deep, fillable,
  no geo issue from Cloudflare's edge.

---

## PHASE 0 — THIN SCAFFOLD (extract, don't rebuild)

Pythia's harness already IS the MAHORAGA pattern. The job is to lift a clean **Strategy** seam out of it so
agents plug in without touching core files.

### Keep verbatim from Pythia (`src/`)
- `durable-objects/*-harness.ts` — DO lifecycle, alarm scheduling, `runCycle()`, dashboard API, kill switch
- `policy/engine.ts` + `policy/risk.ts` — kill switch, cooldown, daily-loss cap, position/exposure caps, sizing
- `lib/` — `logger.ts`, `errors.ts`, `rate-limiter.ts`, `discord.ts`
- `providers/jupiter/solana.ts` — Solana signing/submit (REUSED AS-IS)
- `providers/solenrich/client.ts` + `types.ts` — already has `copyTradeSignals(address)`, `whaleWatch(mint)`,
  `enrichToken`, `enrichWallet`. Extend with the keys in the endpoint map below.
- `providers/llm/provider.ts` — LLM client (role changes; see Phase 1)
- `storage/d1.ts` — trades/positions/research tables (reuse; rename columns only if needed)

### Replace / drop (Pythia's prediction-market specifics)
- `providers/jupiter/events.ts` (prediction markets) → **drop**; signals now come from SolEnrich.
- `providers/jupiter/orders.ts` (prediction-market orderbook orders) → **replace** with a **Jupiter Swap
  (Ultra) client** for spot SPL swaps (`providers/jupiter/swap.ts`).
- `providers/reddit/*` → drop for copy-trade (no sentiment leg in v1).

### Extract the Strategy seam
Define one interface the harness drives; each agent implements it. Core never changes per-agent.

```ts
// src/strategy/types.ts
export interface Strategy<Candidate, Decision> {
  key: string;                                   // "copy-trade" | "funding-carry" | ...
  gather(ctx: Ctx): Promise<Candidate[]>;        // pull candidates (SolEnrich-driven)
  decide(c: Candidate, ctx: Ctx): Promise<Decision | null>;  // filter/size; null = pass
  execute(d: Decision, ctx: Ctx): Promise<void>; // place trade (paper or live)
  manage(ctx: Ctx): Promise<void>;               // exits: SL/TP/mirror/stale
}
```

`runCycle()` becomes: `gather → manage → decide(each) → execute(each)` against the **active strategy**, with
the policy/risk gate sitting between `decide` and `execute` (unchanged from Pythia). The DO is selected by a
`STRATEGY` env var so each agent is the same image with a different config.

### Phase 0 cut line
**IN:** strategy interface extracted; Pythia core compiles green under it; one no-op `EchoStrategy` proves the
seam; tests still pass; new repo config (package.json/tsconfig/wrangler/.gitignore/.env.example).
**OUT:** any actual trading logic (that's Phase 1).

---

## PHASE 1 — COPY-TRADE AGENT ("Metis")

> **Name:** *Metis* — Jupiter's innermost moon + Greek goddess of cunning counsel; apt for "follow the smart
> wallets." **OPEN — user to confirm** (cf. Ananke locked for the perps bot). Naming follows Jupiter moons /
> fate-time deities.

**Thesis:** the **wallet is the alpha**, not the LLM. This inverts MAHORAGA's LLM-centric design — the LLM is
a **rug/sanity veto**, never a price predictor. Cheaper, faster, and where the real edge is.

### V1 CUT LINE

**IN:**
- Watchlist of proven wallets, seeded from SolEnrich `smart-money-seeds` (+ manual seed list).
- Per-cycle: detect qualifying buys by watched wallets → rug/sanity filter → size → spot-buy via Jupiter Ultra.
- Exit logic: **mirror source exit** (wallet sells → we sell) + SL/TP + stale-position timeout (belt & braces).
- Mandatory rug filter (`rug-pull` / `token-analysis`) — hard veto, no override.
- Real capital, tight caps (see risk overlay), live kill switch, Discord notifications.
- Paper-shadow mode first (Pythia's `paper_trading: true`), flip to live after N clean cycles.

**OUT (later):**
- LLM deep-research (copy-trade doesn't need it; veto-only in v1).
- Dynamic wallet discovery/scoring loop (start with seed + simple track-record filter).
- Multi-wallet consensus weighting, position pyramiding, partial exits.
- Funding carry / sniper (Phases 2–3).

### SIGNAL → ENDPOINT MAP

All SolEnrich calls via the existing client. **Internal-free mode** (`X-Internal-Key` bypass) so the swarm
doesn't pay itself circular x402 fees — same bypass decided for Ananke; add once to SolEnrich, whole swarm
benefits. Verify exact response field names against `/openapi.json` per the global API rule.

| Need | Endpoint (key) | Input | Use |
|---|---|---|---|
| Seed wallet list | `smart-money-seeds` | `{}` / filters | bootstrap the watchlist |
| What smart money is buying | `smart-money-flow` | `{ window }` | cross-check / discover candidates |
| Per-wallet signals | `copy-trade-signals` | `{ address }` | the core buy/sell trigger per watched wallet |
| Wallet track record | (wallet enrichment) | `{ address }` | selection filter (hold time, win rate, PnL) |
| Rug / token safety | `rug-pull` / `token-analysis` | `{ mint }` | **mandatory hard veto** before any buy |
| Whale corroboration | `whale-flow` / `whale-watch` | `{ mint }` | optional confirm (not required v1) |

### EXECUTION

- **Venue:** Jupiter **Ultra/Swap** API → unsigned `VersionedTransaction` → sign with `solana.ts` (reused) →
  submit + confirm. Single-leg: USDC → token on entry, token → USDC on exit.
- **Honest latency caveat:** the wallet's tx is already on-chain when SolEnrich surfaces it, so we are *always*
  behind. **Selection mitigates this:** favor wallets that **accumulate/hold** (median hold time > threshold)
  over scalpers — we can't win the speed race, only the patience one.

### RISK OVERLAY (real capital, day 1 — reuse Pythia policy/risk)
- `max_position_usd` small (start tiny), `max_positions` low, `max_per_token_usd` cap.
- `daily_loss_limit_pct` hard kill, `cooldown_minutes` between entries.
- Mandatory rug veto (cannot be disabled).
- Kill switch live; `close-all` tested before going live.
- Wallet key in env, never logged; `.env` / `.dev.vars` gitignored before first commit (global secret rule).

### BUILD SEQUENCE
1. **Phase 0** — extract strategy seam; green build + tests; EchoStrategy proves it. Commit.
2. **Day 1** — Jupiter Ultra swap client (`swap.ts`) + reuse `solana.ts`; dry-run a USDC→token→USDC round trip
   on devnet/sim. Extend SolEnrich client with `smartMoneySeeds`, `smartMoneyFlow`, rug check. Commit.
3. **Day 2** — `CopyTradeStrategy`: gather (watched-wallet buys) → decide (rug veto + track-record filter +
   size) → execute → manage (mirror-exit + SL/TP + stale). Wire policy/risk gate. Paper-shadow mode. Commit.
4. **Day 3** — Discord notifications, dashboard endpoints, live-shadow run, tune thresholds; flip
   `paper_trading: false` with smallest caps once shadow is clean. Commit per the modular-feature rule.

---

## DECISIONS

**Confirmed:**
- Reuse Pythia's hardened harness (MAHORAGA pattern); extract a Strategy seam rather than rebuild.
- Copy-trade is agent #1 (single-leg, edge at small size). Carry #2, sniper #3, overlay #4.
- LLM is a veto, not a predictor, for copy-trade.
- Internal-free SolEnrich calls for the swarm.
- Small real capital, paper-shadow first, tight caps + live kill switch.
- Runtime stays Cloudflare Workers + DO + D1/KV (inherited from Pythia).

**Open (resolve during build, not blocking):**
- Agent name (*Metis* proposed).
- Exact wallet-selection thresholds (hold time, min win rate / PnL) — start simple, tune from live output.
- Whether to add the SolEnrich `X-Internal-Key` bypass now (recommended) or pay x402 to start.
- Exit policy default weighting (mirror-exit vs SL/TP) — start with mirror-exit primary, SL/TP as backstop.
