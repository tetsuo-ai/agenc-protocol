/** Exact disposable-local policy shared by startup and truthful status. */
export const LOCALNET_PROTOCOL_PARAMS = Object.freeze({
  disputeThreshold: 60,
  protocolFeeBps: 500,
  minStake: 1_000_000n,
  minStakeForDispute: 1_000_000n,
  multisigThreshold: 2,
});

/** Conservative production defaults used by the real bid singleton initializer. */
export const LOCALNET_BID_MARKETPLACE_PARAMS = Object.freeze({
  minBidBondLamports: 1_000_000n,
  bidCreationCooldownSecs: 60n,
  maxBidsPer24h: 50,
  maxActiveBidsPerTask: 20,
  maxBidLifetimeSecs: 604_800n,
  acceptedNoShowSlashBps: 1_000,
});
