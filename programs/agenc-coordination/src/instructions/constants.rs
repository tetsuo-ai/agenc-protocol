//! Shared constants for instruction handlers

/// Divisor for basis points calculations (100% = 10000 bps)
pub const BASIS_POINTS_DIVISOR: u64 = 10000;

/// Maximum protocol fee in basis points (20% = 2000 bps)
pub const MAX_PROTOCOL_FEE_BPS: u16 = 2000;

/// Maximum operator (embedding-site) fee in basis points (20% = 2000 bps).
/// Carried on a ServiceListing in Batch 1; enforced at settlement in Batch 2.
pub const MAX_OPERATOR_FEE_BPS: u16 = 2000;

/// Maximum referrer (demand-side embedder) fee in basis points (20% = 2000 bps),
/// per-leg ceiling for the P6.2 4-way split. The COMBINED cap below is the binding
/// money-safety invariant; this is a per-leg sanity bound (defense in depth).
pub const MAX_REFERRER_FEE_BPS: u16 = 2000;

/// Maximum COMBINED protocol + operator + referrer fee in basis points
/// (40% = 4000 bps) for the P6.2 4-way split. Enforced at settlement
/// (`calculate_combined_fees`) so the worker ALWAYS keeps ≥ `WORKER_FLOOR_BPS`
/// (60%). This is the binding invariant — `4000 + WORKER_FLOOR_BPS == 10000`.
pub const MAX_COMBINED_FEE_BPS: u16 = 4000;

/// Minimum share of a settlement the worker must always keep (60% = 6000 bps),
/// per spec §4. With protocol ≤20% (MAX_PROTOCOL_FEE_BPS) + operator ≤20%
/// (MAX_OPERATOR_FEE_BPS), the worker is left exactly ≥60% at the caps, so this
/// floor is the *binding* invariant at maximum fees — enforced + tested at
/// settlement (`calculate_combined_fees`), not merely emergent.
pub const WORKER_FLOOR_BPS: u16 = 6000;

/// Base for percentage calculations (100 = 100%)
pub const PERCENT_BASE: u64 = 100;

/// Maximum valid percentage value
pub const MAX_PERCENT: u8 = 100;

/// Reputation points awarded per successful task completion
pub const REPUTATION_PER_COMPLETION: u16 = 100;

/// Maximum reputation an agent can accumulate
pub const MAX_REPUTATION: u16 = 10000;

/// 24-hour window in seconds (86400)
pub const WINDOW_24H: i64 = 86400;

// ============================================================================
// Reputation System Constants
// ============================================================================

/// Minimum possible reputation score
pub const MIN_REPUTATION: u16 = 0;

/// Reputation points lost when losing a dispute (worker or initiator)
pub const REPUTATION_SLASH_LOSS: u16 = 300;

/// Reputation points decayed per inactive period
pub const REPUTATION_DECAY_RATE: u16 = 50;

/// Duration of one decay period in seconds (30 days)
pub const REPUTATION_DECAY_PERIOD: i64 = 2_592_000;

/// Minimum reputation score after decay (floor)
pub const REPUTATION_DECAY_MIN: u16 = 1000;

// ============================================================================
// Dispute Resolution Constants
// ============================================================================

/// Minimum number of voters required for dispute resolution
pub const MIN_VOTERS_FOR_RESOLUTION: usize = 3;

/// DEPRECATED (P6.3): the arbiter vote/quorum model is retired — `vote_dispute` no
/// longer exists, so a dispute never records a voter and resolve/expire no longer take
/// `(vote, arbiter)` pairs. This cap is unreferenced; retained only for API stability.
pub const MAX_DISPUTE_VOTERS: u8 = 20;

// ============================================================================
// Reputation Economy Constants
// ============================================================================

/// Cooldown period before staked SOL can be withdrawn (7 days in seconds)
pub const REPUTATION_STAKING_COOLDOWN: i64 = 604_800;

/// Minimum delegation amount in reputation points (1% of max reputation)
pub const MIN_DELEGATION_AMOUNT: u16 = 100;

/// Minimum skill price in lamports to prevent free sybil rating attacks (~$0.0002)
pub const MIN_SKILL_PRICE: u64 = 1_000;

/// Minimum duration a delegation must be active before revocation (7 days in seconds)
pub const MIN_DELEGATION_DURATION: i64 = 604_800;

// ============================================================================
// P1.2 Open-Roster Constants
// ============================================================================

/// Registration bond for permissionless attestor self-registration (0.25 SOL),
/// deposited as excess lamports on the `["moderation_attestor", attestor]` PDA and
/// refunded IN FULL at `finalize_attestor_exit`. HARDCODED, not a config field, so
/// nobody can quietly reprice registration to exclude rivals — changing it is a
/// visible multisig'd upgrade. This is an attributable-identity deposit that caps
/// concurrent identities per unit of working capital; it is NOT a quality bond, NOT
/// slashable, and NOT a sybil rate-limit (edge trust lists are the sybil defense).
pub const REGISTRATION_BOND_LAMPORTS: u64 = 250_000_000;

