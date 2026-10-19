# Upgrade watchdog and custody evidence (#280)

This is a deployable monitoring candidate, not evidence that production paging
or independent custody is in place. The co-located-key residual in
`MAINNET_MAINLINE.md` and the reviewed authority policy remains open. A protocol
pause cannot constrain a replacement program authorized by the upgrade quorum.

The monitor uses read-only RPC and accepts no signer/key-file argument. It watches
the executable Program, canonical ProgramData, upgrade vault, Squads multisig,
and authority-scoped loader Buffers plus Squads Proposal, VaultTransaction and
ConfigTransaction accounts for the reviewed multisig. Any deployment slot,
allocated payload hash, upgrade-authority, custody-account or proposal change
creates an alert. Vault movements exceeding the configured cumulative threshold
also alert; the example's 0.001 SOL thresholds require operator review, not a
claim that smaller or offsetting transfers are harmless.

**Buffers do not name a target program.** The [loader Buffer state](https://docs.rs/solana-loader-v3-interface/3.0.0/src/solana_loader_v3_interface/state.rs.html)
contains an authority and bytes. Add every approved staging authority to the
watch list; the expected upgrade authority is mandatory. Squads discovery
independently alerts on all proposal/transaction changes for the multisig,
including proposals referring to buffers controlled by other authorities.
The monitor does not decode or approve transaction intent and cannot find every
unrelated buffer that could later be used in an upgrade. Its Squads namespace
follows the upstream [Proposal](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/proposal.rs),
[VaultTransaction](https://github.com/Squads-Protocol/v4/blob/main/programs/squads_multisig_program/src/state/vault_transaction.rs)
and ConfigTransaction account prefixes. Unknown proposal states alert as invalid
instead of being silently treated as approved.

## Installation and review

Use the repository's pinned Node/npm and install the independent dependencies
with `npm ci --prefix tests-integration`. Use a dedicated service user with no
access to signing keys. `ops/agenc-upgrade-watchdog.service` is an installation
template; installing it or providing a real pager endpoint requires an operator.

1. Review `scripts/watchdog-mainnet-settings.example.json` against the committed
   authority policy and current chain evidence. Include staging buffer authorities
   and approve vault thresholds. Use an RPC that supports account/program WebSocket
   subscriptions and filtered `getProgramAccounts` without truncation.
2. Set `AGENC_WATCHDOG_RPC_URL` and capture a **candidate** baseline:

   ```sh
   node scripts/upgrade-watchdog.mjs capture \
     --settings reviewed-settings.json --out candidate-baseline.json
   ```

   Capture rejects wrong genesis, missing fixed accounts or unexpected upgrade
   authority. It never overwrites an existing file. Two operators must compare
   the ProgramData slot, authority, allocated payload SHA-256/length, Program
   linkage, custody data hash, discovered proposals/buffers and vault balance
   with independently obtained approved-release evidence before installing the
   baseline. The payload hash includes allocated zero padding; it is not a
   trimmed ELF or normalized `solana-verify` hash. Capture alone approves nothing.
3. Install the reviewed baseline read-only at `/etc/agenc/watchdog-baseline.json`.
   Store the RPC URL, `AGENC_WATCHDOG_WEBHOOK_URL`, and optional
   `AGENC_WATCHDOG_WEBHOOK_TOKEN` in the protected service environment file.
   The webhook must use HTTPS (HTTP is permitted only on loopback for tests).
   It receives JSON alerts and must acknowledge only after durable acceptance
   with a 2xx response. Deduplicate by `id`/`Idempotency-Key`; delivery is
   at-least-once. Redirects are refused. No credentials appear in the baseline
   or alert body. State/outbox files require persistent storage.
4. Enable the service and an **independent** health check of
   `node scripts/check-watchdog-health.mjs /var/lib/agenc-watchdog/health.json`.
   Monitor host/process death, stale health, undelivered queue age, disk capacity
   and the pager receiver itself from outside this process. A failed pager cannot
   report its own failure through that same pager. Preserve delivered records
   according to incident-retention policy before pruning them.
5. Run the authorized devnet drill, confirm the actual on-call recipient, record
   receipts and measured latency, and only then record production deployment.

Restart compares the chain against the installed baseline, reports drift and
retries the durable outbox. It never silently re-baselines after an incident or
upgrade. Intentional upgrades require a separately reviewed replacement baseline.
WebSocket callbacks provide prompt observations; periodic HTTP reads reconcile
missed notifications and detect missing/invalid accounts. Older context slots
cannot overwrite newer observations. `--polling-only true` exists to rehearse the
fallback, and is recorded in health output.

## Detection limits and response

Confirmed subscriptions do **not** guarantee detection within one slot. Network
latency, confirmation, RPC outages and provider filtering can exceed that target.
Polling cannot reconstruct transient create/close, change/revert or net-zero
balance flows between observations. Both channels share the configured provider;
run a separately operated second instance/provider and independent liveness
monitor for stronger coverage. For a hard per-slot feed, commission a measured
validator/Geyser transaction stream rather than relabeling this RPC monitor.

An alert contains context slot, source (`websocket`/`poll`), observation time,
baseline digest, and prior/current account evidence. Triage unexpected deployment,
authority or Squads changes immediately using independent RPC and transaction
history. Balance changes and proposals are independent signals for correlation;
an absent top-up is not evidence of safety. Preserve the outbox and chain evidence,
contact independently held quorum members, and follow the incident runbook. This
daemon never pauses, signs, advances nonces, rotates authorities or deploys.

## Evidence required before closing #280

- Each of the three member keys has an independently controlled host/device and
  recovery path. Record public member key, independent custodian, device/host
  identifier, attestation date and reviewer; never record secrets or seed phrases.
  Verify separation, then update `MAINNET_MAINLINE.md` and the authority policy's
  residual statement in a reviewed operational change. No such attestation is
  asserted by this source PR.
- Record service host/version, reviewed baseline digest, provider configuration,
  external heartbeat monitor, pager routing/recipient receipt, retention and
  restart drill. No production endpoint or operator acknowledgement is fabricated.
- Record an authorized **devnet** Buffer drill and actual delivery timing. The
  automated local-validator test below is implementation evidence, not that
  operational acceptance ceremony or a sub-slot latency guarantee.

## Executable evidence

```sh
node --test scripts/upgrade-watchdog.test.mjs
AGENC_RPC_E2E=1 node --test scripts/upgrade-watchdog.rpc.test.mjs
```

The RPC test refuses non-loopback/non-owned localnet, then exercises real loader
Buffer creation/write, vault transfers, local ProgramData authority rotation and
restoration, and a same-binary local upgrade without automatic extension. A
separate watchdog process delivers to an actual local HTTP receiver. The receiver
returns 503, the daemon restarts, and the original queued alert must arrive; an
HTTP-only phase proves reconciliation. JSON evidence includes program/source
hashes, transaction signatures/metadata and received alerts. The test does not
deploy Squads: its namespace/decoder cases are covered by unit fixtures, and a
full Squads proposal and independent pager drill remains an operational gate.
