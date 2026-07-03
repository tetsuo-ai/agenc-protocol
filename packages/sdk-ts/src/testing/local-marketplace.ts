// NODE-ONLY (see ./index.ts module doc): startLocalMarketplace — boot the real
// compiled agenc-coordination program in litesvm with the config singletons
// pre-seeded, and hand back ready-to-use marketplace clients plus a moderator
// that records CLEAN attestations so the fail-closed gate passes unaided.
import { existsSync } from "node:fs";
import {
  generateKeyPairSigner,
  lamports,
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { LiteSVM } from "litesvm";
import {
  createMarketplaceClient,
  type MarketplaceClient,
  type SendResult,
  type Transport,
} from "../client/index.js";
import {
  recordListingModeration,
  recordTaskModeration,
} from "../facade/moderation.js";
import { AGENC_COORDINATION_PROGRAM_ADDRESS } from "../generated/index.js";
import { createLiteSvmTransport } from "./litesvm-transport.js";
import { resolveTestingProgramSo } from "./program-asset.js";
import { seedModerationConfig, seedProtocolConfig } from "./seed.js";

/** Default lamports given to every sandbox signer (100 SOL). */
export const DEFAULT_FUNDING_LAMPORTS = 100_000_000_000n;

/** Deterministic initial sandbox clock (2023-11-14T22:13:20Z). */
export const DEFAULT_UNIX_TIMESTAMP = 1_700_000_000n;

/** Options for {@link startLocalMarketplace}. */
export interface StartLocalMarketplaceOptions {
  /**
   * Explicit path to a compiled `agenc_coordination.so`. Defaults to the
   * program shipped in the package's `testing-assets/` folder.
   */
  programPath?: string;
  /**
   * Whether `ModerationConfig.enabled` is seeded as `true`. Defaults to
   * `true` (mainnet posture): hires and claims then REQUIRE the CLEAN
   * attestations the returned {@link LocalModerator} records.
   *
   * **`false` skips ONLY the hire-time listing gate**
   * (`hire_from_listing` / `hire_from_listing_humanless`) — it does NOT relax
   * the rest of the flow. On-chain, recording attestations
   * (`record_listing_moderation` / `record_task_moderation`, i.e.
   * {@link LocalModerator.attestListing} / {@link LocalModerator.attestTask})
   * and `setTaskJobSpec` all REQUIRE `enabled = true`, and
   * `claimTaskWithJobSpec` (the only claim path; plain `claim_task` is
   * fail-closed) requires the job spec `setTaskJobSpec` pins — so with
   * moderation disabled no task can ever be claimed or go live. Leave this
   * `true` for any flow that claims tasks.
   */
  moderationEnabled?: boolean;
  /** Minimum arbiter stake seeded into ProtocolConfig. Defaults to `0n`. */
  minArbiterStake?: bigint;
  /**
   * Initial VM clock (unix seconds). Defaults to
   * {@link DEFAULT_UNIX_TIMESTAMP} so deadline math is deterministic.
   */
  unixTimestamp?: bigint;
  /**
   * Lamports given to the default payer and to signers from `fundedSigner()`
   * when no per-call amount is passed. Defaults to
   * {@link DEFAULT_FUNDING_LAMPORTS}.
   */
  fundingLamports?: bigint;
}

/**
 * The sandbox moderation authority: records CLEAN (status 0, risk 0)
 * attestations signed by the seeded `ModerationConfig.moderationAuthority`,
 * so the fail-closed hire/claim gates pass without any external service.
 *
 * P1.2: the consumption gates (`hireFromListing`, `hireFromListingHumanless`,
 * `setTaskJobSpec`) take an explicit `moderator` argument naming the
 * attestation author — pass this moderator's {@link LocalModerator.address}.
 */
export interface LocalModerator {
  /** The moderation-authority signer (also the fee payer of attestations). */
  readonly signer: KeyPairSigner;
  /** Convenience: `signer.address`. */
  readonly address: Address;
  /**
   * Record a CLEAN `ListingModeration` for `(listing, specHash)` — the gate
   * `hireFromListing` checks. `specHash` must equal the listing's pinned
   * `specHash` (32 bytes, not all zero). Throws a descriptive local error if
   * the sandbox was started with `moderationEnabled: false` (the program
   * rejects all attestations then).
   */
  attestListing(listing: Address, specHash: Uint8Array): Promise<SendResult>;
  /**
   * Record a CLEAN `TaskModeration` for `(task, jobSpecHash)` — the gate
   * `setTaskJobSpec` + `claimTaskWithJobSpec` check. `jobSpecHash` must equal
   * the hash the creator will pin via `setTaskJobSpec` (32 bytes, not all
   * zero). Throws a descriptive local error if the sandbox was started with
   * `moderationEnabled: false` (the program rejects all attestations then).
   */
  attestTask(task: Address, jobSpecHash: Uint8Array): Promise<SendResult>;
}

/** The running local marketplace returned by {@link startLocalMarketplace}. */
export interface LocalMarketplace {
  /** The underlying litesvm VM (escape hatch: balances, accounts, clock). */
  readonly svm: LiteSVM;
  /** The litesvm-backed {@link Transport} every client here submits through. */
  readonly transport: Transport;
  /** The agenc-coordination program address loaded into the VM. */
  readonly programAddress: Address;
  /**
   * The protocol admin: authority AND treasury of the seeded ProtocolConfig
   * (pass `admin.address` as `treasury` to settlement instructions).
   */
  readonly admin: KeyPairSigner;
  /** The default funded fee payer behind {@link LocalMarketplace.client}. */
  readonly payer: KeyPairSigner;
  /** A ready {@link MarketplaceClient} bound to the default payer. */
  readonly client: MarketplaceClient;
  /** The sandbox moderation authority. */
  readonly moderator: LocalModerator;
  /**
   * A {@link MarketplaceClient} bound to `signer` over the same VM — use one
   * per actor (provider, buyer, worker) so each instruction's authority is
   * its own fee payer, exactly like production.
   */
  clientFor(signer: TransactionSigner): MarketplaceClient;
  /** Generate a new signer pre-funded with `fundsLamports` (default 100 SOL). */
  fundedSigner(fundsLamports?: bigint): Promise<KeyPairSigner>;
  /**
   * Advance litesvm past the current blockhash. litesvm dedupes
   * byte-identical transactions — call this before re-sending an identical
   * transaction.
   */
  expireBlockhash(): void;
}

function assertModerationEnabled(moderationEnabled: boolean): void {
  if (!moderationEnabled) {
    throw new Error(
      "marketplace-sdk/testing: this sandbox was started with " +
        "moderationEnabled: false, so the on-chain program rejects ALL " +
        "moderation attestations (record_listing_moderation / " +
        "record_task_moderation require ModerationConfig.enabled). " +
        "moderationEnabled: false skips only the hire-time listing gate; " +
        "setTaskJobSpec and claimTaskWithJobSpec still require an attested " +
        "task, so no task can be claimed in this configuration. Start the " +
        "sandbox with moderationEnabled: true (the default) for any flow " +
        "that attests, pins a job spec, or claims tasks.",
    );
  }
}

function assertHash32(name: string, hash: Uint8Array): void {
  if (hash.length !== 32) {
    throw new Error(
      `marketplace-sdk/testing: ${name} must be exactly 32 bytes (got ${hash.length})`,
    );
  }
  if (!hash.some((byte) => byte !== 0)) {
    throw new Error(
      `marketplace-sdk/testing: ${name} must not be all zeros (the program rejects zero hashes)`,
    );
  }
}

/**
 * Boot a complete local AgenC marketplace: the REAL compiled
 * agenc-coordination program running in litesvm (in-process, no validator, no
 * RPC, no keys, no network), with `ProtocolConfig` + `ModerationConfig`
 * pre-seeded, a funded admin/payer/moderator, and `createMarketplaceClient`
 * wired over a litesvm {@link Transport} — the exact
 * assemble/sign/confirm/error pipeline production uses.
 *
 * The moderation gate is fail-closed ON by default; use
 * `moderator.attestListing(...)` / `moderator.attestTask(...)` to record the
 * CLEAN attestations that hires and claims require.
 *
 * @param options - Optional knobs; the defaults boot a mainnet-postured
 * sandbox.
 * @returns A running {@link LocalMarketplace}.
 *
 * @example
 * ```ts
 * import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
 *
 * const market = await startLocalMarketplace();
 * const provider = await market.fundedSigner();
 * const providerClient = market.clientFor(provider);
 * // register -> list -> market.moderator.attestListing -> hire -> ...
 * ```
 */
export async function startLocalMarketplace(
  options: StartLocalMarketplaceOptions = {},
): Promise<LocalMarketplace> {
  const programPath = options.programPath ?? resolveTestingProgramSo();
  if (options.programPath !== undefined && !existsSync(options.programPath)) {
    throw new Error(
      `marketplace-sdk/testing: programPath does not exist: ${options.programPath}`,
    );
  }
  const fundingLamports =
    options.fundingLamports ?? DEFAULT_FUNDING_LAMPORTS;

  const svm = new LiteSVM();
  svm.addProgramFromFile(AGENC_COORDINATION_PROGRAM_ADDRESS, programPath);
  const clock = svm.getClock();
  clock.unixTimestamp = options.unixTimestamp ?? DEFAULT_UNIX_TIMESTAMP;
  svm.setClock(clock);

  async function fundedSigner(
    fundsLamports: bigint = fundingLamports,
  ): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    svm.airdrop(signer.address, lamports(fundsLamports));
    return signer;
  }

  const admin = await fundedSigner();
  const moderatorSigner = await fundedSigner();
  const payer = await fundedSigner();
  const moderationEnabled = options.moderationEnabled ?? true;

  await seedProtocolConfig(svm, admin.address, {
    minArbiterStake: options.minArbiterStake,
  });
  await seedModerationConfig(
    svm,
    admin.address,
    moderatorSigner.address,
    moderationEnabled,
  );

  const transport = createLiteSvmTransport(svm);
  const clientFor = (signer: TransactionSigner): MarketplaceClient =>
    createMarketplaceClient({ transport, signer });

  const moderatorClient = clientFor(moderatorSigner);
  const CLEAN = {
    status: 0, // CLEAN
    riskScore: 0,
    categoryMask: 0n,
    policyHash: new Uint8Array(32),
    scannerHash: new Uint8Array(32),
    expiresAt: 0n, // never expires
  } as const;

  const moderator: LocalModerator = {
    signer: moderatorSigner,
    address: moderatorSigner.address,
    async attestListing(listing, specHash) {
      assertModerationEnabled(moderationEnabled);
      assertHash32("specHash", specHash);
      return moderatorClient.send([
        await recordListingModeration({
          moderator: moderatorSigner,
          listing,
          jobSpecHash: specHash,
          ...CLEAN,
        }),
      ]);
    },
    async attestTask(task, jobSpecHash) {
      assertModerationEnabled(moderationEnabled);
      assertHash32("jobSpecHash", jobSpecHash);
      return moderatorClient.send([
        await recordTaskModeration({
          moderator: moderatorSigner,
          task,
          jobSpecHash,
          ...CLEAN,
        }),
      ]);
    },
  };

  return {
    svm,
    transport,
    programAddress: AGENC_COORDINATION_PROGRAM_ADDRESS,
    admin,
    payer,
    client: clientFor(payer),
    moderator,
    clientFor,
    fundedSigner,
    expireBlockhash: () => svm.expireBlockhash(),
  };
}
