#!/usr/bin/env node
// rev9-localnet-scenarios.mjs: the eight end-to-end scenarios of the revision 9
// design (section 11.8) on a disposable local validator, with exact lamport
// deltas at every step.
//
// It needs a running localnet with the `validation-timings` program build
// (300-second dispute and ruling windows, 60-second resubmit and release
// grace) and the .localnet/env.json it wrote, for example:
//
//   node scripts/localnet-mac.mjs up --profile validation-timings \
//     --validator <solana-test-validator> --so <vt.so> --ledger <dir>
//
// Actors. The three local owners (authority, moderator, seeder) approve 2 of 3.
// The moderator key is the moderation authority, the local attestor that
// records every safety check; scenario 8 also adds a roster attestor by 2 of 3.
// A keeper wallet sends the keeper's transactions (expire_reject_frozen,
// expire_claim, rulings as a proposer that is not an owner,
// settle_dispute_claim, apply_initiator_slash) through the revision 9 SDK
// facades. Every other actor is a fresh wallet funded by the local faucet.
//
// Checks. Each step snapshots the balances it touches, sends one transaction,
// and compares every change with the design: known amounts (price, deposit,
// bond, fee, cleanup reward), rent-exempt minimums of the account sizes, and
// what a closed account held before the step. Expected failures are broadcast
// without preflight, so they land and their only cost is the fee. Scenario 6
// waits for a claim to expire one hour after its task's deadline (not
// timing-gated), so it starts first and finishes last.
//
// The validator keeps RocksDB write-ahead logs until they reach 4 GiB; between
// steps and during waits the run asks scripts/localnet-mac.mjs to compact (a
// restart on the same ledger) once they pass 600 MB.
//
// USAGE
//   node scripts/rev9-localnet-scenarios.mjs [--only 1,3,5] [--report <file.json>]
//        [--markdown <file.md>] [--no-wait] [--allow-production]
//
//   --no-wait            stop scenarios 2, 4 and 6 before their waits (a dry run)
//   --allow-production   dry-run scenarios 1, 3, 5, 6, 7 and 8 on a production
//                        build (its windows are 72 hours)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPlainKeypairFile } from "./keypair-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kit = await import("@solana/kit");
const sdk = await import(pathToFileURL(path.join(ROOT, "packages/sdk-ts/dist/index.js")).href);
const { facade } = sdk;

// ------------------------------------------------------------------- args
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const only = flag("--only") === null ? null : new Set(flag("--only").split(",").map(Number));
const reportPath = flag("--report") === null ? null : path.resolve(flag("--report"));
const markdownPath = flag("--markdown") === null ? null : path.resolve(flag("--markdown"));
const wanted = (n) => only === null || only.has(n);
const noWait = args.includes("--no-wait");

const env = JSON.parse(readFileSync(path.join(ROOT, ".localnet/env.json"), "utf8"));
const url = new URL(env.rpcUrl);
if (env.cluster !== "localnet" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("the scenarios run only on the disposable loopback localnet");
}
const timed = env.programProfile === "validation-timings";
if (!timed) {
  const quick = [1, 3, 5, 6, 7, 8];
  if (!args.includes("--allow-production") || only === null || [...only].some((n) => !quick.includes(n))) {
    throw new Error(
      "the scenarios need the validation-timings build; on a production build pass --allow-production --only with scenarios from 1,3,5,6,7,8",
    );
  }
}
const isMacLauncher = env.launcher === "localnet-mac";

// -------------------------------------------------------------------- rpc
const rpc = kit.createSolanaRpc(env.rpcUrl);
// Broadcast even expected failures, as the RPC suites do, so a refusal is a
// landed transaction whose only effect is its fee.
const landedRpc = new Proxy(rpc, {
  get(target, property) {
    if (property === "sendTransaction") {
      return (wire, config) =>
        target.sendTransaction(wire, { ...config, encoding: "base64", skipPreflight: true });
    }
    return Reflect.get(target, property);
  },
});
const client = (signer) => sdk.createMarketplaceClient({ signer, rpc: landedRpc, commitment: "confirmed" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const id32 = () => new Uint8Array(randomBytes(32));
const SOL = 1_000_000_000n;
const CLOCK = kit.address("SysvarC1ock11111111111111111111111111111111");

// Review S-19: a parse error names the key file, never its content.
const key = (file) => kit.createKeyPairSignerFromBytes(readPlainKeypairFile(file));
const owner = {
  a: await key(env.keypairs.authority),
  b: await key(env.keypairs.moderator),
  c: await key(env.keypairs.seeder),
};
const moderator = owner.b; // the moderation authority: the local attestor

async function info(account) {
  return (await rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send()).value;
}
async function read(account, decoder) {
  const value = await info(account);
  if (value === null) throw new Error(`${account} does not exist`);
  return decoder.decode(Buffer.from(value.data[0], "base64"));
}
const exists = async (account) => (await info(account)) !== null;
const dataLength = async (account) => {
  const value = await info(account);
  return value === null ? null : Buffer.from(value.data[0], "base64").length;
};
const balance = async (account) =>
  BigInt((await rpc.getBalance(account, { commitment: "confirmed" }).send()).value);
const rents = new Map();
async function rentFor(size) {
  if (!rents.has(size)) rents.set(size, BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(size)).send()));
  return rents.get(size);
}
const clock = async () => Buffer.from((await info(CLOCK)).data[0], "base64").readBigInt64LE(32);

const [protocolPda] = await sdk.findProtocolConfigPda();
const config = await read(protocolPda, sdk.getProtocolConfigDecoder());
const treasury = config.treasury;
const owners = config.multisigOwners.slice(0, config.multisigOwnersLen);
const FEE_BPS = BigInt(config.protocolFeeBps);
const fee5 = (amount) => (amount * FEE_BPS) / 10_000n;
const SIZE = {
  task: 466,
  marker: sdk.getTaskMarkerSize(),
  escrow: sdk.getTaskEscrowSize(),
  hire: sdk.getHireRecordSize(),
  validation: sdk.getTaskValidationConfigSize(),
  attestorConfig: sdk.getTaskAttestorConfigSize(),
  rateLimit: sdk.getAuthorityRateLimitSize(),
  claim: sdk.getTaskClaimSize(),
  agentStats: sdk.getAgentStatsSize(),
  creatorStats: sdk.getCreatorStatsSize(),
  submission: sdk.getTaskSubmissionSize(),
  moderation: sdk.getTaskModerationSize(),
  bond: sdk.getDisputeBondSize(),
};
// Design amounts (revision 9 sections 2 and 5).
const depositFor = (share) => (share / 10n > 5_000_000n ? share / 10n : 5_000_000n);
const bondFor = (share) => (share / 10n > 10_000_000n ? share / 10n : 10_000_000n);
const CLEANUP_REWARD = 1_000n;

