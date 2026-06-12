#!/usr/bin/env bash
# =============================================================================
# mainnet-upgrade.sh — one-command wrapper for the full-surface mainnet upgrade
# =============================================================================
# Pre-fills every known, verified value so the ONLY things you decide are:
#   (1) your RPC endpoint, and (2) plan vs execute.
#
# This is a thin wrapper around scripts/mainnet-upgrade.mjs — it does NOT change
# any of that script's safety: PLAN broadcasts nothing; EXECUTE still makes YOU
# type the program id at the prompt before anything is sent. ZkConfig is skipped
# for now (--skip-zk-config); private completion stays dark until you set the
# audited image id later.
#
# ROLLOUT: this wrapper ENABLES ALL task types at the surface stamp via
# DISABLED_TASK_TYPE_MASK=0 (the bid marketplace + collaborative + competitive go
# live alongside exclusive). Edit that one variable below to change the live set;
# the PLAN prints "mask 14 -> 0 (ALL task types ENABLED)" and the bid economics so
# you can confirm before executing.
#
#   ./scripts/mainnet-upgrade.sh            # PLAN  (read-only, broadcasts nothing)
#   ./scripts/mainnet-upgrade.sh execute    # EXECUTE (prompts for typed program id)
#
# Set your RPC first:  export RPC_URL=https://<your-dedicated-mainnet-rpc>
# (Public api.mainnet-beta will throttle the ~170-tx migrate sweep — use a
#  dedicated endpoint: Helius / Triton / QuickNode / your own validator.)
# =============================================================================
set -euo pipefail

REPO="/home/tetsuo/git/AgenC/agenc-protocol"
BACKUP="/home/tetsuo/agenc-mainnet-restore/mainnet/sensitive-index"

# ---- pre-filled, verified values --------------------------------------------
UPGRADE_AUTHORITY="$BACKUP/upgrade-authority.json"          # Hcecp… (loader auth + multisig owner[0])
COSIGNERS="$BACKUP/multisig-second.json"                    # owner[1]; with the authority = 2-of-3
SO_PATH="$REPO/programs/agenc-coordination/target/deploy/agenc_coordination.so"  # sha ea2fa9…, 84-ix surface
IDL_PATH="$REPO/target/idl/agenc_coordination.json"        # full 84-instruction IDL
# (any 2 of upgrade-authority.json / multisig-second.json / multisig-third.json
#  satisfy the 2-of-3 — swap COSIGNERS if you'd rather sign with the third key.)

# ---- ROLLOUT KNOB: which task types go LIVE at the surface stamp ------------
# The surface stamp (update_launch_controls) writes disabled_task_type_mask. A SET bit
# DISABLES that task type:  1=Exclusive  2=Collaborative  4=Competitive  8=BidExclusive.
#   0  = enable ALL task types (Exclusive + Collaborative + Competitive + BidExclusive) <-- rollout default
#   6  = BidExclusive + Exclusive only (disable Collaborative+Competitive)
#   14 = Exclusive only (the previous live value, everything else disabled)
# Edit this one number to change which task types are live. (Leave EMPTY to PRESERVE the
# current live mask untouched instead of overriding it.)
DISABLED_TASK_TYPE_MASK="0"

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
for f in "$UPGRADE_AUTHORITY" "$COSIGNERS" "$SO_PATH" "$IDL_PATH"; do
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

# Hand off to the safe orchestrator. It re-validates .so sha, authority pubkey,
# balance, the 2-of-3 cosigner set, and the live task count, then runs:
#   deploy -> migrate sweep -> init configs -> stamp surface_revision -> publish IDL
exec node scripts/mainnet-upgrade.mjs \
  --rpc "$RPC_URL" \
  --upgrade-authority "$UPGRADE_AUTHORITY" \
  --cosigners "$COSIGNERS" \
  --so "$SO_PATH" \
  --idl "$IDL_PATH" \
  --skip-zk-config \
  "${EXTRA[@]}"
