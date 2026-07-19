//! Shared validation helpers for instruction handlers

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;

/// Validates an agent endpoint URL.
///
/// - This shared helper allows empty strings because `update_agent` may clear
///   an endpoint; `register_agent` enforces non-empty before calling it
/// - Non-empty endpoints must start with "http://" or "https://"
/// - Maximum length is 128 characters
pub fn validate_endpoint(endpoint: &str) -> Result<()> {
    // update_agent may clear an endpoint; register_agent rejects empty first.
    if endpoint.is_empty() {
        return Ok(());
    }

    // Must start with http:// or https://
    require!(
        endpoint.starts_with("http://") || endpoint.starts_with("https://"),
        CoordinationError::InvalidInput
    );

    // Length check
    require!(endpoint.len() <= 128, CoordinationError::StringTooLong);

    Ok(())
}

/// Validates that an account is owned by this program.
///
/// Use when processing `remaining_accounts` before deserialization to ensure
/// the account belongs to the AgenC program and not an attacker-controlled program.
pub fn validate_account_owner(account: &AccountInfo) -> Result<()> {
    require!(
        account.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    Ok(())
}
