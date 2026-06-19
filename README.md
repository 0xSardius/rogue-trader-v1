# Rogue Trader

A Solana autonomous trading **swarm** — a shared thin harness + treasury + risk overlay running a portfolio
of *uncorrelated* edges, all sighting against [SolEnrich](https://solenrich.com) as the intelligence brain.

Built on the **MAHORAGA pattern** (thin orchestrator, pluggable strategy modules), reusing the hardened
harness from Pythia (DO + D1/KV + policy engine + kill switch + loss caps + Discord).

## Swarm roadmap

| Phase | Agent | Edge | Status |
|---|---|---|---|
| 0 | Thin scaffold (strategy seam) | — | in progress |
| 1 | **Copy-trade smart money** (*Metis*) | mirror proven wallets | next |
| 2 | Delta-neutral funding carry | structural funding, market-neutral | later |
| 3 | Memecoin sniper | speed + rug filter | later |
| 4 | Portfolio overlay | treasury, cross-agent caps | later |

Each agent is the same image with a different `STRATEGY` env var and config.

## Status

Greenfield. Full build scope: [`docs/rogue-trader-scope.md`](docs/rogue-trader-scope.md).

## Stack

Cloudflare Workers + Durable Objects · D1 / KV · Solana (`@solana/web3.js`) · Jupiter Ultra (swaps) ·
SolEnrich (onchain intel) · Anthropic Claude (rug/sanity veto) · TypeScript.
