# Error Catalog

> **GENERATED FILE — do not edit by hand.**
> Source of truth: `artifacts/anchor/idl/agenc_coordination.json`.
> Regenerate with `npm run docs:idl-reference`;
> `npm run check:idl-reference` (part of `npm run validate` and CI) fails when this file drifts from the IDL.

Program: `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (`agenc_coordination` v0.1.0).

**362 error codes**, sorted by code. Anchor custom errors start at 6000 (0x1770).

| Code | Hex | Name | Message |
|---|---|---|---|
| 6000 | 0x1770 | `AgentAlreadyRegistered` | Agent is already registered |
| 6001 | 0x1771 | `AgentNotFound` | Agent not found |
| 6002 | 0x1772 | `AgentNotActive` | Agent is not active |
| 6003 | 0x1773 | `InsufficientCapabilities` | Agent has insufficient capabilities |
| 6004 | 0x1774 | `InvalidCapabilities` | Agent capabilities bitmask cannot be zero |
| 6005 | 0x1775 | `MaxActiveTasksReached` | Agent has reached maximum active tasks |
| 6006 | 0x1776 | `AgentHasActiveTasks` | Agent has active tasks and cannot be deregistered |
| 6007 | 0x1777 | `UnauthorizedAgent` | Only the agent authority can perform this action |
| 6008 | 0x1778 | `CreatorAuthorityMismatch` | Creator must match authority to prevent social engineering |
| 6009 | 0x1779 | `InvalidAgentId` | Invalid agent ID: agent_id cannot be all zeros |
| 6010 | 0x177a | `AgentRegistrationRequired` | Agent registration required to create tasks |
| 6011 | 0x177b | `AgentSuspended` | Agent is suspended and cannot change status |
| 6012 | 0x177c | `AgentBusyWithTasks` | Agent cannot set status to Active while having active tasks |
| 6013 | 0x177d | `TaskNotFound` | Task not found |
| 6014 | 0x177e | `TaskNotOpen` | Task is not open for claims |
| 6015 | 0x177f | `TaskFullyClaimed` | Task has reached maximum workers |
| 6016 | 0x1780 | `TaskExpired` | Task has expired |
| 6017 | 0x1781 | `TaskNotExpired` | Task deadline has not passed |
| 6018 | 0x1782 | `DeadlinePassed` | Task deadline has passed |
| 6019 | 0x1783 | `TaskNotInProgress` | Task is not in progress |
| 6020 | 0x1784 | `TaskAlreadyCompleted` | Task is already completed |
| 6021 | 0x1785 | `TaskCannotBeCancelled` | Task cannot be cancelled |
| 6022 | 0x1786 | `UnauthorizedTaskAction` | Only the task creator can perform this action |
| 6023 | 0x1787 | `InvalidCreator` | Invalid creator |
| 6024 | 0x1788 | `InvalidTaskId` | Invalid task ID: cannot be zero |
| 6025 | 0x1789 | `InvalidDescription` | Invalid description: cannot be empty |
| 6026 | 0x178a | `InvalidMaxWorkers` | Invalid max workers: must be between 1 and 100 |
| 6027 | 0x178b | `InvalidTaskType` | Invalid task type |
| 6028 | 0x178c | `TaskNotBidExclusive` | Task is not a Marketplace V2 bid-exclusive task |
| 6029 | 0x178d | `BidExclusiveRequiresSingleWorker` | Bid-exclusive tasks must use max_workers = 1 |
| 6030 | 0x178e | `BidTaskSolOnly` | Marketplace V2 bid tasks are SOL-only in v2 |
| 6031 | 0x178f | `BidTaskRequiresAcceptance` | Bid-exclusive tasks require bid acceptance and cannot be claimed directly |
| 6032 | 0x1790 | `BidBookNotOpen` | Bid book is not open |
| 6033 | 0x1791 | `BidBookNotAccepted` | Bid book is not in accepted state |
| 6034 | 0x1792 | `BidSettlementAccountsRequired` | Bid settlement accounts are required |
| 6035 | 0x1793 | `BidPriceExceedsTaskBudget` | Bid price exceeds task budget |
| 6036 | 0x1794 | `InvalidBidExpiry` | Bid expiry is invalid |
| 6037 | 0x1795 | `InvalidBidEta` | Bid ETA must be greater than zero |
| 6038 | 0x1796 | `InvalidBidConfidence` | Bid confidence must be between 0 and 10000 basis points |
| 6039 | 0x1797 | `InvalidMatchingPolicy` | Invalid matching policy |
| 6040 | 0x1798 | `InvalidWeightedScoreWeights` | Weighted score weights must sum to 10000 basis points |
| 6041 | 0x1799 | `BidNotActive` | Bid is not active |
| 6042 | 0x179a | `BidAlreadyAccepted` | Bid has already been accepted |
| 6043 | 0x179b | `BidNotExpired` | Bid has not expired and bid book is not closed |
| 6044 | 0x179c | `BidBookCapacityReached` | Bid book has reached its active bid capacity |
| 6045 | 0x179d | `InvalidDeadline` | Invalid deadline: deadline must be greater than zero |
| 6046 | 0x179e | `InvalidReward` | Invalid reward: reward must be greater than zero |
| 6047 | 0x179f | `InvalidRequiredCapabilities` | Invalid required capabilities: required_capabilities cannot be zero |
| 6048 | 0x17a0 | `CompetitiveTaskAlreadyWon` | Competitive task already completed by another worker |
| 6049 | 0x17a1 | `NoWorkers` | Task has no workers |
| 6050 | 0x17a2 | `ConstraintHashMismatch` | Proof constraint hash does not match task's stored constraint hash |
| 6051 | 0x17a3 | `NotPrivateTask` | Task is not a private task (no constraint hash set) |
| 6052 | 0x17a4 | `AlreadyClaimed` | Worker has already claimed this task |
| 6053 | 0x17a5 | `NotClaimed` | Worker has not claimed this task |
| 6054 | 0x17a6 | `ClaimAlreadyCompleted` | Claim has already been completed |
| 6055 | 0x17a7 | `ClaimNotExpired` | Claim has not expired yet |
| 6056 | 0x17a8 | `ClaimExpired` | Claim has expired |
| 6057 | 0x17a9 | `InvalidExpiration` | Invalid expiration: expires_at cannot be zero |
| 6058 | 0x17aa | `InvalidProof` | Invalid proof of work |
| 6059 | 0x17ab | `ZkVerificationFailed` | ZK proof verification failed |
| 6060 | 0x17ac | `InvalidSealEncoding` | Invalid RISC0 seal encoding |
| 6061 | 0x17ad | `InvalidJournalLength` | Invalid RISC0 journal length |
| 6062 | 0x17ae | `InvalidJournalBinding` | Invalid RISC0 journal binding |
| 6063 | 0x17af | `InvalidJournalTask` | RISC0 journal task binding mismatch |
| 6064 | 0x17b0 | `InvalidJournalAuthority` | RISC0 journal authority binding mismatch |
| 6065 | 0x17b1 | `InvalidImageId` | Invalid RISC0 image ID |
| 6066 | 0x17b2 | `TrustedSelectorMismatch` | RISC0 seal selector does not match trusted selector |
| 6067 | 0x17b3 | `TrustedVerifierProgramMismatch` | RISC0 verifier program does not match trusted verifier |
| 6068 | 0x17b4 | `RouterAccountMismatch` | RISC0 router account constraints failed |
| 6069 | 0x17b5 | `InvalidProofSize` | Invalid proof size - expected 256 bytes for RISC Zero seal body |
| 6070 | 0x17b6 | `InvalidProofBinding` | Invalid proof binding: expected_binding cannot be all zeros |
| 6071 | 0x17b7 | `InvalidOutputCommitment` | Invalid output commitment: output_commitment cannot be all zeros |
| 6072 | 0x17b8 | `InvalidRentRecipient` | Invalid rent recipient: must be worker authority |
| 6073 | 0x17b9 | `GracePeriodNotPassed` | Grace period not passed: only worker authority can expire claim within 60 seconds of expiry |
| 6074 | 0x17ba | `InvalidProofHash` | Invalid proof hash: proof_hash cannot be all zeros |
| 6075 | 0x17bb | `InvalidResultData` | Invalid result data: result_data cannot be all zeros when provided |
| 6076 | 0x17bc | `ValidationModeUnsupportedTaskType` | Task Validation V2 is only supported for exclusive task flows |
| 6077 | 0x17bd | `InvalidValidationMode` | Invalid validation mode |
| 6078 | 0x17be | `InvalidReviewWindow` | Invalid review window |
| 6079 | 0x17bf | `TaskValidationConfigRequired` | Task validation configuration required |
| 6080 | 0x17c0 | `TaskValidationAlreadyConfigured` | Task already has validation configured |
| 6081 | 0x17c1 | `TaskValidationImmutableAfterClaim` | Task validation cannot be reconfigured once work has started |
| 6082 | 0x17c2 | `TaskSubmissionRequired` | Task submission is required |
| 6083 | 0x17c3 | `TaskAttestorConfigRequired` | Task attestor configuration is required |
| 6084 | 0x17c4 | `SubmissionAlreadyPending` | Task submission already pending review |
| 6085 | 0x17c5 | `SubmissionNotPending` | Task submission is not pending review |
| 6086 | 0x17c6 | `SubmissionAlreadyResolved` | Task submission has already been resolved |
| 6087 | 0x17c7 | `TaskNotPendingValidation` | Task is not pending validation |
| 6088 | 0x17c8 | `ManualValidationRequiresReviewFlow` | Task uses creator-review validation and must submit through Task Validation V2 |
| 6089 | 0x17c9 | `ManualValidationPrivateTaskUnsupported` | Creator-review validation is not supported for private tasks yet |
| 6090 | 0x17ca | `ValidationModeMismatch` | Validation instruction does not match the task's configured validation mode |
| 6091 | 0x17cb | `InvalidValidatorQuorum` | Validator quorum must be greater than zero |
| 6092 | 0x17cc | `InvalidAttestor` | External attestor must be a valid non-default wallet |
| 6093 | 0x17cd | `ReviewWindowNotElapsed` | Review window has not elapsed yet |
| 6094 | 0x17ce | `ValidationAlreadyRecorded` | Validation for this submission round has already been recorded |
| 6095 | 0x17cf | `ValidatorAgentRequired` | Validator agent account is required for validator-quorum mode |
| 6096 | 0x17d0 | `UnauthorizedTaskValidator` | Reviewer is not authorized to validate this task result |
| 6097 | 0x17d1 | `DisputeNotActive` | Dispute is not active |
| 6098 | 0x17d2 | `VotingEnded` | Voting period has ended |
| 6099 | 0x17d3 | `VotingNotEnded` | Voting period has not ended |
| 6100 | 0x17d4 | `AlreadyVoted` | Already voted on this dispute |
| 6101 | 0x17d5 | `NotArbiter` | Not authorized to vote (not an arbiter) |
| 6102 | 0x17d6 | `InsufficientVotes` | Insufficient votes to resolve |
| 6103 | 0x17d7 | `DisputeAlreadyResolved` | Dispute has already been resolved |
| 6104 | 0x17d8 | `UnauthorizedResolver` | Only the protocol authority or an assigned dispute resolver can resolve disputes, and never the dispute initiator |
| 6105 | 0x17d9 | `InvalidDisputeResolver` | Invalid dispute resolver: pubkey must be non-zero |
| 6106 | 0x17da | `ActiveDisputeVotes` | Agent has active dispute votes pending resolution |
| 6107 | 0x17db | `RecentVoteActivity` | Agent must wait 24 hours after voting before deregistering |
| 6108 | 0x17dc | `AuthorityAlreadyVoted` | Authority has already voted on this dispute |
| 6109 | 0x17dd | `InsufficientEvidence` | Insufficient dispute evidence provided |
| 6110 | 0x17de | `EvidenceTooLong` | Dispute evidence exceeds maximum allowed length |
| 6111 | 0x17df | `DisputeNotExpired` | Dispute has not expired |
| 6112 | 0x17e0 | `SlashAlreadyApplied` | Dispute slashing already applied |
| 6113 | 0x17e1 | `SlashWindowExpired` | Slash window expired: must apply slashing within 7 days of resolution |
| 6114 | 0x17e2 | `DisputeNotResolved` | Dispute has not been resolved |
| 6115 | 0x17e3 | `NotTaskParticipant` | Only task creator or workers can initiate disputes |
| 6116 | 0x17e4 | `InvalidEvidenceHash` | Invalid evidence hash: cannot be all zeros |
| 6117 | 0x17e5 | `ArbiterIsDisputeParticipant` | Arbiter cannot vote on disputes they are a participant in |
| 6118 | 0x17e6 | `InsufficientQuorum` | Insufficient quorum: minimum number of voters not reached |
| 6119 | 0x17e7 | `ActiveDisputesExist` | Agent has active disputes as defendant and cannot deregister |
| 6120 | 0x17e8 | `TooManyDisputeVoters` | Dispute has reached maximum voter capacity |
| 6121 | 0x17e9 | `WorkerAgentRequired` | Worker agent account required when creator initiates dispute |
| 6122 | 0x17ea | `WorkerClaimRequired` | Worker claim account required when creator initiates dispute |
| 6123 | 0x17eb | `WorkerNotInDispute` | Worker was not involved in this dispute |
| 6124 | 0x17ec | `InitiatorCannotResolve` | Dispute initiator cannot resolve their own dispute |
| 6125 | 0x17ed | `VersionMismatch` | State version mismatch (concurrent modification) |
| 6126 | 0x17ee | `StateKeyExists` | State key already exists |
| 6127 | 0x17ef | `StateNotFound` | State not found |
| 6128 | 0x17f0 | `InvalidStateValue` | Invalid state value: state_value cannot be all zeros |
| 6129 | 0x17f1 | `StateOwnershipViolation` | State ownership violation: only the creator agent can update this state |
| 6130 | 0x17f2 | `InvalidStateKey` | Invalid state key: state_key cannot be all zeros |
| 6131 | 0x17f3 | `ProtocolAlreadyInitialized` | Protocol is already initialized |
| 6132 | 0x17f4 | `ProtocolNotInitialized` | Protocol is not initialized |
| 6133 | 0x17f5 | `InvalidProtocolFee` | Invalid protocol fee (must be <= 1000 bps) |
| 6134 | 0x17f6 | `InvalidTreasury` | Invalid treasury: treasury account cannot be default pubkey |
| 6135 | 0x17f7 | `InvalidDisputeThreshold` | Invalid dispute threshold: must be 1-100 (percentage of votes required) |
| 6136 | 0x17f8 | `InsufficientStake` | Insufficient stake for arbiter registration |
| 6137 | 0x17f9 | `MultisigInvalidThreshold` | Invalid multisig threshold |
| 6138 | 0x17fa | `MultisigInvalidSigners` | Invalid multisig signer configuration |
| 6139 | 0x17fb | `MultisigNotEnoughSigners` | Not enough multisig signers |
| 6140 | 0x17fc | `MultisigDuplicateSigner` | Duplicate multisig signer provided |
| 6141 | 0x17fd | `MultisigDefaultSigner` | Multisig signer cannot be default pubkey |
| 6142 | 0x17fe | `MultisigSignerNotSystemOwned` | Multisig signer account not owned by System Program |
| 6143 | 0x17ff | `InvalidInput` | Invalid input parameter |
| 6144 | 0x1800 | `ArithmeticOverflow` | Arithmetic overflow |
| 6145 | 0x1801 | `VoteOverflow` | Vote count overflow |
| 6146 | 0x1802 | `InsufficientFunds` | Insufficient funds |
| 6147 | 0x1803 | `RewardTooSmall` | Reward too small: worker must receive at least 1 lamport |
| 6148 | 0x1804 | `CorruptedData` | Account data is corrupted |
| 6149 | 0x1805 | `StringTooLong` | String too long |
| 6150 | 0x1806 | `InvalidAccountOwner` | Account owner validation failed: account not owned by this program |
| 6151 | 0x1807 | `RateLimitExceeded` | Rate limit exceeded: maximum actions per 24h window reached |
| 6152 | 0x1808 | `CooldownNotElapsed` | Cooldown period has not elapsed since last action |
| 6153 | 0x1809 | `UpdateTooFrequent` | Agent update too frequent: must wait cooldown period |
| 6154 | 0x180a | `InvalidCooldown` | Cooldown value cannot be negative |
| 6155 | 0x180b | `CooldownTooLarge` | Cooldown value exceeds maximum (24 hours) |
| 6156 | 0x180c | `RateLimitTooHigh` | Rate limit value exceeds maximum allowed (1000) |
| 6157 | 0x180d | `CooldownTooLong` | Cooldown value exceeds maximum allowed (1 week) |
| 6158 | 0x180e | `InsufficientStakeForDispute` | Insufficient stake to initiate dispute |
| 6159 | 0x180f | `InsufficientStakeForCreatorDispute` | Creator-initiated disputes require 2x the minimum stake |
| 6160 | 0x1810 | `VersionMismatchProtocol` | Protocol version mismatch: account version incompatible with current program |
| 6161 | 0x1811 | `AccountVersionTooOld` | Account version too old: migration required |
| 6162 | 0x1812 | `AccountVersionTooNew` | Account version too new: program upgrade required |
| 6163 | 0x1813 | `InvalidMigrationSource` | Migration not allowed: invalid source version |
| 6164 | 0x1814 | `InvalidMigrationTarget` | Migration not allowed: invalid target version |
| 6165 | 0x1815 | `UnauthorizedUpgrade` | Only upgrade authority can perform this action |
| 6166 | 0x1816 | `UnauthorizedProtocolAuthority` | Only protocol authority can perform this action |
| 6167 | 0x1817 | `InvalidMinVersion` | Minimum version cannot exceed current protocol version |
| 6168 | 0x1818 | `ProtocolConfigRequired` | Protocol config account required: suspending an agent requires the protocol config PDA in remaining_accounts |
| 6169 | 0x1819 | `ParentTaskCancelled` | Parent task has been cancelled |
| 6170 | 0x181a | `ParentTaskDisputed` | Parent task is in disputed state |
| 6171 | 0x181b | `InvalidDependencyType` | Invalid dependency type |
| 6172 | 0x181c | `ParentTaskNotCompleted` | Parent task must be completed before completing a proof-dependent task |
| 6173 | 0x181d | `ParentTaskAccountRequired` | Parent task account required for proof-dependent task completion |
| 6174 | 0x181e | `UnauthorizedCreator` | Parent task does not belong to the same creator |
| 6175 | 0x181f | `NullifierAlreadySpent` | Nullifier has already been spent - proof/knowledge reuse detected |
| 6176 | 0x1820 | `InvalidNullifier` | Invalid nullifier: nullifier value cannot be all zeros |
| 6177 | 0x1821 | `IncompleteWorkerAccounts` | All worker accounts must be provided when cancelling a task with active claims |
| 6178 | 0x1822 | `WorkerAccountsRequired` | Worker accounts required when task has active workers |
| 6179 | 0x1823 | `DuplicateArbiter` | Duplicate arbiter provided in remaining_accounts |
| 6180 | 0x1824 | `InsufficientEscrowBalance` | Escrow has insufficient balance for reward transfer |
| 6181 | 0x1825 | `InvalidStatusTransition` | Invalid task status transition |
| 6182 | 0x1826 | `StakeTooLow` | Stake value is below minimum required (0.001 SOL) |
| 6183 | 0x1827 | `InvalidMinStake` | min_stake_for_dispute must be greater than zero |
| 6184 | 0x1828 | `InvalidSlashAmount` | Slash amount must be greater than zero |
| 6185 | 0x1829 | `BondAmountTooLow` | Bond amount too low |
| 6186 | 0x182a | `BondAlreadyExists` | Bond already exists |
| 6187 | 0x182b | `BondNotFound` | Bond not found |
| 6188 | 0x182c | `BondNotMatured` | Bond not yet matured |
| 6189 | 0x182d | `InsufficientReputation` | Agent reputation below task minimum requirement |
| 6190 | 0x182e | `InvalidMinReputation` | Invalid minimum reputation: must be <= 10000 |
| 6191 | 0x182f | `DevelopmentKeyNotAllowed` | Development verifying key detected (gamma == delta). ZK proofs are forgeable. Run MPC ceremony before use. |
| 6192 | 0x1830 | `SelfTaskNotAllowed` | Cannot claim own task: worker authority matches task creator |
| 6193 | 0x1831 | `MissingTokenAccounts` | Token accounts not provided for token-denominated task |
| 6194 | 0x1832 | `InvalidTokenEscrow` | Token escrow ATA does not match expected derivation |
| 6195 | 0x1833 | `InvalidTokenMint` | Provided mint does not match task's reward_mint |
| 6196 | 0x1834 | `TokenTransferFailed` | SPL token transfer CPI failed |
| 6197 | 0x1835 | `ProposalNotActive` | Proposal is not active |
| 6198 | 0x1836 | `ProposalVotingNotEnded` | Voting period has not ended |
| 6199 | 0x1837 | `ProposalVotingEnded` | Voting period has ended |
| 6200 | 0x1838 | `ProposalAlreadyExecuted` | Proposal has already been executed |
| 6201 | 0x1839 | `ProposalInsufficientQuorum` | Insufficient quorum for proposal execution |
| 6202 | 0x183a | `ProposalNotApproved` | Proposal did not achieve majority |
| 6203 | 0x183b | `ProposalUnauthorizedCancel` | Only the proposer can cancel this proposal |
| 6204 | 0x183c | `ProposalInsufficientStake` | Insufficient stake to create a proposal |
| 6205 | 0x183d | `InvalidProposalPayload` | Invalid proposal payload |
| 6206 | 0x183e | `InvalidProposalType` | Invalid proposal type |
| 6207 | 0x183f | `TreasuryInsufficientBalance` | Treasury spend amount exceeds available balance |
| 6208 | 0x1840 | `TimelockNotElapsed` | Execution timelock has not elapsed |
| 6209 | 0x1841 | `InvalidGovernanceParam` | Invalid governance configuration parameter |
| 6210 | 0x1842 | `TreasuryNotProgramOwned` | Treasury must be a program-owned PDA |
| 6211 | 0x1843 | `TreasuryNotSpendable` | Treasury must be program-owned, or a signer system account for governance spends |
| 6212 | 0x1844 | `SkillInvalidId` | Skill ID cannot be all zeros |
| 6213 | 0x1845 | `SkillInvalidName` | Skill name cannot be all zeros |
| 6214 | 0x1846 | `SkillInvalidContentHash` | Skill content hash cannot be all zeros |
| 6215 | 0x1847 | `SkillNotActive` | Skill is not active |
| 6216 | 0x1848 | `SkillInvalidRating` | Rating must be between 1 and 5 |
| 6217 | 0x1849 | `SkillSelfRating` | Cannot rate own skill |
| 6218 | 0x184a | `SkillUnauthorizedUpdate` | Only the skill author can update this skill |
| 6219 | 0x184b | `SkillSelfPurchase` | Cannot purchase own skill |
| 6220 | 0x184c | `FeedInvalidContentHash` | Feed content hash cannot be all zeros |
| 6221 | 0x184d | `FeedInvalidTopic` | Feed topic cannot be all zeros |
| 6222 | 0x184e | `FeedPostNotFound` | Feed post not found |
| 6223 | 0x184f | `FeedSelfUpvote` | Cannot upvote own post |
| 6224 | 0x1850 | `ReputationStakeAmountTooLow` | Reputation stake amount must be greater than zero |
| 6225 | 0x1851 | `ReputationStakeLocked` | Reputation stake is locked: withdrawal before cooldown |
| 6226 | 0x1852 | `ReputationStakeInsufficientBalance` | Reputation stake has insufficient balance for withdrawal |
| 6227 | 0x1853 | `ReputationDelegationAmountInvalid` | Reputation delegation amount invalid: must be > 0, <= 10000, and >= MIN_DELEGATION_AMOUNT |
| 6228 | 0x1854 | `ReputationCannotDelegateSelf` | Cannot delegate reputation to self |
| 6229 | 0x1855 | `ReputationDelegationExpired` | Reputation delegation has expired |
| 6230 | 0x1856 | `ReputationAgentNotActive` | Agent must be Active to participate in reputation economy |
| 6231 | 0x1857 | `ReputationDisputesPending` | Agent has pending disputes as defendant: cannot withdraw stake |
| 6232 | 0x1858 | `PrivateTaskRequiresZkProof` | Private tasks (non-zero constraint_hash) must use complete_task_private |
| 6233 | 0x1859 | `InvalidTokenAccountOwner` | Token account owner does not match expected authority |
| 6234 | 0x185a | `InsufficientSeedEntropy` | Binding or nullifier seed has insufficient byte diversity (min 8 distinct bytes required) |
| 6235 | 0x185b | `SkillPriceBelowMinimum` | Skill price below minimum required |
| 6236 | 0x185c | `SkillPriceChanged` | Skill price changed since transaction was prepared |
| 6237 | 0x185d | `DelegationCooldownNotElapsed` | Delegation must be active for minimum duration before revocation |
| 6238 | 0x185e | `RateLimitBelowMinimum` | Rate limit value below protocol minimum |
| 6239 | 0x185f | `InvalidTaskJobSpecHash` | Invalid task job specification hash |
| 6240 | 0x1860 | `InvalidTaskJobSpecUri` | Invalid task job specification URI |
| 6241 | 0x1861 | `TaskJobSpecTaskMismatch` | Task job specification account does not belong to this task |
| 6242 | 0x1862 | `ProtocolPaused` | Protocol is paused by multisig launch controls |
| 6243 | 0x1863 | `TaskTypeDisabled` | Task type is disabled by multisig launch controls |
| 6244 | 0x1864 | `TaskModerationRequired` | Task moderation is not configured or enabled |
| 6245 | 0x1865 | `InvalidTaskModerationAuthority` | Invalid task moderation authority |
| 6246 | 0x1866 | `UnauthorizedTaskModerator` | Only the configured moderation authority can record moderation decisions |
| 6247 | 0x1867 | `InvalidTaskModerationStatus` | Invalid task moderation status |
| 6248 | 0x1868 | `InvalidTaskModerationRiskScore` | Invalid task moderation risk score |
| 6249 | 0x1869 | `TaskModerationTaskMismatch` | Task moderation account does not belong to this task |
| 6250 | 0x186a | `TaskModerationHashMismatch` | Task moderation account does not match this job specification hash |
| 6251 | 0x186b | `TaskModerationExpired` | Task moderation decision is expired |
| 6252 | 0x186c | `TaskModerationRejected` | Task moderation decision does not allow publishing this job specification |
| 6253 | 0x186d | `TaskJobSpecRequired` | Task claim requires a moderated job specification pointer |
| 6254 | 0x186e | `ListingInvalidId` | Service listing ID cannot be all zeros |
| 6255 | 0x186f | `ListingInvalidName` | Service listing name cannot be all zeros |
| 6256 | 0x1870 | `ListingInvalidSpec` | Service listing spec hash/URI is invalid |
| 6257 | 0x1871 | `ListingPriceTooLow` | Service listing price is below the minimum |
| 6258 | 0x1872 | `ListingCapabilitiesRequired` | Service listing must declare at least one required capability |
| 6259 | 0x1873 | `ListingOperatorFeeTooHigh` | Operator fee exceeds the maximum allowed |
| 6260 | 0x1874 | `ListingOperatorRequired` | A non-zero operator fee requires an operator payee |
| 6261 | 0x1875 | `ListingNotActive` | Service listing is not active |
| 6262 | 0x1876 | `ListingRetired` | Service listing is retired and cannot be modified |
| 6263 | 0x1877 | `ListingVersionMismatch` | Service listing version does not match the expected version |
| 6264 | 0x1878 | `ListingPriceMismatch` | Service listing price does not match the expected price |
| 6265 | 0x1879 | `ListingCapacityReached` | Service listing has reached its maximum concurrent open hires |
| 6266 | 0x187a | `ListingInvalidStateTransition` | Invalid service listing state transition |
| 6267 | 0x187b | `TaskNotClosable` | Task can only be closed once it is in a terminal state with no active workers |
| 6268 | 0x187c | `WorkerRewardBelowFloor` | Worker reward would fall below the protocol-mandated floor |
| 6269 | 0x187d | `InvalidHireRecord` | Supplied hire record does not match this task |
| 6270 | 0x187e | `MissingOperatorAccount` | Operator payee account is required for this hire's operator fee |
| 6271 | 0x187f | `InvalidOperatorAccount` | Operator payee account does not match the hire record operator |
| 6272 | 0x1880 | `HiredTaskValidationUnsupported` | A hired task cannot be reconfigured for manual validation; it settles on the hire completion path |
| 6273 | 0x1881 | `OperatorIsCreator` | Operator payee cannot be the task creator (operator self-deal) |
| 6274 | 0x1882 | `TaskNotMigratable` | Task account is not a migratable size (expected the pre-Batch-2 layout) |
| 6275 | 0x1883 | `TaskDiscriminatorMismatch` | Task account discriminator does not match the Task type |
| 6276 | 0x1884 | `BondTaskMismatch` | Completion bond does not belong to this task |
| 6277 | 0x1885 | `BondPartyMismatch` | Completion bond party does not match the expected wallet |
| 6278 | 0x1886 | `BondRoleMismatch` | Completion bond has the wrong role for this disposition |
| 6279 | 0x1887 | `BondAlreadyPosted` | A completion bond has already been posted for this party and task |
| 6280 | 0x1888 | `MissingCompletionBondAccount` | A required completion bond account was not provided |
| 6281 | 0x1889 | `BondUnsupportedTaskType` | Completion bonds are single-worker (Exclusive) only in v1 |
| 6282 | 0x188a | `MaxRevisionRoundsExceeded` | Maximum revision rounds exceeded; escalate to reject |
| 6283 | 0x188b | `TaskNotRejectFrozen` | Task is not in the RejectFrozen state |
| 6284 | 0x188c | `RejectFrozenTimeoutNotElapsed` | RejectFrozen review timeout has not elapsed |
| 6285 | 0x188d | `UnauthorizedReviewDecision` | Caller is not authorized to make this review decision |
| 6286 | 0x188e | `TaskFrozenCannotDispute` | A frozen (rejected) task cannot be disputed |
| 6287 | 0x188f | `RejectFrozenSingleWorkerOnly` | RejectFrozen review is single-worker (Exclusive) only |
| 6288 | 0x1890 | `InvalidRatingScore` | Rating score must be in the range 1..=5 |
| 6289 | 0x1891 | `TaskNotCompletedForRating` | Only a completed hired task can be rated |
| 6290 | 0x1892 | `RatingNotBuyer` | Only the buyer (task creator) may rate this hire |
| 6291 | 0x1893 | `ReviewUriTooLong` | Review URI exceeds the maximum allowed length |
| 6292 | 0x1894 | `InvalidModerationAttestor` | Invalid moderation attestor: pubkey must be non-zero |
| 6293 | 0x1895 | `UnauthorizedModerationAttestor` | Signer is neither the moderation authority nor a registered attestor |
| 6294 | 0x1896 | `ModerationAttestorMismatch` | Supplied moderation attestor entry does not match the signing moderator |
| 6295 | 0x1897 | `RationaleUriTooLong` | Dispute ruling rationale URI exceeds the maximum allowed length |
| 6296 | 0x1898 | `ConfigNotMigratable` | ProtocolConfig account is not a migratable size (expected the pre-P6.5 layout) |
| 6297 | 0x1899 | `InvalidPda` | Account is not the canonical PDA for this instruction |
| 6298 | 0x189a | `InvalidSurfaceRevision` | Surface revision value is not a recognized surface |
| 6299 | 0x189b | `ReferrerFeeTooHigh` | Referrer fee in basis points exceeds the maximum allowed |
| 6300 | 0x189c | `CombinedFeeAboveCap` | Combined protocol + operator + referrer fees leave the worker below the floor |
| 6301 | 0x189d | `MissingReferrerAccount` | Referrer payee account is missing for a task that carries a referrer fee |
| 6302 | 0x189e | `InvalidReferrerAccount` | Referrer payee account does not match the snapshotted referrer |
| 6303 | 0x189f | `ReferrerIsCreator` | Referrer must not be the task creator (no self-deal) |
| 6304 | 0x18a0 | `InvalidVerifiedDomain` | Verified domain is empty, too long, or not a valid DNS name |
| 6305 | 0x18a1 | `InvalidAgentVerificationMethod` | Unknown agent-verification method (expected TxtRecord or WellKnown) |
| 6306 | 0x18a2 | `ReputationStakeNotWithdrawn` | Reputation stake must be fully withdrawn before the agent can be deregistered |
| 6307 | 0x18a3 | `ProviderAgentNotActive` | Provider agent must be Active for this listing operation |
| 6308 | 0x18a4 | `TaskHasLiveCompletionBond` | Task has a live completion bond; reclaim it before closing the task |
| 6309 | 0x18a5 | `AttestorBondMissing` | Attestor PDA is missing the registration bond after deposit |
| 6310 | 0x18a6 | `AttestorExitNotRequested` | Attestor exit has not been requested (exit_at is zero) |
| 6311 | 0x18a7 | `AttestorExitAlreadyRequested` | Attestor exit already requested; the exit clock cannot be reset |
| 6312 | 0x18a8 | `AttestorExitCooldownActive` | Attestor exit cooldown has not elapsed |
| 6313 | 0x18a9 | `AttestorExiting` | Attestor is in its exit window and can no longer moderate or unlock gates |
| 6314 | 0x18aa | `UnauthorizedAttestorRevocation` | Only the wallet that created a roster entry may revoke it |
| 6315 | 0x18ab | `AttestorNotSelfRegistered` | Only a self-registered (bonded) attestor may exit; deputized entries are removed via revoke |
| 6316 | 0x18ac | `ContentBlocked` | Content hash is blocked by the multisig takedown floor |
| 6317 | 0x18ad | `InvalidModerationBlockAccount` | Moderation block account is not the canonical PDA for this content hash |
| 6318 | 0x18ae | `InvalidModerationRationale` | Block rationale hash and URI are required (non-zero, non-empty, bounded) |
| 6319 | 0x18af | `InvalidTrustList` | Trust list hash and URI are required (non-zero, non-empty, bounded) |
| 6320 | 0x18b0 | `InvalidModerationRecord` | Moderation record account is not the canonical PDA, not program-owned, or not a moderation record |
| 6321 | 0x18b1 | `InvalidStoreHandle` | Store handle must be 3-20 chars of lowercase [a-z0-9-], starting alphanumeric, zero-padded |
| 6322 | 0x18b2 | `InvalidStoreMetadataUri` | Store metadata URI exceeds the maximum length |
| 6323 | 0x18b3 | `InvalidStoreDomain` | Store domain is not a valid DNS name |
| 6324 | 0x18b4 | `InvalidStoreOperatorTerms` | Store operator fee requires a non-default operator payee (and vice versa) |
| 6325 | 0x18b5 | `StoreBondMissing` | Store PDA is missing the registration bond after deposit |
| 6326 | 0x18b6 | `UnauthorizedModerationHeartbeat` | Only the moderation config authority or the moderation authority may heartbeat |
| 6327 | 0x18b7 | `InvalidModerationLivenessWindow` | Moderation liveness window is outside the allowed [1 day, 400 day] range |
| 6328 | 0x18b8 | `InvalidStoreManifest` | Store manifest hash and URI must be pinned together (both set or both empty) |
| 6329 | 0x18b9 | `ContestSolRewardOnly` | Contest (schema-1 Competitive) tasks must use SOL rewards |
| 6330 | 0x18ba | `ContestSelectionWindowElapsed` | Selection window has closed; the contest settles via distribute_ghost_share |
| 6331 | 0x18bb | `ContestAcceptRequiresSoleLiveSubmission` | Reject every other live submission before accepting a contest winner |
| 6332 | 0x18bc | `ContestAutoAcceptDisabled` | Auto-accept is disabled for contest tasks; accept before ghost_at or crank distribute_ghost_share after |
| 6333 | 0x18bd | `ContestGhostWindowNotReached` | Ghost-split is not open yet; the creator's selection window is still active |
| 6334 | 0x18be | `ContestGhostShareUnavailable` | distribute_ghost_share requires a schema-1 Competitive task pending validation |
| 6335 | 0x18bf | `ContestHasLiveSubmissions` | Contest tasks cannot be cancelled while live submissions exist |
| 6336 | 0x18c0 | `ContestFlowUnsupported` | Dispute/freeze/revision flows are disabled for contest tasks |
| 6337 | 0x18c1 | `SubmissionRentAccountsRequired` | Straggler submission rent requires its worker agent + worker authority accounts (never paid to the creator) |
| 6338 | 0x18c2 | `ContestForfeitTreasuryRequired` | Contest no-show forfeit requires the protocol treasury account |
| 6339 | 0x18c3 | `ClaimReclaimRequiresTerminalTask` | reclaim_terminal_claim requires a terminal (Completed/Cancelled) task |
| 6340 | 0x18c4 | `ClaimReclaimRequiresNoSubmission` | reclaim_terminal_claim requires a provably-absent submission PDA (no live submission for this claim) |
| 6341 | 0x18c5 | `GoodsSurfaceNotEnabled` | Goods market requires surface revision 4 to be stamped (update_launch_controls) |
| 6342 | 0x18c6 | `GoodsInvalidId` | Good id must be non-zero |
| 6343 | 0x18c7 | `GoodsInvalidName` | Good name must be non-zero |
| 6344 | 0x18c8 | `GoodsInvalidMetadata` | Good metadata hash and URI must both be set (hash non-zero, URI non-empty, URI <= 256 bytes) |
| 6345 | 0x18c9 | `GoodsPriceBelowMinimum` | Good price is below the minimum |
| 6346 | 0x18ca | `GoodsInvalidSupply` | Good supply must be positive (create: total_supply > 0; restock: additional_supply > 0) |
| 6347 | 0x18cb | `GoodsSoldOut` | Good is sold out |
| 6348 | 0x18cc | `GoodsNotActive` | Goods listing is not active |
| 6349 | 0x18cd | `GoodsPriceChanged` | Good price changed since preview; re-read the listing and retry |
| 6350 | 0x18ce | `GoodsSerialStale` | Stale sale serial: another purchase landed first; re-read sold_count and retry |
| 6351 | 0x18cf | `GoodsSelfPurchase` | A seller cannot purchase their own good |
| 6352 | 0x18d0 | `GoodsUnauthorizedUpdate` | Only the seller can update a goods listing |
| 6353 | 0x18d1 | `GoodsInvalidOperatorTerms` | Operator and operator_fee_bps must be set together, and the operator may not be the seller |
| 6354 | 0x18d2 | `ResolverConflictOfInterest` | A dispute party (the task creator or the defendant worker) cannot resolve their own dispute |
| 6355 | 0x18d3 | `CompletingAcceptRequiresSoleLiveSubmission` | An accept that completes the task requires it to be the sole live submission (peer submissions would otherwise be orphaned) |
| 6356 | 0x18d4 | `BondNotTiedToNoShowWorker` | A forfeited worker completion bond must belong to a live no-show claimant of this task |
| 6357 | 0x18d5 | `ClaimSlashPending` | This claim's dispute was resolved but its slash has not been applied yet |
| 6358 | 0x18d6 | `RejectFrozenSolOnly` | Reject-and-freeze is SOL-only in v1 (the frozen exits cannot settle a token escrow) |
| 6359 | 0x18d7 | `ReputationDelegationWhileDefendant` | An agent with active disputes as defendant cannot delegate reputation |
| 6360 | 0x18d8 | `ReputationDelegationIdentityMismatch` | The delegator agent is not the same registration that created this delegation |
| 6361 | 0x18d9 | `AgentHasActiveBids` | An agent with live bids cannot deregister (their withdrawal paths load this registration) |