// ----------------------------------------------------------- transactions
async function landed(signature) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const tx = await rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    if (tx?.meta) return tx;
    await sleep(250);
  }
  throw new Error(`no confirmed transaction ${signature}`);
}
const plain = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v));
/** Send; return the fee the fee payer (the client's signer) paid. */
async function send(signer, instructions) {
  const { signature } = await client(signer).send(instructions);
  const tx = await landed(signature);
  if (tx.meta.err !== null) throw new Error(`${signature} failed: ${plain(tx.meta.err)}`);
  return BigInt(tx.meta.fee);
}
/** Send what the program must refuse; return the landed error code and fee. */
async function refusal(signer, instructions) {
  let result;
  try {
    result = await client(signer).send(instructions);
  } catch (error) {
    if (!(error instanceof sdk.AgencError) || !error.signature) throw error;
    const tx = await landed(error.signature);
    return { code: error.code, fee: BigInt(tx.meta.fee) };
  }
  throw new Error(`the program accepted what it must refuse (${result.signature})`);
}
async function funded(sol = 3n) {
  const signer = await kit.generateKeyPairSigner();
  await rpc.requestAirdrop(signer.address, kit.lamports(sol * SOL)).send();
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if ((await balance(signer.address)) >= sol * SOL) return signer;
    await sleep(250);
  }
  throw new Error("the local faucet did not fund a wallet");
}

// ------------------------------------------------- ledger budget and waits
let compactions = 0;
/** Between steps only: restart on the same ledger once the logs pass 600 MB. */
function maybeCompact() {
  if (!isMacLauncher) return;
  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts/localnet-mac.mjs"), "compact", "--if-wal-over", "600"],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  if (out.includes("compacted")) {
    compactions += 1;
    console.log(`   ${out}`);
  }
}
/** Wait until the cluster clock passes `target`, riding out a compaction. */
async function waitClock(target, label) {
  let notice = 0;
  let compactCheck = Date.now();
  let outage = null;
  for (;;) {
    let now;
    try {
      now = await clock();
      outage = null;
    } catch (error) {
      outage ??= Date.now();
      if (Date.now() - outage > 180_000) throw error;
      await sleep(1_000);
      continue;
    }
    if (now > target) return now;
    if (Date.now() - notice > 60_000) {
      console.log(`   ... ${label}: waiting for the cluster clock to pass ${target} (now ${now})`);
      notice = Date.now();
    }
    if (target - now > 120n && Date.now() - compactCheck > 60_000) {
      compactCheck = Date.now();
      maybeCompact();
    }
    await sleep(2_000);
  }
}

// ----------------------------------------------------------------- report
const rows = [];
function check(scenario, stepName, label, expected, actual) {
  const pass = expected === actual;
  rows.push({ scenario, step: stepName, label, expected: String(expected), actual: String(actual), pass });
  console.log(`${pass ? "ok  " : "FAIL"} S${scenario} ${stepName} | ${label}: expected ${expected}, got ${actual}`);
  return pass;
}
async function snapshot(accounts) {
  const out = {};
  for (const [label, account] of Object.entries(accounts)) out[label] = await balance(account);
  return out;
}
/**
 * Run one step and check the change of every tracked account. `expected`
 * gets (balances before, fee) and returns the deltas; a tracked account it
 * leaves out must not move.
 */
async function step(scenario, name, accounts, run, expected) {
  const before = await snapshot(accounts);
  const fee = await run();
  const after = await snapshot(accounts);
  const deltas = await expected(before, fee);
  for (const label of Object.keys(deltas)) {
    if (!(label in accounts)) throw new Error(`S${scenario} ${name}: ${label} is not tracked`);
  }
  for (const label of Object.keys(accounts)) {
    check(scenario, name, `${label} change`, deltas[label] ?? 0n, after[label] - before[label]);
  }
  return { before, after, fee };
}
/** A refused step: the right error, the payer pays the fee, nothing else moves. */
async function refusedStep(scenario, name, accounts, payerLabel, signer, instructions, code) {
  let result;
  await step(scenario, name, accounts, async () => {
    result = await refusal(signer, instructions);
    return result.fee;
  }, async (_before, fee) => ({ [payerLabel]: -fee }));
  check(scenario, name, "error code", code, result.code);
}

// ----------------------------------------------------------------- actors
const CLEAN = {
  status: 0,
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32).fill(1),
  scannerHash: new Uint8Array(32).fill(2),
  expiresAt: 0n,
};

async function agent(wallet, stakeAmount = config.minAgentStake) {
  const agentId = id32();
  const [address] = await sdk.findAgentPda({ agentId });
  await send(wallet, [
    await facade.registerAgent({
      authority: wallet,
      agentId,
      capabilities: 1n,
      endpoint: "https://example.invalid/rev9-localnet",
      metadataUri: null,
      stakeAmount,
    }),
  ]);
  return address;
}

/** A provider agent with a moderated listing (setup, not a scenario step). */
async function newProvider({ price = 20_000_000n, deadlineSecs = 3_600n, attestor = moderator, roster = false } = {}) {
  const wallet = await funded(5n);
  const providerAgent = await agent(wallet);
  const listingId = id32();
  const spec = id32();
  const [listing] = await facade.findListingPda({ providerAgent, listingId });
  await send(wallet, [
    await facade.createServiceListing({
      providerAgent,
      authority: wallet,
      listingId,
      name: id32(),
      category: id32(),
      tags: new Uint8Array(64).fill(1),
      specHash: spec,
      specUri: "agenc://job-spec/rev9-localnet",
      price,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: deadlineSecs,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    }),
  ]);
  await send(attestor, [
    await facade.recordListingModeration({
      moderator: attestor,
      listing,
      jobSpecHash: spec,
      ...(roster ? { moderationAttestor: (await facade.findModerationAttestorPda({ attestor: attestor.address }))[0] } : {}),
      ...CLEAN,
    }),
  ]);
  return { wallet, agent: providerAgent, listing, spec, price };
}

/** Step: a bare-wallet hire (hire_from_listing_humanless, v3). */
async function hire(s, provider, buyer, { attestor = moderator, roster = false, name = "hire (bare wallet)" } = {}) {
  const taskId = id32();
  const [task] = await sdk.findTaskPda({ creator: buyer.address, taskId });
  const [escrow] = await sdk.findEscrowPda({ task });
  const [hireRecord] = await sdk.findHireRecordPda({ task });
  const [validation] = await sdk.findTaskValidationConfigPda({ task });
  const [rateLimit] = await sdk.findAuthorityRateLimitPda({ authority: buyer.address });
  const firstHire = !(await exists(rateLimit));
  const { version } = await read(provider.listing, sdk.getServiceListingDecoder());
  await step(s, name, { buyer: buyer.address, task, escrow, hireRecord, validation, rateLimit }, async () =>
    send(buyer, [
      await facade.hireFromListingHumanless({
        taskId,
        creator: buyer,
        listing: provider.listing,
        providerAgent: provider.agent,
        expectedPrice: provider.price,
        expectedVersion: version,
        reviewWindowSecs: 3_600n,
        listingSpecHash: provider.spec,
        taskJobSpecHash: provider.spec,
        moderator: attestor.address,
        moderatorIsAttestor: roster,
      }),
    ]),
    async (_before, fee) => {
      const d = {
        task: await rentFor(SIZE.task),
        escrow: (await rentFor(SIZE.escrow)) + provider.price,
        hireRecord: await rentFor(SIZE.hire),
        validation: await rentFor(SIZE.validation),
        rateLimit: firstHire ? await rentFor(SIZE.rateLimit) : 0n,
      };
      return { ...d, buyer: -(d.task + d.escrow + d.hireRecord + d.validation + d.rateLimit + fee) };
    });
  check(s, name, "task size", SIZE.task, await dataLength(task));
  const review = await read(validation, sdk.getTaskValidationConfigDecoder());
  check(s, name, "review config mode", sdk.ValidationMode.CreatorReview, review.mode);
  return { s, provider, buyer, taskId, task, escrow, hireRecord, validation };
}

