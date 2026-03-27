# Validation Deployment Ready

Generated: 2026-03-27

## Status Update

This pre-deploy checkpoint is complete.

- Deployment was executed later on `2026-03-27`.
- Protocol, marketplace, and zk initialization were completed on the dedicated validation program.
- The current aggregate status now lives in `readiness-report.json`.
- The current deployment execution record lives in `VALIDATION_DEPLOYMENT_EXECUTED_20260327.md`.

## Isolated Worktree

- Worktree: `/Users/pchmirenko/agenc-protocol-validation-v2-validation`
- Branch: `codex/validation-deploy-prep`

## Dedicated Validation Program

- Program ID: `GN69CoBM1XUt8MJtA6Kwd7WRwLzTNtVqLwf5o3fwWDV3`
- Program keypair: `/Users/pchmirenko/.config/solana/agenc-validation/agenc_coordination-validation-keypair.json`

## Verified In This Worktree

- `declare_id!` matches the validation program ID
- `Anchor.toml` localnet and devnet entries match the validation program ID
- generated package IDL address matches the validation program ID
- harness config `programId` matches the validation program ID
- validation timing feature test passes
- validation deployment preflight passes

## Commands Already Run

```bash
PATH="/Users/pchmirenko/.local/share/solana/install/active_release/bin:$PATH" \
  anchor build -- --features validation-timings

PATH="/Users/pchmirenko/.local/share/solana/install/active_release/bin:$PATH" \
  npm run artifacts:refresh

npm run devnet:validation:preflight -- \
  --program-keypair /Users/pchmirenko/.config/solana/agenc-validation/agenc_coordination-validation-keypair.json
```

## Deploy Command Used

```bash
PATH="/Users/pchmirenko/.local/share/solana/install/active_release/bin:$PATH" \
  anchor deploy -p agenc_coordination --provider.cluster devnet \
  --program-keypair /Users/pchmirenko/.config/solana/agenc-validation/agenc_coordination-validation-keypair.json
```

This command path is no longer pending. Keep it here as the recorded pre-deploy checkpoint.

## Post-Deploy Outcome

1. Protocol initialization completed with the validation-spec values.
2. Marketplace configuration initialization completed on the dedicated validation program.
3. ZK configuration initialization completed for the validation image ID.
4. Marketplace V2 readiness scenarios were executed against this dedicated program.
5. Aggregate results are now tracked in `readiness-report.json`.
