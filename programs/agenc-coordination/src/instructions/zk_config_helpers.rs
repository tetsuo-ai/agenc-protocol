use crate::errors::CoordinationError;
use anchor_lang::prelude::*;

/// Fail closed until the repository contains an audited RISC Zero guest and the
/// trusted verifier stack is deployed and independently verified on mainnet.
///
/// Keeping this release gate in a shared helper makes initialization and rotation
/// use one explicit policy and gives tests a stable, mutation-free boundary.
pub fn reject_zk_activation() -> Result<()> {
    err!(CoordinationError::PrivateTaskCreationDisabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zk_activation_is_release_blocked_with_an_explicit_error() {
        let err = reject_zk_activation().unwrap_err();
        assert_eq!(err, CoordinationError::PrivateTaskCreationDisabled.into());
    }
}