/** Step: the safety check, rent paid by the buyer (rent_payer). */
async function moderate(job, { attestor = moderator, roster = false } = {}) {
  const [record] = await sdk.findTaskModerationPda({ task: job.task, jobSpecHash: job.provider.spec, moderator: attestor.address });
  const name = "safety check, rent paid by the buyer";
  await step(job.s, name, { buyer: job.buyer.address, attestor: attestor.address, record }, async () =>
    send(attestor, [
      await facade.recordTaskModeration({
        task: job.task,
        moderator: attestor,
        rentPayer: job.buyer,
        jobSpecHash: job.provider.spec,
        ...(roster ? { moderationAttestor: (await facade.findModerationAttestorPda({ attestor: attestor.address }))[0] } : {}),
        ...CLEAN,
      }),
    ]),
    async (_before, fee) => {
      const rent = await rentFor(SIZE.moderation);
      return { record: rent, buyer: -rent, attestor: -fee };
    });
  check(job.s, name, "record marks the creator as its rent payer (_reserved[0])", 1, (await read(record, sdk.getTaskModerationDecoder())).reserved[0]);
  job.record = record;
  job.attestor = attestor;
  job.roster = roster;
}

/** Step: publish the job spec. */
async function publish(job) {
  const [jobSpec] = await sdk.findTaskJobSpecPda({ task: job.task });
  await step(job.s, "publish", { buyer: job.buyer.address, jobSpec }, async () =>
    send(job.buyer, [
      await facade.setTaskJobSpec({
        task: job.task,
        creator: job.buyer,
        jobSpecHash: job.provider.spec,
        jobSpecUri: "agenc://job-spec/rev9-localnet",
        moderator: job.attestor.address,
        moderatorIsAttestor: job.roster,
      }),
    ]),
    async (_before, fee) => {
      const rent = await rentFor(await dataLength(jobSpec));
      return { jobSpec: rent, buyer: -(rent + fee) };
    });
  job.jobSpec = jobSpec;
}

/** Step: the provider claims; the deposit is locked in the claim. */
async function claim(job) {
  const p = job.provider;
  const [claimPda] = await sdk.findClaimPda({ task: job.task, bidder: p.agent });
  const [stats] = await sdk.findWorkerStatsPda({ worker: p.agent });
  const [moderationBlock] = await sdk.findModerationBlockPda({ contentHash: p.spec });
  const firstClaim = !(await exists(stats));
  const deposit = depositFor(p.price);
  const name = "claim (deposit locked)";
  await step(job.s, name, { provider: p.wallet.address, claim: claimPda, stats }, async () =>
    send(p.wallet, [await facade.claimTaskWithJobSpec({ task: job.task, worker: p.agent, authority: p.wallet, moderationBlock })]),
    async (_before, fee) => {
      const claimTotal = (await rentFor(SIZE.claim)) + deposit;
      const statsRent = firstClaim ? await rentFor(SIZE.agentStats) : 0n;
      return { claim: claimTotal, stats: statsRent, provider: -(claimTotal + statsRent + fee) };
    });
  check(job.s, name, "deposit is max(10% of the price, 0.005 SOL)", deposit, (await balance(claimPda)) - (await rentFor(SIZE.claim)));
  job.claim = claimPda;
  job.stats = stats;
  job.deposit = deposit;
}

/** Step: the provider delivers; the deposit comes back. */
async function submit(job, name = "submit (deposit back)") {
  const p = job.provider;
  const [submission] = await sdk.findTaskSubmissionPda({ claim: job.claim });
  const fresh = !(await exists(submission));
  const held = (await balance(job.claim)) - (await rentFor(SIZE.claim));
  await step(job.s, name, { provider: p.wallet.address, claim: job.claim, submission }, async () =>
    send(p.wallet, [await facade.submitTaskResult({ task: job.task, worker: p.agent, authority: p.wallet, proofHash: id32(), resultData: null })]),
    async (_before, fee) => {
      const rent = fresh ? await rentFor(SIZE.submission) : 0n;
      return { claim: -held, submission: rent, provider: held - rent - fee };
    });
  job.submission = submission;
}

/** Steps: hire, safety check, publish, claim, submit. */
async function delivered(s, provider, options = {}) {
  const buyer = options.buyer ?? (await funded(3n));
  const job = await hire(s, provider, buyer, options);
  await moderate(job, options);
  await publish(job);
  await claim(job);
  await submit(job);
  return job;
}

const creatorStatsOf = async (wallet) => (await sdk.findCreatorStatsPda({ authority: wallet }))[0];

/** Step: the buyer turns the delivery down (reject_and_freeze). */
async function turnDown(job) {
  const stats = await creatorStatsOf(job.buyer.address);
  const firstRecord = !(await exists(stats));
  await step(job.s, "turn down (freeze)", { buyer: job.buyer.address, creatorStats: stats }, async () =>
    send(job.buyer, [await facade.rejectAndFreeze({ task: job.task, worker: job.provider.agent, creator: job.buyer, rejectionHash: id32() })]),
    async (_before, fee) => {
      // The buyer's first refusal starts its CreatorStats record, paid by it.
      const rent = firstRecord ? await rentFor(SIZE.creatorStats) : 0n;
      return { creatorStats: rent, buyer: -(rent + fee) };
    });
  const frozen = await read(job.submission, sdk.getTaskSubmissionDecoder());
  const now = await clock();
  check(job.s, "turn down (freeze)", "a disputable freeze", true, sdk.values.isDisputableFreeze(frozen));
  const window = timed ? 300n : 259_200n;
  check(job.s, "turn down (freeze)", `dispute window is ${window} s (within 5 s of the clock)`, true, frozen.reviewDeadlineAt - now <= window && frozen.reviewDeadlineAt - now >= window - 5n);
  job.reviewDeadlineAt = frozen.reviewDeadlineAt;
}

const exitsOf = (job) => ({
  task: job.task,
  claim: job.claim,
  worker: job.provider.agent,
  treasury,
  creator: job.buyer.address,
  workerAuthority: job.provider.wallet.address,
});

/** Step: the provider disputes the turn-down and posts the bond. */
async function disputeTurnDown(job) {
  const bond = await facade.findRejectionDisputeBondPda(job.task);
  const amount = bondFor(job.provider.price);
  await step(job.s, "dispute the turn-down (bond)", { provider: job.provider.wallet.address, bond }, async () =>
    send(job.provider.wallet, [
      await facade.disputeRejection({
        task: job.task,
        worker: job.provider.agent,
        creator: job.buyer.address,
        authority: job.provider.wallet,
        evidenceHash: id32(),
        evidenceUri: "",
      }),
    ]),
    async (_before, fee) => {
      const total = (await rentFor(SIZE.bond)) + amount;
      return { bond: total, provider: -(total + fee) };
    });
  const state = await read(bond, sdk.getDisputeBondDecoder());
  check(job.s, "dispute the turn-down (bond)", "bond is max(10% of the price, 0.01 SOL)", amount, state.amount);
  job.bond = bond;
  job.bondAmount = amount;
  job.rulingDeadline = state.rulingDeadline;
}