/// Cooldown between `request_attestor_exit` and `finalize_attestor_exit` (7 days).
/// The exit window closes at REQUEST: an exiting attestor is rejected at the record
/// and consumption gates immediately, so there is no scam-then-exit window.
pub const ATTESTOR_EXIT_COOLDOWN: i64 = 604_800;

// ============================================================================
// P1.3 Moderation Liveness Constants (batch-2 A2 — docs/MODERATION_LIVENESS.md)
// ============================================================================

/// Default moderation liveness window: 90 days of authority silence
/// (no `configure_task_moderation` / `moderation_heartbeat`) relaxes the
/// consumption gates to moderation-optional. Used when the config's carved
/// `liveness_window_secs` is 0 (the live mainnet config's zeroed reserve).
pub const DEFAULT_MODERATION_LIVENESS_WINDOW_SECS: u32 = 7_776_000;

/// Floor for a configured moderation liveness window (1 day). Purely a foot-gun
/// guard: a sub-day window could make the gate effectively always-relaxed by
/// accident. It is NOT a trust boundary — the protocol authority can already
/// disable moderation openly.
pub const MIN_MODERATION_LIVENESS_WINDOW_SECS: u32 = 86_400;

/// Ceiling for a configured moderation liveness window (400 days). Symmetric
/// foot-gun guard on the SAFETY-critical direction: without it a units typo
/// (e.g. seconds-vs-millis, an accidental multiply) could push the deadman so
/// far out that a lost authority key never relaxes the gate within any practical
/// horizon — defeating the exact failure the deadman exists to prevent. Like the
/// floor, this is NOT a trust boundary.
pub const MAX_MODERATION_LIVENESS_WINDOW_SECS: u32 = 34_560_000;

// ============================================================================
// P5.2 Store Identity Constants (batch-2 — docs/P5_2_STORE_IDENTITY_SPEC.md)
// ============================================================================

/// Registration bond for permissionless store registration (0.05 SOL), deposited
/// as excess lamports on the `["store", owner]` PDA and refunded IN FULL at
/// `close_store`. Smaller than the attestor roster's 0.25 SOL because a Store
/// gates no consumption path — the bond only prices gPA-namespace spam (spec §8
/// Q1, ratified). HARDCODED for the same no-repricing-rivals reason as the roster
/// bond: changing it is a visible multisig'd upgrade, never a config dial.
pub const STORE_REGISTRATION_BOND_LAMPORTS: u64 = 50_000_000;

// ============================================================================
// Default Rate Limit Constants
// ============================================================================

/// Maximum deadline relative to current time (1 year in seconds)
pub const MAX_DEADLINE_SECONDS: i64 = 31_536_000;

/// Batch 3 WS-CONTEST: the creator's post-deadline selection window (48h). A
/// schema-1 `Competitive` task's `ghost_at = deadline + SELECTION_WINDOW_SECS`;
/// before it only the creator may settle (accept/reject), at/after it the
/// permissionless `distribute_ghost_share` crank takes over — an airtight
/// temporal partition, so the judge and the crank can never interleave.
pub const SELECTION_WINDOW_SECS: i64 = 172_800;

/// Batch 3 WS-CONTEST fix round: refundable anti-slop contest entry deposit
/// (0.01 SOL), carried as SURPLUS LAMPORTS on the contest claim PDA (no
/// `TaskClaim` layout change). Charged only when claiming a contest-CONFIGURED
/// task (schema-1 Competitive + CreatorReview). Refunded in full on every exit
/// where the worker SUBMITTED (accept / reject / ghost-split close the claim
/// with ALL its lamports to the worker — losers lose nothing). FORFEITED to the
/// protocol treasury (never the creator) on no-show exits: `expire_claim` with a
/// provably-absent submission PDA, and `reclaim_terminal_claim`. Rationale:
/// claim rent alone was a free slot-squat DoS (fully refundable even to
/// no-shows); the deposit prices squatting while keeping honest entry net-free.
pub const CONTEST_ENTRY_DEPOSIT_LAMPORTS: u64 = 10_000_000;

/// Default cooldown between task creations in seconds
pub const DEFAULT_TASK_CREATION_COOLDOWN: i64 = 60;

/// Default maximum tasks per agent per 24-hour window
pub const DEFAULT_MAX_TASKS_PER_24H: u8 = 50;

/// Default cooldown between dispute initiations in seconds (5 minutes)
pub const DEFAULT_DISPUTE_INITIATION_COOLDOWN: i64 = 300;

/// Default maximum disputes per agent per 24-hour window
pub const DEFAULT_MAX_DISPUTES_PER_24H: u8 = 10;
