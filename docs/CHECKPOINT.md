# Rogue Trader Checkpoint

## Status: Planning complete — repo scaffolded, ready for Phase 0

## What exists
- `docs/rogue-trader-scope.md` — frozen build scope for Phase 0 (thin scaffold) + Phase 1 (copy-trade agent "Metis")
- Repo config: README, .gitignore, .env.example, package.json, tsconfig.json
- Git initialized, remote set to github.com/0xSardius/rogue-trader-v1 (not yet pushed)

## Key decisions
- Swarm on the MAHORAGA pattern, reusing Pythia's hardened harness (extract a Strategy seam, don't rebuild).
- Sequence: scaffold → copy-trade #1 → funding carry #2 → sniper #3 → portfolio overlay #4.
- Copy-trade before carry: single-leg + edge survives small size vs carry's two-leg + capital-hungry.
- Small REAL capital, paper-shadow first, tight caps + live kill switch.
- LLM is a rug/sanity *veto* for copy-trade, not a predictor. Wallet is the alpha.
- SolEnrich called internal-free (X-Internal-Key bypass) so the swarm doesn't pay itself.

## Next steps (Phase 0)
1. Copy reusable Pythia modules (harness, policy/risk, lib/, solana.ts, solenrich client, llm, d1).
2. Extract `src/strategy/types.ts` Strategy interface; rewire runCycle() to drive the active strategy.
3. Drop prediction-market specifics (jupiter/events, jupiter/orders, reddit); add jupiter/swap.ts stub.
4. Green build + tests + a no-op EchoStrategy proving the seam. Commit.

## Open
- Agent name (Metis proposed). Wallet-selection thresholds. Whether to add SolEnrich bypass now.