/** Step: a 2-of-3 ruling on a disputed freeze, proposed by the keeper. */
async function rule(job, approve, keeper) {
  const fee = fee5(job.provider.price);
  const name = approve ? "2-of-3 ruling for the provider" : "2-of-3 ruling for the buyer (uphold)";
  await step(job.s, name,
    { buyer: job.buyer.address, provider: job.provider.wallet.address, treasury, keeper: keeper.address, escrow: job.escrow, claim: job.claim, submission: job.submission, bond: job.bond },
    async () => send(keeper, [
      await facade.resolveRejectFrozen({
        ...exitsOf(job),
        authority: keeper,
        approveCompletion: approve,
        rationaleHash: id32(),
        rationaleUri: "agenc://ruling/rev9-localnet",
        multisigSigners: [owner.a, owner.b],
      }),
    ]),
    async (b, txFee) => approve
      ? {
          // Paid as on accept (95%), and the whole bond back.
          provider: job.provider.price - fee + b.claim + b.submission + b.bond,
          buyer: b.escrow - job.provider.price,
          treasury: fee,
          keeper: -txFee,
          escrow: -b.escrow,
          claim: -b.claim,
          submission: -b.submission,
          bond: -b.bond,
        }
      : {
          // Refunded with the bond's principal; the bond's rent goes back to the filer.
          buyer: b.escrow + job.bondAmount,
          provider: b.claim + b.submission + (b.bond - job.bondAmount),
          keeper: -txFee,
          escrow: -b.escrow,
          claim: -b.claim,
          submission: -b.submission,
          bond: -b.bond,
        });
}

/** Step: the keeper ends a frozen turn-down after its window (expire_reject_frozen). */
async function expireFrozen(job, keeper, name) {
  const accounts = { buyer: job.buyer.address, provider: job.provider.wallet.address, keeper: keeper.address, treasury, escrow: job.escrow, claim: job.claim, submission: job.submission };
  if (job.bond) accounts.bond = job.bond;
  await step(job.s, name, accounts,
    async () => send(keeper, [await facade.expireRejectFrozen({ ...exitsOf(job), authority: keeper })]),
    async (b, txFee) => ({
      buyer: b.escrow,
      provider: b.claim + b.submission + (job.bond ? b.bond : 0n),
      keeper: -txFee,
      escrow: -b.escrow,
      claim: -b.claim,
      submission: -b.submission,
      ...(job.bond ? { bond: -b.bond } : {}),
    }));
  check(job.s, name, "task status", sdk.TaskStatus.Cancelled, (await read(job.task, sdk.getTaskDecoder())).status);
}

// -------------------------------------------------------------- scenarios
// Scenario 1. Desktop hire.
async function scenario1() {
  const s = 1;
  const provider = await newProvider();
  const job = await delivered(s, provider);
  const fee = fee5(provider.price);
  const accepted = await step(s, "accept",
    { provider: provider.wallet.address, buyer: job.buyer.address, treasury, escrow: job.escrow, claim: job.claim, submission: job.submission },
    async () => send(job.buyer, [
      await facade.acceptTaskResult({ task: job.task, worker: provider.agent, creator: job.buyer, treasury, workerAuthority: provider.wallet.address }),
    ]),
    async (b, txFee) => ({
      provider: provider.price - fee + b.claim + b.submission,
      treasury: fee,
      buyer: b.escrow - provider.price - txFee,
      escrow: -b.escrow,
      claim: -b.claim,
      submission: -b.submission,
    }));
  check(s, "accept", "provider paid 95% of the price", (provider.price * 95n) / 100n,
    accepted.after.provider - accepted.before.provider - accepted.before.claim - accepted.before.submission);
  const [rating] = await sdk.findHireRatingPda({ task: job.task });
  await step(s, "rate", { buyer: job.buyer.address, rating }, async () =>
    send(job.buyer, [await facade.rateHire({ task: job.task, listing: provider.listing, buyer: job.buyer, score: 5 })]),
    async (_b, txFee) => {
      const rent = await rentFor(await dataLength(rating));
      return { rating: rent, buyer: -(rent + txFee) };
    });
  const markerRent = await rentFor(SIZE.marker);
  const tidy = await step(s, "tidy (close_task: 56-byte marker)",
    { buyer: job.buyer.address, task: job.task, record: job.record, validation: job.validation, jobSpec: job.jobSpec, hireRecord: job.hireRecord },
    async () => send(job.buyer, [
      await facade.closeTask({
        task: job.task,
        authority: job.buyer,
        hireRecord: job.hireRecord,
        listing: provider.listing,
        children: [
          { kind: "creatorFunded", account: job.validation },
          { kind: "namedRecipient", account: job.record, recipient: job.buyer.address },
        ],
      }),
    ]),
    async (b, txFee) => ({
      task: markerRent - b.task,
      record: -b.record,
      validation: -b.validation,
      jobSpec: -b.jobSpec,
      hireRecord: -b.hireRecord,
      buyer: b.task - markerRent + b.record + b.validation + b.jobSpec + b.hireRecord - txFee,
    }));
  check(s, "tidy (close_task: 56-byte marker)", "task size", SIZE.marker, await dataLength(job.task));
  const perByte = (await rentFor(1)) - (await rentFor(0));
  check(s, "tidy (close_task: 56-byte marker)",
    `Task surplus back: (466 - 56) bytes x ${perByte} (design 2,082,800 at 5,080/byte)`,
    410n * perByte, tidy.before.task - markerRent);
  check(s, "tidy (close_task: 56-byte marker)",
    `safety check rent back: 362 bytes x ${perByte} (design 1,838,960 at 5,080/byte)`,
    362n * perByte, tidy.before.record);
}

// Scenario 2. Turn-down, no dispute (setup half, then the keeper's expiry).
async function scenario2a() {
  const s = 2;
  const provider = await newProvider();
  const job = await delivered(s, provider);
  await turnDown(job);
  const keeper = await funded(1n);
  await refusedStep(s, "an expiry inside the dispute window", { keeper: keeper.address, buyer: job.buyer.address, escrow: job.escrow }, "keeper", keeper,
    [await facade.expireRejectFrozen({ ...exitsOf(job), authority: keeper })], sdk.AGENC_COORDINATION_ERROR__REJECTION_WINDOW_STILL_OPEN);
  job.keeper = keeper;
  return job;
}
async function scenario2b(job) {
  const s = 2;
  const keeper = job.keeper;
  await waitClock(job.reviewDeadlineAt, "S2 dispute window");
  await expireFrozen(job, keeper, "keeper expire_reject_frozen after 300 s (refund)");
  const stats = await read(job.stats, sdk.getAgentStatsDecoder());
  check(s, "records", "provider tasks rejected", 1n, stats.tasksRejected);
}

// Scenario 3. Turn-down, dispute ruled for the provider.
async function scenario3() {
  const s = 3;
  const provider = await newProvider();
  const job = await delivered(s, provider);
  await turnDown(job);
  await disputeTurnDown(job);
  const keeper = await funded(1n);
  await refusedStep(s, "a ruling with one owner's approval",
    { keeper: keeper.address, buyer: job.buyer.address, provider: provider.wallet.address, escrow: job.escrow, bond: job.bond },
    "keeper", keeper,
    [await facade.resolveRejectFrozen({ ...exitsOf(job), authority: keeper, approveCompletion: true, rationaleHash: id32(), rationaleUri: "", multisigSigners: [owner.a] })],
    sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS);
  await rule(job, true, keeper);
  const stats = await read(job.stats, sdk.getAgentStatsDecoder());
  check(s, "records", "provider disputes won", 1n, stats.disputesWon);
  const creator = await read(await creatorStatsOf(job.buyer.address), sdk.getCreatorStatsDecoder());
  check(s, "records", "buyer disputes lost", 1n, creator.disputesLost);
}

