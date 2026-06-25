# Rogue Trader — Deploy & Go-Live Runbook

Turnkey path from a clean repo to an autonomous agent earning (paper → live). Everything below the
"Operator prerequisites" line is push-button. **Start with Metis (copy-trade)** — single-leg, no gated
dependencies, the fastest agent to first income.

> Safety rule: every agent goes **paper → validate → tiny live caps → scale**. Never skip the paper-shadow.

---

## Operator prerequisites (one-time, needs YOUR accounts)

- **Cloudflare account on the Workers Paid plan** (Durable Objects require it). `npm i -g wrangler` then `wrangler login`.
- **Jupiter API key** — [portal.jup.ag](https://portal.jup.ag) (avoids rate limits on price/Ultra).
- **Anthropic API key** — only if a strategy uses the LLM veto (copy-trade/sniper run fine without; it's optional).
- **Solana wallet** (for live only): a base58 private key funded with a little SOL (gas) + USDC (trading), and an RPC URL (Helius/Triton/QuickNode).
- **SolEnrich internal key** (`SOLENRICH_INTERNAL_KEY`) so the swarm calls SolEnrich free (add the `X-Internal-Key` bypass to SolEnrich first — ~10 lines; otherwise calls hit x402 402s).

---

## 1. Deploy (paper mode — safe by default)

Each agent is the same Worker image with a different `STRATEGY`. Deploy one Worker per agent via `--name`:

```bash
# Copy-trade agent "Metis"
wrangler deploy --name rt-metis --var STRATEGY:copy-trade
```

`paper_trading` defaults to **true**, so this deploys a non-trading-with-real-money agent immediately.

## 2. Set secrets (per agent name)

Secrets are scoped to the Worker name, so set them against `rt-metis`:

```bash
wrangler secret put API_TOKEN --name rt-metis            # dashboard bearer auth (pick a long random string)
wrangler secret put KILL_SWITCH_SECRET --name rt-metis   # separate secret for the kill switch
wrangler secret put SOLENRICH_INTERNAL_KEY --name rt-metis
wrangler secret put JUPITER_API_KEY --name rt-metis
# Live-only (add when flipping to real money):
wrangler secret put SOLANA_RPC_URL --name rt-metis
wrangler secret put WALLET_PRIVATE_KEY --name rt-metis    # NEVER echo/log this
# Optional:
wrangler secret put ANTHROPIC_API_KEY --name rt-metis
wrangler secret put DISCORD_WEBHOOK_URL --name rt-metis   # trade/close/kill/error + cycle-error alerts
```

Set `BASE=https://rt-metis.<your-subdomain>.workers.dev` and `TOK=<your API_TOKEN>` for the curls below.

## 3. Pre-flight (readiness gate)

```bash
curl -s -H "Authorization: Bearer $TOK" $BASE/api/preflight | jq
```

`ready: true` means every REQUIRED check for the current mode passes. In paper mode it checks secrets,
SolEnrich reachability, and the price feed. **Do not start until `ready: true`.**

## 4. Validate the SolEnrich envelope (live correctness check)

Before trusting Metis's signal, confirm the live response shape matches what the client expects
(`{ output: {...} }` with the documented fields). One call:

```bash
curl -s -X POST https://api.solenrich.com/entrypoints/smart-money-flow/invoke \
  -H "X-Internal-Key: $SOLENRICH_INTERNAL_KEY" -H "content-type: application/json" \
  -d '{"input":{"format":"json","lookback_days":14}}' | jq '.output.accumulated_tokens[0]'
```

Confirm fields: `mint`, `symbol`, `smart_money_buyers`, `total_buy_volume_usd`, `avg_avg_hold_time_days`.
(Repeat for `due-diligence` → `.output.recommendation`, and for the sniper, `trending-signals` →
`.output.tokens[0]`.) If field names differ, fix `src/providers/solenrich/types.ts` before going live.

## 5. Paper-shadow (prove the loop)

```bash
curl -s -X POST -H "Authorization: Bearer $TOK" $BASE/api/run-once | jq   # force one cycle now
curl -s -H "Authorization: Bearer $TOK" $BASE/api/candidates | jq          # did SolEnrich surface candidates?
curl -s -H "Authorization: Bearer $TOK" $BASE/api/logs | jq                # gate decisions, vetoes, errors
curl -s -X POST -H "Authorization: Bearer $TOK" $BASE/api/start            # begin the autonomous loop
# ...let it run; check back:
curl -s -H "Authorization: Bearer $TOK" $BASE/api/positions | jq
curl -s -H "Authorization: Bearer $TOK" $BASE/api/history | jq
```

Run paper for **at least 24–48h**. You want to see: candidates appearing, the rug veto firing, positions
opening/closing, and simulated PnL trending sane. Tune `strategy_params` via `PUT /api/config` from output.

## 6. Go live (small caps)

```bash
# tighten caps first (start tiny — money you'd shrug off)
curl -s -X PUT -H "Authorization: Bearer $TOK" -H "content-type: application/json" \
  -d '{"max_position_usd":10,"max_positions":3,"daily_loss_limit_pct":5,"paper_trading":false}' \
  $BASE/api/config | jq

curl -s -H "Authorization: Bearer $TOK" $BASE/api/preflight | jq   # now in LIVE mode — must be ready:true
# verify wallet_sol_balance + WALLET_PRIVATE_KEY checks pass, then it's already running.
```

**Verify the emergency controls against the funded wallet before sizing up:**

```bash
curl -s -X POST -H "Authorization: Bearer $TOK" $BASE/api/close-all | jq           # liquidates on-chain (207 = partial, retry)
curl -s -X POST -H "Authorization: Bearer $TOK" -d '{"secret":"<KILL_SWITCH_SECRET>"}' $BASE/api/kill | jq
```

## 7. Operating an autonomous agent

| Action | Call |
|---|---|
| Status / PnL | `GET /api/status` |
| Open positions | `GET /api/positions` |
| Trade history | `GET /api/history` |
| Pause (keep positions) | `POST /api/stop` |
| Flatten now (on-chain) | `POST /api/close-all` |
| Emergency halt + flatten | `POST /api/kill` (body `{secret}`) |

Set `DISCORD_WEBHOOK_URL` so you get pushed trade/close/kill/error alerts and can run it unattended.

---

## Adding the other agents

Repeat steps 1–7 with a different name + strategy. Each is independent (own DO state, own wallet/caps):

```bash
wrangler deploy --name rt-io --var STRATEGY:sniper                 # then set min_confidence ~0.4
wrangler deploy --name rt-amalthea --var STRATEGY:jlp-delta-neutral # paper only — live perp writes are devnet-gated
```

- **Io (sniper):** lottery tickets — keep `max_position_usd` tiny, fund from realized PnL of Metis.
- **Amalthea (JLP delta-neutral):** runs paper end-to-end now; live trading is blocked until the Jupiter
  Perps write path is devnet-validated (see `perps-write.ts`). Keep it paper until then.

> **Phase 4 (portfolio overlay) — not built yet.** Today each agent self-limits (its own caps + kill switch).
> A shared treasury + cross-agent exposure caps + global kill-all is the next step for running the full swarm
> on shared capital. Until then, give each agent its own wallet + caps and monitor independently.
