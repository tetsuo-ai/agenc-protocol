// Public client-side mirrors of protocol limits that affect transaction
// construction. Keep these values aligned with the Rust constants and cover
// each mirror with a cross-source drift test.

/**
 * Maximum number of simultaneous workers admitted to a newly-created
 * collaborative or competitive task.
 *
 * Legacy task accounts can still contain a historical `maxWorkers` value up
 * to 100, but revision 5 clamps their live claim capacity to this value. New
 * public facade task builders reject values above this limit.
 */
export const DISPUTE_SAFE_MAX_WORKERS = 4 as const;