// Scenario 4. Turn-down, dispute ruled for the buyer; and one left unruled.
async function scenario4a() {
  const s = 4;
  const provider = await newProvider();
  const keeper = await funded(1n);
  const upheld = await delivered(s, provider);
  await turnDown(upheld);
  await disputeTurnDown(upheld);
  await rule(upheld, false, keeper);
  const unruled = await delivered(s, provider);
  await turnDown(unruled);
  await disputeTurnDown(unruled);
  await refusedStep(s, "an expiry inside the ruling window",
    { keeper: keeper.address, buyer: unruled.buyer.address, escrow: unruled.escrow, bond: unruled.bond },
    "keeper", keeper,
    [await facade.expireRejectFrozen({ ...exitsOf(unruled), authority: keeper })],
    sdk.AGENC_COORDINATION_ERROR__REJECTION_WINDOW_STILL_OPEN);
  return { keeper, unruled };
}
async function scenario4b({ keeper, unruled }) {
  const s = 4;
  const target = unruled.rulingDeadline > unruled.reviewDeadlineAt ? unruled.rulingDeadline : unruled.reviewDeadlineAt;
  await waitClock(target, "S4 ruling window");
  await expireFrozen(unruled, keeper, "keeper expire_reject_frozen, unruled after 300 s (refund, bond back)");
  const stats = await read(unruled.stats, sdk.getAgentStatsDecoder());
  check(s, "records", "provider tasks rejected", 2n, stats.tasksRejected);
  check(s, "records", "provider disputes lost (the upheld one)", 1n, stats.disputesLost);
  check(s, "records", "provider disputes won", 0n, stats.disputesWon);
}

