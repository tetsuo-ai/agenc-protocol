Validation deployment executed on devnet on 2026-03-27.

Worktree: `/Users/pchmirenko/agenc-protocol-validation-v2-validation`
Branch: `codex/validation-deploy-prep`

Program ID: `GN69CoBM1XUt8MJtA6Kwd7WRwLzTNtVqLwf5o3fwWDV3`
ProgramData: `SJJa1hQZ75TX6M5qTU41ZhwyefVabkP4cNDYHSuhWRC`
Upgrade authority: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
Last deployed slot: `451407081`
Data length: `2161504`

Successful finalize signature:

`62de4LaojwqBp7WtoW7TKMg8enxRYmd5wvzFTRQnpoG4B1wMddjWRKtohGCFV3PCpSz32JdmHGdboTh7ZcGkGL1o`

Operational notes:

- A direct `anchor deploy` upload on devnet stalled during the write phase and ended with `AlreadyProcessed` / failed write transactions.
- The failed upload left a recoverable buffer:
  - buffer address: `9xdiqqs9nisdy1JXJF2fcBKRVKcVNoCw24vXCVowGjYo`
  - buffer size: `2161504`
  - buffer balance before finalize: `15.04527192 SOL`
- Deployment was completed safely by resuming from that existing buffer with:

```bash
PATH="/Users/pchmirenko/.local/share/solana/install/active_release/bin:$PATH" \
  solana program deploy \
  /Users/pchmirenko/agenc-protocol-validation-v2-validation/programs/agenc-coordination/target/deploy/agenc_coordination.so \
  --buffer 9xdiqqs9nisdy1JXJF2fcBKRVKcVNoCw24vXCVowGjYo \
  --program-id /Users/pchmirenko/.config/solana/agenc-validation/agenc_coordination-validation-keypair.json \
  --upgrade-authority /Users/pchmirenko/.config/solana/id.json \
  --url devnet \
  --use-rpc \
  --max-sign-attempts 10
```

Post-deploy verification:

- `solana program show GN69CoBM1XUt8MJtA6Kwd7WRwLzTNtVqLwf5o3fwWDV3 --url devnet` returned the expected program and authority.
- `solana program show --buffers --url devnet` returned no remaining buffers for the deploy wallet.

Execution status:

- Protocol, marketplace, and zk initialization completed successfully. See `validation-init-result.json`.
- Readiness reporting now lives at `readiness-report.json`.
- Dedicated validation deployment scenarios completed successfully for:
  - `DV-05`
  - `DV-07A`
  - `DV-07B`
  - `DV-07C`
  - `DV-08A`
  - `DV-08B`
- The remaining open item is `DV-03E`, which still needs a proof fixture or live prover aligned to this deployment's active zk image ID.

Primary follow-up artifact:

- `readiness-report.json` records the current aggregate state: `17` pass, `0` fail, `1` not-run.

Scenario run artifacts:

- `scenario-runs/DV-05/2026-03-27T15-53-36-861Z.json`
- `scenario-runs/DV-07A/2026-03-27T16-07-35-500Z.json`
- `scenario-runs/DV-07B/2026-03-27T16-07-39-050Z.json`
- `scenario-runs/DV-07C/2026-03-27T16-17-22-938Z.json`
- `scenario-runs/DV-08A/2026-03-27T16-18-21-344Z.json`
- `scenario-runs/DV-08B/2026-03-27T16-35-09-121Z.json`

Reminder for `DV-05`:

- fixture tasks must use `deadline = 0`
