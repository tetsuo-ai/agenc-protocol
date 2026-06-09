//! Instruction handlers for AgenC Coordination Protocol
//!
//! # Module Organization
//!
//! Each instruction module exports:
//! - An accounts context struct (e.g., `ClaimTask`) with `#[derive(Accounts)]`
//! - A handler function (usually named `handler`)
//!
//! # Why Glob Re-exports?
//!
//! The `pub use module::*` pattern is intentional here. The Anchor framework's
//! `#[derive(Accounts)]` macro generates additional types (like `__client_accounts_*`)
//! that must be accessible from the crate root for the `#[program]` macro to work
//! correctly. These generated types are not part of the public API but are required
//! for Anchor's code generation.
//!
//! The `#[allow(ambiguous_glob_reexports)]` attributes suppress warnings when
//! multiple modules export items with the same name (e.g., `handler`). These
//! handlers are accessed via their module path (e.g., `claim_task::handler`)
//! rather than directly, so the ambiguity doesn't affect usage.

#[cfg(not(feature = "mainnet-canary"))]
pub mod bid_settlement_helpers;
pub mod completion_helpers;
pub mod constants;
#[cfg(not(feature = "mainnet-canary"))]
pub mod bond_helpers;
#[cfg(not(feature = "mainnet-canary"))]
pub mod dispute_helpers;
pub mod lamport_transfer;
pub mod launch_controls;
pub mod rate_limit_helpers;
pub mod slash_helpers;
pub mod task_init_helpers;
pub mod task_validation_helpers;
#[cfg(feature = "spl-token-rewards")]
pub mod token_helpers;
pub mod validation;
#[cfg(not(feature = "mainnet-canary"))]
pub mod zk_config_helpers;

pub mod accept_task_result;
#[cfg(not(feature = "mainnet-canary"))]
pub mod apply_dispute_slash;
#[cfg(not(feature = "mainnet-canary"))]
pub mod apply_initiator_slash;
#[cfg(not(feature = "mainnet-canary"))]
pub mod auto_accept_task_result;
#[cfg(not(feature = "mainnet-canary"))]
pub mod bid_marketplace;
#[cfg(not(feature = "mainnet-canary"))]
pub mod cancel_dispute;
#[cfg(not(feature = "mainnet-canary"))]
pub mod cancel_proposal;
pub mod cancel_task;
pub mod claim_task;
#[cfg(not(feature = "mainnet-canary"))]
pub mod complete_task;
#[cfg(not(feature = "mainnet-canary"))]
pub mod complete_task_private;
pub mod configure_task_moderation;
pub mod configure_task_validation;
#[cfg(not(feature = "mainnet-canary"))]
pub mod create_dependent_task;
#[cfg(not(feature = "mainnet-canary"))]
pub mod create_proposal;
pub mod create_task;
#[cfg(not(feature = "mainnet-canary"))]
pub mod create_service_listing;
#[cfg(not(feature = "mainnet-canary"))]
pub mod update_service_listing;
#[cfg(not(feature = "mainnet-canary"))]
pub mod set_service_listing_state;
#[cfg(not(feature = "mainnet-canary"))]
pub mod hire_from_listing;
#[cfg(not(feature = "mainnet-canary"))]
pub mod record_listing_moderation;
#[cfg(not(feature = "mainnet-canary"))]
pub mod create_task_humanless;
#[cfg(not(feature = "mainnet-canary"))]
pub mod close_task;
#[cfg(not(feature = "mainnet-canary"))]
pub mod post_completion_bond;
#[cfg(not(feature = "mainnet-canary"))]
pub mod delegate_reputation;
pub mod deregister_agent;
#[cfg(not(feature = "mainnet-canary"))]
pub mod execute_proposal;
pub mod expire_claim;
#[cfg(not(feature = "mainnet-canary"))]
pub mod expire_dispute;
#[cfg(not(feature = "mainnet-canary"))]
pub mod initialize_governance;
pub mod initialize_protocol;
#[cfg(not(feature = "mainnet-canary"))]
pub mod initialize_zk_config;
#[cfg(not(feature = "mainnet-canary"))]
pub mod initiate_dispute;
pub mod migrate;
#[cfg(not(feature = "mainnet-canary"))]
pub mod post_to_feed;
#[cfg(not(feature = "mainnet-canary"))]
pub mod purchase_skill;
#[cfg(not(feature = "mainnet-canary"))]
pub mod rate_skill;
pub mod record_task_moderation;
pub mod register_agent;
#[cfg(not(feature = "mainnet-canary"))]
pub mod register_skill;
pub mod reject_task_result;
#[cfg(not(feature = "mainnet-canary"))]
pub mod resolve_dispute;
#[cfg(not(feature = "mainnet-canary"))]
pub mod revoke_delegation;
pub mod set_task_job_spec;
#[cfg(not(feature = "mainnet-canary"))]
pub mod stake_reputation;
pub mod submit_task_result;
pub mod suspend_agent;
pub mod unsuspend_agent;
pub mod update_agent;
pub mod update_launch_controls;
pub mod update_multisig;
pub mod update_protocol_fee;
pub mod update_rate_limits;
#[cfg(not(feature = "mainnet-canary"))]
pub mod update_skill;
#[cfg(not(feature = "mainnet-canary"))]
pub mod update_state;
pub mod update_treasury;
#[cfg(not(feature = "mainnet-canary"))]
pub mod update_zk_image_id;
#[cfg(not(feature = "mainnet-canary"))]
pub mod upvote_post;
#[cfg(not(feature = "mainnet-canary"))]
pub mod validate_task_result;
#[cfg(not(feature = "mainnet-canary"))]
pub mod vote_dispute;
#[cfg(not(feature = "mainnet-canary"))]
pub mod vote_proposal;
#[cfg(not(feature = "mainnet-canary"))]
pub mod withdraw_reputation_stake;