// Scenario 5. A ruled task dispute on a Collaborative task.
async function scenario5() {
  const s = 5;
  const stake = config.minAgentStake > 2n * config.minStakeForDispute ? config.minAgentStake : 2n * config.minStakeForDispute;
  const actor = async () => {
    const wallet = await funded(3n);
    return { wallet, agent: await agent(wallet, stake) };
  };
  const creator = await actor();
  const defendant = await actor();
  const peers = [await actor(), await actor()];
  const keeper = await funded(1n);
  const reward = 600_000_000n; // three workers: a share of 0.2 SOL each
  const share = reward / 3n;
  const taskId = id32();
  const [task] = await sdk.findTaskPda({ creator: creator.wallet.address, taskId });
  const [escrow] = await sdk.findEscrowPda({ task });
  const [rateLimit] = await sdk.findAuthorityRateLimitPda({ authority: creator.wallet.address });
  const firstLimit = !(await exists(rateLimit));
  await step(s, "create the Collaborative task", { creator: creator.wallet.address, task, escrow, rateLimit }, async () =>
    send(creator.wallet, [
      await facade.createTask({
        taskId,
        creator: creator.wallet,
        authority: creator.wallet,
        creatorAgent: creator.agent,
        requiredCapabilities: 1n,
        description: new Uint8Array([...id32(), ...new Uint8Array(32)]),
        rewardAmount: reward,
        maxWorkers: 3,
        deadline: (await clock()) + 259_200n,
        taskType: 1,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]),
    async (_b, fee) => {
      const d = {
        task: await rentFor(SIZE.task),
        escrow: (await rentFor(SIZE.escrow)) + reward,
        rateLimit: firstLimit ? await rentFor(SIZE.rateLimit) : 0n,
      };
      return { ...d, creator: -(d.task + d.escrow + d.rateLimit + fee) };
    });
  const jobSpecHash = id32();
  const [record] = await sdk.findTaskModerationPda({ task, jobSpecHash, moderator: moderator.address });
  await step(s, "safety check, rent paid by the moderator", { moderator: moderator.address, record }, async () =>
    send(moderator, [await facade.recordTaskModeration({ moderator, task, jobSpecHash, ...CLEAN })]),
    async (_b, fee) => {
      const rent = await rentFor(SIZE.moderation);
      return { record: rent, moderator: -(rent + fee) };
    });
  const [validation] = await sdk.findTaskValidationConfigPda({ task });
  const [attestorConfig] = await sdk.findTaskAttestorConfigPda({ task });
  await step(s, "configure CreatorReview", { creator: creator.wallet.address, validation, attestorConfig }, async () =>
    send(creator.wallet, [
      await facade.configureTaskValidation({ task, creator: creator.wallet, mode: 1, reviewWindowSecs: 3_600n, validatorQuorum: 0, attestor: null }),
    ]),
    async (_b, fee) => {
      const d = { validation: await rentFor(SIZE.validation), attestorConfig: await rentFor(SIZE.attestorConfig) };
      return { ...d, creator: -(d.validation + d.attestorConfig + fee) };
    });
  const [jobSpec] = await sdk.findTaskJobSpecPda({ task });
  await step(s, "publish", { creator: creator.wallet.address, jobSpec }, async () =>
    send(creator.wallet, [
      await facade.setTaskJobSpec({ task, creator: creator.wallet, jobSpecHash, jobSpecUri: "agenc://job-spec/rev9-s5", moderator: moderator.address }),
    ]),
    async (_b, fee) => {
      const rent = await rentFor(await dataLength(jobSpec));
      return { jobSpec: rent, creator: -(rent + fee) };
    });
  const [moderationBlock] = await sdk.findModerationBlockPda({ contentHash: jobSpecHash });
  const deposit = depositFor(share);
  const claims = new Map();
  for (const [label, worker] of [["defendant", defendant], ["peer 1", peers[0]], ["peer 2", peers[1]]]) {
    const [claimPda] = await sdk.findClaimPda({ task, bidder: worker.agent });
    const [stats] = await sdk.findWorkerStatsPda({ worker: worker.agent });
    await step(s, `${label} claims (deposit locked)`, { worker: worker.wallet.address, claim: claimPda, stats }, async () =>
      send(worker.wallet, [await facade.claimTaskWithJobSpec({ task, worker: worker.agent, authority: worker.wallet, moderationBlock })]),
      async (_b, fee) => {
        const d = { claim: (await rentFor(SIZE.claim)) + deposit, stats: await rentFor(SIZE.agentStats) };
        return { ...d, worker: -(d.claim + d.stats + fee) };
      });
    claims.set(worker, claimPda);
  }
  check(s, "claims", "deposit is max(10% of the 0.2 SOL share, 0.005 SOL)", 20_000_000n, deposit);
  const disputeId = id32();
  const [dispute] = await sdk.findDisputePda({ disputeId });
  const [bond] = await sdk.findDisputeBondPda({ dispute });
  const bondAmount = bondFor(share);
  await step(s, "the creator files a Refund dispute (bond)", { creator: creator.wallet.address, dispute, bond, rateLimit }, async () =>
    send(creator.wallet, [
      await facade.initiateDispute({
        task,
        disputeId,
        taskId,
        agent: creator.agent,
        initiatorClaim: sdk.AGENC_COORDINATION_PROGRAM_ADDRESS,
        authority: creator.wallet,
        workerAgent: defendant.agent,
        workerClaim: claims.get(defendant),
        evidenceHash: id32(),
        evidence: "rev9 localnet scenario 5",
        resolutionType: 0,
      }),
    ]),
    async (_b, fee) => {
      const d = { dispute: await rentFor(await dataLength(dispute)), bond: (await rentFor(SIZE.bond)) + bondAmount };
      return { ...d, creator: -(d.dispute + d.bond + fee) };
    });
  check(s, "the creator files a Refund dispute (bond)", "bond is 10% of the defendant's 0.2 SOL share", 20_000_000n, (await read(bond, sdk.getDisputeBondDecoder())).amount);
  const creatorStats = await creatorStatsOf(creator.wallet.address);
  const creatorRecordMissing = !(await exists(creatorStats));
  const ruling = (signers) =>
    facade.resolveDispute({
      dispute,
      task,
      creator: creator.wallet.address,
      worker: defendant.agent,
      workerClaim: claims.get(defendant),
      workerWallet: defendant.wallet.address,
      authority: keeper,
      multisigSigners: signers,
      multisigOwners: owners,
      approve: false,
      rationaleHash: id32(),
      rationaleUri: "agenc://ruling/rev9-s5",
      bondTreasury: treasury,
      taskValidationConfig: validation,
    });
  await refusedStep(s, "a ruling with one owner's approval", { keeper: keeper.address, creator: creator.wallet.address, defendant: defendant.wallet.address, bond },
    "keeper", keeper, [await ruling([owner.a])], sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS);
  await step(s, "2-of-3 rejection, proposed by the keeper",
    { creator: creator.wallet.address, defendant: defendant.wallet.address, keeper: keeper.address, bond, escrow, defendantClaim: claims.get(defendant), creatorStats, treasury },
    async () => send(keeper, [await ruling([owner.a, owner.b])]),
    async (b, txFee) => {
      const recordRent = creatorRecordMissing ? await rentFor(SIZE.creatorStats) : 0n;
      return {
        // Today's rule: a rejected dispute refunds the creator the escrow; the
        // bond's principal goes to the defendant and its rent to the filer.
        creator: b.escrow + (b.bond - bondAmount),
        defendant: bondAmount + b.defendantClaim,
        keeper: -(txFee + recordRent),
        creatorStats: recordRent,
        bond: -b.bond,
        escrow: -b.escrow,
        defendantClaim: -b.defendantClaim,
      };
    });
  for (const [index, peer] of peers.entries()) {
    const peerClaim = claims.get(peer);
    const [submission] = await sdk.findTaskSubmissionPda({ claim: peerClaim });
    await step(s, `keeper settle_dispute_claim, peer ${index + 1}`,
      { peerWallet: peer.wallet.address, peerAgent: peer.agent, claim: peerClaim, keeper: keeper.address },
      async () => send(keeper, [
        await facade.settleDisputeClaim({ dispute, task, claim: peerClaim, worker: peer.agent, authority: keeper, taskValidationConfig: validation, workerAuthority: peer.wallet.address }),
      ]),
      async (b, txFee) => ({
        peerWallet: b.claim + (await balance(submission)),
        claim: -b.claim,
        keeper: -txFee,
      }));
  }
  const creatorAgentBefore = await read(creator.agent, sdk.getAgentRegistrationDecoder());
  const slash = (creatorAgentBefore.stake * BigInt(config.slashPercentage)) / 100n;
  await step(s, "keeper apply_initiator_slash (the filer lost)", { creatorAgent: creator.agent, treasury, keeper: keeper.address }, async () =>
    send(keeper, [await facade.applyInitiatorSlash({ dispute, initiatorAgent: creator.agent, treasury, authority: keeper })]),
    async (_b, txFee) => ({ creatorAgent: -slash, treasury: slash, keeper: -txFee }));
  check(s, "keeper apply_initiator_slash (the filer lost)", `creator stake after a ${config.slashPercentage}% slash`, creatorAgentBefore.stake - slash, (await read(creator.agent, sdk.getAgentRegistrationDecoder())).stake);
  const defendantStats = await read((await sdk.findWorkerStatsPda({ worker: defendant.agent }))[0], sdk.getAgentStatsDecoder());
  check(s, "records", "defendant disputes won", 1n, defendantStats.disputesWon);
  check(s, "records", "task status", sdk.TaskStatus.Cancelled, (await read(task, sdk.getTaskDecoder())).status);
}

// Scenario 6. No-show (setup half: the hire and claim, and the release variant).
async function scenario6a() {
  const s = 6;
  const keeper = await funded(1n);
  // The release variant: inside the 60-second grace the deposit comes back.
  const releaseProvider = await newProvider();
  const released = await hire(s, releaseProvider, await funded(3n), { name: "variant: hire" });
  await moderate(released);
  await publish(released);
  await claim(released);
  const claimed = await read(released.claim, sdk.getTaskClaimDecoder());
  await step(s, "variant: release_claim inside the 60-second grace (deposit back)",
    { provider: releaseProvider.wallet.address, claim: released.claim, buyer: released.buyer.address },
    async () => send(releaseProvider.wallet, [
      await facade.releaseClaim({ task: released.task, worker: releaseProvider.agent, creator: released.buyer.address, authority: releaseProvider.wallet }),
    ]),
    async (b, txFee) => ({ provider: b.claim - txFee, claim: -b.claim }));
  check(s, "variant: release_claim inside the 60-second grace (deposit back)", "released within 60 s of the claim", true, (await clock()) - claimed.claimedAt <= 60n);
  // The no-show: a short deadline (60 s); the claim still expires an hour after it.
  const provider = await newProvider({ deadlineSecs: 60n });
  const job = await hire(s, provider, await funded(3n), { name: "short-deadline hire (60 s)" });
  await moderate(job);
  await publish(job);
  await claim(job);
  const state = await read(job.claim, sdk.getTaskClaimDecoder());
  const taskState = await read(job.task, sdk.getTaskDecoder());
  check(s, "claim (deposit locked)", "claim expires 1 hour after the deadline", taskState.deadline + 3_600n, state.expiresAt);
  job.keeper = keeper;
  job.expiresAt = state.expiresAt;
  return job;
}
async function scenario6b(job) {
  const s = 6;
  const p = job.provider;
  const keeper = job.keeper;
  console.log(`   S6: the claim expires at ${job.expiresAt}; the keeper may expire it after the 60-second grace`);
  await waitClock(job.expiresAt + 60n, "S6 claim expiry and grace");
  const [workerCompletionBond] = await sdk.findWorkerCompletionBondPda({ task: job.task, workerAuthority: p.wallet.address });
  const expiredBefore = (await read(job.stats, sdk.getAgentStatsDecoder())).claimsExpired;
  await step(s, "keeper expire_claim after expiry and grace (deposit to the buyer)",
    { buyer: job.buyer.address, provider: p.wallet.address, keeper: keeper.address, claim: job.claim, escrow: job.escrow },
    async () => send(keeper, [
      await facade.expireClaim({
        authority: keeper,
        task: job.task,
        worker: p.agent,
        rentRecipient: p.wallet.address,
        taskValidationConfig: job.validation,
        workerCompletionBond,
        treasury,
        creator: job.buyer.address,
      }),
    ]),
    async (b, txFee) => ({
      buyer: job.deposit,
      provider: b.claim - job.deposit,
      keeper: CLEANUP_REWARD - txFee,
      escrow: -CLEANUP_REWARD,
      claim: -b.claim,
    }));
  check(s, "keeper expire_claim after expiry and grace (deposit to the buyer)", "provider claims expired", expiredBefore + 1n, (await read(job.stats, sdk.getAgentStatsDecoder())).claimsExpired);
  const stats = await creatorStatsOf(job.buyer.address);
  const firstRecord = !(await exists(stats));
  const cancelled = await step(s, "buyer cancels (price back minus 1,000)", { buyer: job.buyer.address, escrow: job.escrow, creatorStats: stats },
    async () => send(job.buyer, [await facade.cancelTask({ task: job.task, authority: job.buyer, workerBondAuthority: p.wallet.address })]),
    async (b, txFee) => {
      const rent = firstRecord ? await rentFor(SIZE.creatorStats) : 0n;
      return { escrow: -b.escrow, creatorStats: rent, buyer: b.escrow - txFee - rent };
    });
  check(s, "buyer cancels (price back minus 1,000)", "escrow refunded: the price minus the 1,000 cleanup reward, plus its rent",
    p.price - CLEANUP_REWARD + (await rentFor(SIZE.escrow)), cancelled.before.escrow);
  check(s, "buyer cancels (price back minus 1,000)", "task status", sdk.TaskStatus.Cancelled, (await read(job.task, sdk.getTaskDecoder())).status);
}

// Scenario 7. Agent-to-agent hire (hire_from_listing v3).
async function scenario7() {
  const s = 7;
  const provider = await newProvider();
  const buyer = await funded(3n);
  const buyerAgent = await agent(buyer);
  const taskId = id32();
  const [task] = await sdk.findTaskPda({ creator: buyer.address, taskId });
  const [escrow] = await sdk.findEscrowPda({ task });
  const [hireRecord] = await sdk.findHireRecordPda({ task });
  const [validation] = await sdk.findTaskValidationConfigPda({ task });
  const [rateLimit] = await sdk.findAuthorityRateLimitPda({ authority: buyer.address });
  const firstLimit = !(await exists(rateLimit));
  const { version } = await read(provider.listing, sdk.getServiceListingDecoder());
  await step(s, "buyer agent hire_from_listing v3", { buyer: buyer.address, task, escrow, hireRecord, validation, rateLimit }, async () =>
    send(buyer, [
      await facade.hireFromListing({
        taskId,
        creator: buyer,
        authority: buyer,
        creatorAgent: buyerAgent,
        listing: provider.listing,
        providerAgent: provider.agent,
        expectedPrice: provider.price,
        expectedVersion: version,
        reviewWindowSecs: 3_600n,
        listingSpecHash: provider.spec,
        taskJobSpecHash: provider.spec,
        moderator: moderator.address,
      }),
    ]),
    async (_b, fee) => {
      const d = {
        task: await rentFor(SIZE.task),
        escrow: (await rentFor(SIZE.escrow)) + provider.price,
        hireRecord: await rentFor(SIZE.hire),
        validation: await rentFor(SIZE.validation),
        rateLimit: firstLimit ? await rentFor(SIZE.rateLimit) : 0n,
      };
      return { ...d, buyer: -(d.task + d.escrow + d.hireRecord + d.validation + d.rateLimit + fee) };
    });
  const review = await read(validation, sdk.getTaskValidationConfigDecoder());
  check(s, "buyer agent hire_from_listing v3", "review config mode", sdk.ValidationMode.CreatorReview, review.mode);
  const job = { s, provider, buyer, task, escrow, hireRecord, validation };
  await moderate(job);
  await publish(job);
  await claim(job);
  await refusedStep(s, "complete_task on an agent hire", { provider: provider.wallet.address, escrow, claim: job.claim }, "provider", provider.wallet,
    [await facade.completeTask({ task, creator: buyer.address, worker: provider.agent, treasury, authority: provider.wallet, hireRecord, proofHash: id32(), resultData: null })],
    sdk.AGENC_COORDINATION_ERROR__MANUAL_VALIDATION_REQUIRES_REVIEW_FLOW);
  await submit(job);
  await step(s, "buyer agent asks for changes", { buyer: buyer.address, submission: job.submission, claim: job.claim }, async () =>
    send(buyer, [await facade.requestChanges({ task, claim: job.claim, creator: buyer, changesHash: id32() })]),
    async (_b, fee) => ({ buyer: -fee }));
  await submit(job, "resubmit");
  const fee = fee5(provider.price);
  await step(s, "accept after the resubmission",
    { provider: provider.wallet.address, buyer: buyer.address, treasury, escrow, claim: job.claim, submission: job.submission },
    async () => send(buyer, [await facade.acceptTaskResult({ task, worker: provider.agent, creator: buyer, treasury, workerAuthority: provider.wallet.address })]),
    async (b, txFee) => ({
      provider: provider.price - fee + b.claim + b.submission,
      treasury: fee,
      buyer: b.escrow - provider.price - txFee,
      escrow: -b.escrow,
      claim: -b.claim,
      submission: -b.submission,
    }));
  check(s, "accept after the resubmission", "task status", sdk.TaskStatus.Completed, (await read(task, sdk.getTaskDecoder())).status);
}

// Scenario 8. The multisig moderation switch, the heartbeat, a roster
// attestor, and suspend and unsuspend.
async function scenario8() {
  const s = 8;
  const [moderationConfig] = await sdk.findModerationConfigPda();
  const configure = (enabled, signers) =>
    facade.configureTaskModeration({ authority: owner.a, moderationAuthority: moderator.address, enabled, multisigSigners: signers });
  const enabled = async () => (await read(moderationConfig, sdk.getModerationConfigDecoder())).enabled;
  const provider = await newProvider();
  const buyer = await funded(3n);
  await refusedStep(s, "one-signer configure_task_moderation(enabled=false)", { ownerA: owner.a.address }, "ownerA", owner.a,
    [await configure(false, [owner.a])], sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS);
  check(s, "one-signer configure_task_moderation(enabled=false)", "moderation still enabled", true, await enabled());
  let disabled = false;
  try {
    await step(s, "2-of-3 disables moderation", { ownerA: owner.a.address }, async () => {
      const fee = await send(owner.a, [await configure(false, [owner.a, owner.b])]);
      disabled = true;
      return fee;
    }, async (_b, fee) => ({ ownerA: -fee }));
    check(s, "2-of-3 disables moderation", "enabled", false, await enabled());
    const { version } = await read(provider.listing, sdk.getServiceListingDecoder());
    await refusedStep(s, "a hire while moderation is off", { buyer: buyer.address }, "buyer", buyer, [
      await facade.hireFromListingHumanless({
        taskId: id32(),
        creator: buyer,
        listing: provider.listing,
        providerAgent: provider.agent,
        expectedPrice: provider.price,
        expectedVersion: version,
        reviewWindowSecs: 3_600n,
        listingSpecHash: provider.spec,
        taskJobSpecHash: provider.spec,
        moderator: moderator.address,
      }),
    ], sdk.AGENC_COORDINATION_ERROR__TASK_MODERATION_REQUIRED);
    await step(s, "2-of-3 re-enables moderation", { ownerA: owner.a.address }, async () => {
      const fee = await send(owner.a, [await configure(true, [owner.a, owner.c])]);
      disabled = false;
      return fee;
    }, async (_b, fee) => ({ ownerA: -fee }));
    check(s, "2-of-3 re-enables moderation", "enabled", true, await enabled());
  } finally {
    if (disabled) await send(owner.a, [await configure(true, [owner.a, owner.b])]);
  }
  await hire(s, provider, buyer, { name: "a hire works again" });
  // A heartbeat by the attestor key (the moderation authority).
  const before = await read(moderationConfig, sdk.getModerationConfigDecoder());
  // Let the clock pass the last update, so a moved heartbeat is visible.
  const at = await waitClock(before.updatedAt, "S8 heartbeat");
  await step(s, "heartbeat by the attestor key", { moderator: moderator.address }, async () =>
    send(moderator, [await facade.moderationHeartbeat({ authority: moderator, newWindowSecs: null })]),
    async (_b, fee) => ({ moderator: -fee }));
  const after = await read(moderationConfig, sdk.getModerationConfigDecoder());
  check(s, "heartbeat by the attestor key", "heartbeat time moved up to the cluster clock", true, after.updatedAt >= at && after.updatedAt > before.updatedAt);
  // A roster attestor, assigned by 2 of 3, records a hire's safety check.
  const attestor = await funded(1n);
  const [rosterEntry] = await facade.findModerationAttestorPda({ attestor: attestor.address });
  await refusedStep(s, "one-signer assign_moderation_attestor", { ownerA: owner.a.address }, "ownerA", owner.a,
    [await facade.assignModerationAttestor({ authority: owner.a, attestor: attestor.address, multisigSigners: [owner.a] })],
    sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS);
  await step(s, "2-of-3 assigns a roster attestor", { ownerA: owner.a.address, rosterEntry }, async () =>
    send(owner.a, [await facade.assignModerationAttestor({ authority: owner.a, attestor: attestor.address, multisigSigners: [owner.a, owner.b] })]),
    async (_b, fee) => {
      const rent = await rentFor(await dataLength(rosterEntry));
      return { rosterEntry: rent, ownerA: -(rent + fee) };
    });
  const rosterProvider = await newProvider({ attestor, roster: true });
  const rosterJob = await hire(s, rosterProvider, await funded(3n), { attestor, roster: true, name: "hire attested by the roster attestor" });
  await moderate(rosterJob, { attestor, roster: true });
  await publish(rosterJob);
  await claim(rosterJob);
  // Suspend and unsuspend with 2 of 3.
  const target = await newProvider();
  const status = async () => (await read(target.agent, sdk.getAgentRegistrationDecoder())).status;
  await refusedStep(s, "one-signer suspend", { ownerA: owner.a.address }, "ownerA", owner.a,
    [await facade.suspendAgent({ agent: target.agent, authority: owner.a, multisigSigners: [owner.a] })],
    sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS);
  await step(s, "2-of-3 suspend", { ownerA: owner.a.address, agent: target.agent }, async () =>
    send(owner.a, [await facade.suspendAgent({ agent: target.agent, authority: owner.a, multisigSigners: [owner.a, owner.c] })]),
    async (_b, fee) => ({ ownerA: -fee }));
  check(s, "2-of-3 suspend", "status", sdk.AgentStatus.Suspended, await status());
  await refusedStep(s, "one-signer unsuspend", { ownerB: owner.b.address }, "ownerB", owner.b,
    [await facade.unsuspendAgent({ agent: target.agent, authority: owner.b, multisigSigners: [owner.b] })],
    sdk.AGENC_COORDINATION_ERROR__MULTISIG_NOT_ENOUGH_SIGNERS);
  await step(s, "2-of-3 unsuspend", { ownerB: owner.b.address, agent: target.agent }, async () =>
    send(owner.b, [await facade.unsuspendAgent({ agent: target.agent, authority: owner.b, multisigSigners: [owner.b, owner.c] })]),
    async (_b, fee) => ({ ownerB: -fee }));
  check(s, "2-of-3 unsuspend", "status (back to Inactive)", sdk.AgentStatus.Inactive, await status());
}

// -------------------------------------------------------------------- run
const started = new Date().toISOString();
const errors = [];
async function attempt(n, label, run) {
  console.log(`\n=== scenario ${n}: ${label} ===`);
  try {
    return await run();
  } catch (error) {
    errors.push({ scenario: n, step: label, error: String(error?.stack ?? error) });
    console.log(`FAIL S${n} ${label}: ${error?.stack ?? error}`);
    return undefined;
  } finally {
    maybeCompact();
  }
}
// Scenario 6 starts first (its claim needs about an hour); scenarios 2 and 4
// leave their windows running while the others go.
const s6 = wanted(6) ? await attempt(6, "no-show, hire and claim", scenario6a) : undefined;
const s2 = wanted(2) ? await attempt(2, "turn-down, hire to freeze", scenario2a) : undefined;
const s4 = wanted(4) ? await attempt(4, "turn-down, upheld, and one disputed", scenario4a) : undefined;
if (wanted(1)) await attempt(1, "Desktop hire", scenario1);
if (wanted(3)) await attempt(3, "turn-down, ruled for the provider", scenario3);
if (wanted(5)) await attempt(5, "ruled task dispute", scenario5);
if (wanted(7)) await attempt(7, "agent-to-agent hire", scenario7);
if (wanted(8)) await attempt(8, "multisig moderation switch", scenario8);
if (s2 && !noWait) await attempt(2, "turn-down, keeper expiry", () => scenario2b(s2));
if (s4 && !noWait) await attempt(4, "turn-down, unruled expiry", () => scenario4b(s4));
if (s6 && !noWait) await attempt(6, "no-show, expiry and cancel", () => scenario6b(s6));

const failing = rows.filter((row) => !row.pass);
const report = {
  started,
  finished: new Date().toISOString(),
  rpcUrl: env.rpcUrl,
  programProfile: env.programProfile ?? null,
  programSha256: env.programSha256 ?? null,
  compactions,
  checks: rows.length,
  failing: failing.length,
  errors,
  rows,
};
if (reportPath !== null) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (markdownPath !== null) {
  const lines = [
    "# Revision 9 localnet scenarios",
    "",
    `Program ${env.programProfile ?? "unknown"} build, sha256 ${env.programSha256 ?? "unknown"}. Run ${started} to ${report.finished}.`,
    `${rows.length} checks, ${failing.length} failing, ${errors.length} scenario errors, ${compactions} ledger compactions.`,
    "",
  ];
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const own = rows.filter((row) => row.scenario === n);
    if (own.length === 0 && !errors.some((e) => e.scenario === n)) continue;
    lines.push(`## Scenario ${n}`, "", "| Step | Check | Expected | Actual | Result |", "|---|---|---|---|---|");
    for (const row of own) {
      lines.push(`| ${row.step} | ${row.label} | ${row.expected} | ${row.actual} | ${row.pass ? "pass" : "FAIL"} |`);
    }
    for (const e of errors.filter((x) => x.scenario === n)) {
      lines.push(`| ${e.step} | error | | ${e.error.split("\n")[0].replaceAll("|", "/")} | FAIL |`);
    }
    lines.push("");
  }
  writeFileSync(markdownPath, `${lines.join("\n")}\n`);
}
console.log(`\n${rows.length} checks, ${rows.length - failing.length} pass, ${failing.length} failing, ${errors.length} scenario errors`);
process.exit(failing.length === 0 && errors.length === 0 ? 0 : 1);
