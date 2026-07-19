#!/usr/bin/env bash
# =============================================================================
# mainnet-upgrade.sh — one-command wrapper for the full-surface mainnet upgrade
# =============================================================================
# Thin wrapper around the fail-closed orchestrator. Signer paths and independently
# reviewed artifact digests are supplied at runtime; this file intentionally embeds
# neither workstation paths nor a digest from a historical release.
#
# Mainnet's loader authority is currently a Squads vault. This wrapper will verify
# that live authority and REFUSE the direct `solana program deploy` step when the
# supplied ProtocolConfig signer is not the loader signer. Execute the reviewed
# binary upgrade in Squads, then use this wrapper/orchestrator for the verified
# post-deploy migration/configuration, verified IDL publication, and final stamp.
#
# This is a thin wrapper around scripts/mainnet-upgrade.mjs — it does NOT change
# any of that script's safety: PLAN broadcasts nothing; EXECUTE still makes YOU
# type the program id at the prompt before anything is sent. ZkConfig is skipped
# for now (--skip-zk-config); private completion stays dark until you set the
# audited image id later.
#
# ROLLOUT: this wrapper preserves the live task-type mask unless the operator
# explicitly exports DISABLED_TASK_TYPE_MASK. Set 0 only when the reviewed rollout
# intentionally enables every task type; the PLAN prints the exact old/new mask.
# Before either PLAN or EXECUTE, the in-program multisig must separately set
# protocol_paused=true while preserving the live mask/revision. The orchestrator
# verifies that state, repeats the cutover scans before deploy and before stamp,
# and never unpauses. Unpause later through a separate reviewed multisig action.
#
#   ./scripts/mainnet-upgrade.sh            # PLAN  (read-only, broadcasts nothing)
#   ./scripts/mainnet-upgrade.sh execute    # EXECUTE (prompts for typed program id)
#
# Set your RPC first:  export RPC_URL=https://<your-dedicated-mainnet-rpc>
# (Public api.mainnet-beta will throttle the ~170-tx migrate sweep — use a
#  dedicated endpoint: Helius / Triton / QuickNode / your own validator.)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# ---- reviewed runtime inputs ------------------------------------------------
PROTOCOL_AUTHORITY="${PROTOCOL_AUTHORITY:-}"
COSIGNERS="${COSIGNERS:-}"
SO_PATH="${SO_PATH:-$REPO/programs/agenc-coordination/target/deploy/agenc_coordination.so}"
IDL_PATH="${IDL_PATH:-$REPO/target/idl/agenc_coordination.json}"
EXPECTED_SO_SHA256="${EXPECTED_SO_SHA256:-}"
EXPECTED_IDL_SHA256="${EXPECTED_IDL_SHA256:-}"

# ---- ROLLOUT KNOB: which task types go LIVE at the surface stamp ------------
# The atomic surface stamp (stamp_release_surface) writes disabled_task_type_mask. A SET bit
# DISABLES that task type:  1=Exclusive  2=Collaborative  4=Competitive  8=BidExclusive.
#   0  = enable ALL task types (Exclusive + Collaborative + Competitive + BidExclusive) <-- rollout default
#   6  = BidExclusive + Exclusive only (disable Collaborative+Competitive)
#   14 = Exclusive only (the previous live value, everything else disabled)
# Unset/empty preserves the current live mask. Requiring an explicit environment
# value avoids accidentally enabling dormant surfaces merely by running the wrapper.
DISABLED_TASK_TYPE_MASK="${DISABLED_TASK_TYPE_MASK:-}"

# ---- BID-MARKETPLACE ECONOMICS: set EXPLICITLY (confirmed values, no silent defaults) ----
# initialize_bid_marketplace writes these; they govern bidding once it's live. Edit any value
# here to change the policy that goes on-chain. The PLAN prints all six so you confirm first.
export BID_MIN_BOND_LAMPORTS=1000000      # 0.001 SOL  — minimum bond a bidder stakes per bid
export BID_NOSHOW_SLASH_BPS=1000          # 10%        — bond fraction slashed to creator on accepted no-show
export BID_CREATION_COOLDOWN_SECS=60      # 60s        — minimum spacing between a bidder's bids (anti-spam)
export BID_MAX_PER_24H=50                 # 50         — max bids per bidder per rolling 24h
export BID_MAX_ACTIVE_PER_TASK=20         # 20         — max concurrent active bids on one task
export BID_MAX_LIFETIME_SECS=604800       # 7 days     — maximum bid time-to-expiry