// Glob re-exports are required for Anchor's #[program] macro to access generated
// types from #[derive(Accounts)]. See module documentation for details.
#[allow(ambiguous_glob_reexports)]
pub use accept_task_result::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use apply_dispute_slash::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use apply_initiator_slash::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use auto_accept_task_result::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use bid_marketplace::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use cancel_dispute::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use cancel_proposal::*;
#[allow(ambiguous_glob_reexports)]
pub use cancel_task::*;
#[allow(ambiguous_glob_reexports)]
pub use claim_task::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use complete_task::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use complete_task_private::*;
#[allow(ambiguous_glob_reexports)]
pub use configure_task_moderation::*;
#[allow(ambiguous_glob_reexports)]
pub use configure_task_validation::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use create_dependent_task::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use create_proposal::*;
pub use create_task::*;
#[cfg(not(feature = "mainnet-canary"))]
pub use create_service_listing::*;
#[cfg(not(feature = "mainnet-canary"))]
pub use update_service_listing::*;
#[cfg(not(feature = "mainnet-canary"))]
pub use set_service_listing_state::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use hire_from_listing::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use record_listing_moderation::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use create_task_humanless::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use close_task::*;
#[cfg(not(feature = "mainnet-canary"))]
pub use post_completion_bond::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use delegate_reputation::*;
#[allow(ambiguous_glob_reexports)]
pub use deregister_agent::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use execute_proposal::*;
#[allow(ambiguous_glob_reexports)]
pub use expire_claim::*;
#[cfg(not(feature = "mainnet-canary"))]
pub use expire_dispute::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use initialize_governance::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize_protocol::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use initialize_zk_config::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use initiate_dispute::*;
#[allow(ambiguous_glob_reexports)]
pub use migrate::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use post_to_feed::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use purchase_skill::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use rate_skill::*;
#[allow(ambiguous_glob_reexports)]
pub use record_task_moderation::*;
#[allow(ambiguous_glob_reexports)]
pub use register_agent::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use register_skill::*;
#[allow(ambiguous_glob_reexports)]
pub use reject_task_result::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use resolve_dispute::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use revoke_delegation::*;
#[allow(ambiguous_glob_reexports)]
pub use set_task_job_spec::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use stake_reputation::*;
#[allow(ambiguous_glob_reexports)]
pub use submit_task_result::*;
#[allow(ambiguous_glob_reexports)]
pub use suspend_agent::*;
#[allow(ambiguous_glob_reexports)]
pub use unsuspend_agent::*;
#[allow(ambiguous_glob_reexports)]
pub use update_agent::*;
#[allow(ambiguous_glob_reexports)]
pub use update_launch_controls::*;
#[allow(ambiguous_glob_reexports)]
pub use update_multisig::*;
#[allow(ambiguous_glob_reexports)]
pub use update_protocol_fee::*;
#[allow(ambiguous_glob_reexports)]
pub use update_rate_limits::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use update_skill::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use update_state::*;
#[allow(ambiguous_glob_reexports)]
pub use update_treasury::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use update_zk_image_id::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use upvote_post::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use validate_task_result::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use vote_dispute::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use vote_proposal::*;
#[cfg(not(feature = "mainnet-canary"))]
#[allow(ambiguous_glob_reexports)]
pub use withdraw_reputation_stake::*;