# ---- the one thing only you have --------------------------------------------
RPC_URL="${RPC_URL:-}"

cd "$REPO"

# ---- guardrails (before the orchestrator even runs) -------------------------
if [ -z "$RPC_URL" ]; then
  echo "ERROR: RPC_URL is not set." >&2
  echo "  Run:  export RPC_URL=https://<your-dedicated-mainnet-rpc>" >&2
  echo "  Public mainnet RPC will throttle the migrate sweep — use a dedicated endpoint." >&2
  exit 1
fi
if [ -z "$PROTOCOL_AUTHORITY" ] || [ -z "$COSIGNERS" ]; then
  echo "ERROR: PROTOCOL_AUTHORITY and COSIGNERS must name reviewed keypair paths." >&2
  exit 1
fi
if ! [[ "$EXPECTED_SO_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || ! [[ "$EXPECTED_IDL_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: EXPECTED_SO_SHA256 and EXPECTED_IDL_SHA256 must be independently reviewed 64-hex digests." >&2
  echo "Do not compute-and-approve them inline in this wrapper; compare them to the signed release evidence." >&2
  exit 1
fi
IFS=',' read -r -a COSIGNER_PATHS <<< "$COSIGNERS"
for f in "$PROTOCOL_AUTHORITY" "${COSIGNER_PATHS[@]}" "$SO_PATH" "$IDL_PATH"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: required file is missing: $f" >&2
    [ "$f" = "$SO_PATH" ] && echo "  (rebuild it: cargo-build-sbf --manifest-path programs/agenc-coordination/Cargo.toml --sbf-out-dir programs/agenc-coordination/target/deploy)" >&2
    exit 1
  fi
done

# ---- plan (default) vs execute ----------------------------------------------
MODE="${1:-plan}"
EXTRA=()
# Forward the task-type rollout knob only when set (empty = preserve the live mask). The
# orchestrator validates 0..15 and refuses anything out of range before broadcasting.
if [ -n "${DISABLED_TASK_TYPE_MASK:-}" ]; then
  EXTRA+=(--disabled-task-type-mask "$DISABLED_TASK_TYPE_MASK")
fi
case "$MODE" in
  plan)
    echo "------------------------------------------------------------------"
    echo " PLAN MODE — validates everything, prints the plan, broadcasts NOTHING."
    echo " When the plan looks right, re-run:  $0 execute"
    echo "------------------------------------------------------------------"
    ;;
  execute)
    echo "******************************************************************"
    echo " EXECUTE MODE — this performs the IRREVERSIBLE mainnet upgrade."
    echo " The deploy opens the frozen window; the migrate sweep runs right"
    echo " after with no pause. You will be asked to type the program id."
    echo "******************************************************************"
    EXTRA+=(--execute)
    ;;
  *)
    echo "usage: $0 [plan|execute]" >&2
    exit 1
    ;;
esac

# Hand off to the safe orchestrator. It re-validates both artifact hashes, mainnet
# genesis, the live ProtocolConfig authority, loader authority, exact ProgramData
# bytes, balance, signer threshold, and live task count, then runs:
#   deploy -> migrate sweep -> init configs -> publish+verify IDL -> final stamp
# The final stamp is deliberately reasserted even when the revision value is
# already current, so an IDL-only resume cannot leave the ordering ambiguous.
exec node scripts/mainnet-upgrade.mjs \
  --rpc "$RPC_URL" \
  --protocol-authority "$PROTOCOL_AUTHORITY" \
  --cosigners "$COSIGNERS" \
  --so "$SO_PATH" \
  --idl "$IDL_PATH" \
  --expected-so-sha256 "$EXPECTED_SO_SHA256" \
  --expected-idl-sha256 "$EXPECTED_IDL_SHA256" \
  --skip-zk-config \
  "${EXTRA[@]}"
