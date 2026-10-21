import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  parseRepairArgs,
  deriveExpireAccounts,
  selectPendingDispute,
  selectRepairOwners,
  readRepairState,
  runPreparePhase,
  runRepairPhase,
  repairReceiptPda,
  assertRepairIdlBinding,
  assertRepairExecutableBinding,
} from "./mainnet-repair-dispute-counter.mjs";
import {
  PROGRAM_ID,
  MAINNET_GENESIS,
  decodeDispute,
  decodeTaskBinding,
  decodeAgentBinding,
} from "./preflight-dispute-scan.mjs";
import {
  anchor,
  web3,
  idl,
  historicalFixture,
  pda,
} from "./test-fixtures/dispute-counter-repair.mjs";
const { PublicKey, Connection, Keypair } = web3;
function mock(fixture) {
  const accounts = new Map(
    fixture.accounts.map((item) => [
      String(item.pubkey),
      {
        owner: PROGRAM_ID,
        lamports: item.lamports,
        executable: false,
        data: Buffer.from(item.data),
      },
    ]),
  );
  const simulations = [];
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getAccountInfo: async (key) => accounts.get(String(key)) ?? null,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 5,
    isBlockhashValid: async () => ({ value: true }),
    simulateTransaction: async (transaction, options) => {
      assert.equal(options.sigVerify, false);
      assert.equal(options.replaceRecentBlockhash, true);
      assert.ok(
        transaction.signatures.every((signature) =>
          Buffer.from(signature).every((byte) => byte === 0),
        ),
      );
      simulations.push(transaction);
      return {
        context: { slot: 5 },
        value: { err: null, unitsConsumed: 1000 },
      };
    },
    sendRawTransaction: () => {
      throw new Error("PLAN must never broadcast");
    },
  };
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(
      new Connection("http://rpc.invalid"),
      new anchor.Wallet(fixture.authority),
      {},
    ),
  );
  return {
    accounts,
    simulations,
    connection,
    program,
    guard: async () => ({ contextSlot: 1 }),
    log: () => {},
  };
}
function prepareFixture(fixture) {
  for (const item of fixture.accounts) {
    if (fixture.disputes.some((d) => d.pubkey.equals(item.pubkey))) {
      item.data[169] = 2;
      item.data.writeBigInt64LE(100n, 178);
      item.data[220] = Number(
        String(item.pubkey) === fixture.record.siblingDisputes[0].dispute,
      );
    }
    if (item.pubkey.equals(fixture.agent)) {
      item.data[160] = 0;
      item.data[177] = 0;
    }
  }
}
test("arguments default to unsigned repair PLAN and require exact execute syntax", () => {
  assert.deepEqual(parseRepairArgs([]), {
    phase: "repair",
    execute: false,
    confirm: null,
    help: false,
  });
  assert.equal(parseRepairArgs(["--phase", "prepare"]).phase, "prepare");
  assert.equal(
    parseRepairArgs(["--execute", "--confirm", "incident"]).execute,
    true,
  );
  for (const args of [
    ["--execute"],
    ["--phase"],
    ["--phase", "devnet"],
    ["--wallet", "[1]"],
    ["--confirm", "incident"],
    ["--execute", "--execute"],
    ["--rpc", "url"],
  ]) {
    assert.throws(() => parseRepairArgs(args));
  }
});
test("IDL binding requires approved digest, program and canonical instruction ABI", () => {
  const bytes = Buffer.from(JSON.stringify(idl));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(assertRepairIdlBinding(bytes, hash).address, String(PROGRAM_ID));
  assert.throws(() => assertRepairIdlBinding(bytes), /EXPECTED_IDL_SHA256/);
  for (const change of [
    (copy) => (copy.address = PublicKey.default.toBase58()),
    (copy) =>
      (copy.instructions = copy.instructions.filter(
        (ix) => ix.name !== "repair_dispute_initiator_counter",
      )),
  ]) {
    const copy = structuredClone(idl);
    change(copy);
    const changed = Buffer.from(JSON.stringify(copy));
    assert.throws(
      () =>
        assertRepairIdlBinding(
          changed,
          createHash("sha256").update(changed).digest("hex"),
        ),
      /mismatch/,
    );
  }
});
test("expiry derives complete canonical accounts, optional evidence, dependency and bid suffix", async () => {
  const f = await historicalFixture();
  const dispute = {
    ...decodeDispute(
      f.accounts.find((a) => a.pubkey.equals(f.disputes[0].pubkey)).data,
    ),
    pubkey: f.disputes[0].pubkey,
  };
  const task = decodeTaskBinding(
    f.accounts.find((a) => a.pubkey.equals(dispute.task)).data,
  );
  const worker = decodeAgentBinding(f.deficientAgentData);
  const base = { dispute, task, worker, authority: f.authority.publicKey };
  const result = deriveExpireAccounts(base);
  assert.equal(String(result.accounts.workerClaim), f.record.incident.claim);
  assert.equal(
    String(result.accounts.creatorCompletionBond),
    String(pda("completion_bond", dispute.task, task.creator)[0]),
  );
  assert.equal(
    String(result.accounts.workerCompletionBond),
    String(pda("completion_bond", dispute.task, worker.authority)[0]),
  );
  assert.equal(
    String(result.accounts.taskSubmission),
    String(pda("task_submission", result.accounts.workerClaim)[0]),
  );
  assert.equal(result.accounts.taskValidationConfig, null);
  assert.equal(
    deriveExpireAccounts({
      ...base,
      validationRequired: true,
    }).accounts.taskValidationConfig.toBase58(),
    pda("task_validation", dispute.task)[0].toBase58(),
  );
  const parent = Keypair.generate().publicKey;
  const bid = deriveExpireAccounts({
    ...base,
    task: { ...task, taskType: 3, dependencyType: 2, dependsOn: parent },
  });
  assert.deepEqual(
    bid.remaining.map((meta) => String(meta.pubkey)),
    [
      parent,
      pda("bid_book", dispute.task)[0],
      pda("bid", dispute.task, dispute.defendant)[0],
      pda("bidder_market", dispute.defendant)[0],
    ].map(String),
  );
  assert.deepEqual(
    bid.remaining.map((meta) => meta.isWritable),
    [false, true, true, true],
  );
  for (const fields of [
    { currentWorkers: 2 },
    { taskType: 1 },
    { rewardMint: parent },
    { dependencyType: 1 },
    { dependsOn: parent },
    { escrow: parent },
    { status: 3 },
  ]) {
    assert.throws(() =>
      deriveExpireAccounts({ ...base, task: { ...task, ...fields } }),
    );
  }
});
test("pending selector refuses Active, SettlementPending, non-recorded and ambiguous outcomes", async () => {
  const f = await historicalFixture();
  prepareFixture(f);
  const m = mock(f);
  const state = await readRepairState({ ...m, record: f.record });
  assert.equal(
    String(selectPendingDispute(f.record, state.disputes).pubkey),
    f.record.incident.dispute,
  );
  for (const change of [
    (ds) => (ds[0].status = 0),
    (ds) => (ds[0].status = 4),
    (ds) => (ds[0].totalVoters = 0),
    (ds) => (ds[0].resolvedAt = 0n),
    (ds) => (ds[0].pubkey = PublicKey.default),
    (ds) => (ds[0].initiator = PublicKey.default),
    (ds) => (ds[1].initiatorSlashApplied = false),
    (ds) => (ds[0].initiatorSlashApplied = true),
  ]) {
    const ds = state.disputes.map((d) => ({ ...d }));
    change(ds);
    assert.throws(() => selectPendingDispute(f.record, ds));
  }
});
test("multisig requires authority and distinct configured owner threshold", async () => {
  const f = await historicalFixture();
  const m = mock(f);
  const { config } = await readRepairState({ ...m, record: f.record });
  const metas = selectRepairOwners(config, f.authority, [f.cosigner]);
  assert.equal(metas.length, 2);
  assert.ok(metas.every((meta) => meta.isSigner && !meta.isWritable));
  assert.throws(
    () => selectRepairOwners(config, f.authority, []),
    /distinct owners/,
  );
  assert.throws(
    () => selectRepairOwners(config, f.authority, [f.authority]),
    /duplicate/,
  );
  assert.throws(
    () => selectRepairOwners(config, f.authority, [Keypair.generate()]),
    /not a current/,
  );
  assert.throws(
    () => selectRepairOwners(config, f.cosigner, [f.authority]),
    /AUTHORITY_KEYPAIR/,
  );
});
test("prepare PLAN simulates each expiry unsigned and defers state-dependent finalization", async () => {
  const f = await historicalFixture();
  const m = mock(f);
  const result = await runPreparePhase({
    ...m,
    record: f.record,
    payer: f.authority,
  });
  assert.equal(m.simulations.length, 2);
  assert.equal(result.finalizerDeferred, true);
  assert.ok(result.results.every((r) => r.signature === null));
  assert.equal(
    decodeAgentBinding(m.accounts.get(String(f.agent)).data)
      .pendingInitiatorOutcomes,
    1,
  );
});
test("repair PLAN reviews one atomic repair/finalizer message without signing", async () => {
  const f = await historicalFixture();
  prepareFixture(f);
  const m = mock(f);
  const result = await runRepairPhase({
    ...m,
    record: f.record,
    authority: f.authority,
    cosigners: [f.cosigner],
  });
  assert.equal(m.simulations.length, 1);
  assert.equal(result.signature, null);
  assert.deepEqual(
    result.review.instructions.map((ix) => ix.name),
    ["repair_dispute_initiator_counter", "apply_initiator_slash"],
  );
});
test("repair refuses counter mismatch, an existing receipt, and unpaused config before simulation", async () => {
  for (const mutate of [
    (m, f) => (m.accounts.get(String(f.agent)).data[160] = 1),
    (m, f) => (m.accounts.get(String(f.agent)).data[177] = 1),
    (m, f) =>
      m.accounts.set(String(repairReceiptPda(f.record.incident.dispute)), {
        lamports: 1,
      }),
  ]) {
    const f = await historicalFixture();
    prepareFixture(f);
    const m = mock(f);
    mutate(m, f);
    await assert.rejects(
      runRepairPhase({
        ...m,
        record: f.record,
        authority: f.authority,
        cosigners: [f.cosigner],
      }),
    );
    assert.equal(m.simulations.length, 0);
  }
  const f = await historicalFixture();
  const m = mock(f);
  const data = await new anchor.BorshCoder(idl).accounts.encode(
    "ProtocolConfig",
    { ...f.config, protocol_paused: false },
  );
  m.accounts.get(String(pda("protocol")[0])).data = data;
  await assert.rejects(
    runPreparePhase({ ...m, record: f.record, payer: f.authority }),
    /protocol_paused/,
  );
});

test("standalone CLI handles its own flags without importing another rail's parser", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL(
    "./mainnet-repair-dispute-counter.mjs",
    import.meta.url,
  );
  const help = spawnSync(process.execPath, [script.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:.*mainnet-repair-dispute-counter/);
  const rejected = spawnSync(
    process.execPath,
    [script.pathname, "--phase", "prepare", "--execute"],
    { encoding: "utf8" },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--execute requires --confirm/);
});

test("executable binding pins mainnet, program, policy, approved SBF and zero padding", () => {
  const binaryBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]);
  const expectedSoSha256 = createHash("sha256")
    .update(binaryBytes)
    .digest("hex");
  const policy = {
    genesisHash: MAINNET_GENESIS,
    programId: String(PROGRAM_ID),
    expectedProgramData: String(Keypair.generate().publicKey),
    loaderProgramId: "BPFLoaderUpgradeab1e11111111111111111111111",
    policySha256: "1".repeat(64),
  };
  const snapshot = {
    programId: policy.programId,
    programData: policy.expectedProgramData,
    loaderProgramId: policy.loaderProgramId,
    policySha256: policy.policySha256,
    stateDigest: "2".repeat(64),
    payload: Buffer.concat([binaryBytes, Buffer.alloc(10)]),
    contextSlot: 1,
  };
  const input = {
    genesisHash: MAINNET_GENESIS,
    policy,
    snapshot,
    binaryBytes,
    expectedSoSha256,
  };
  assert.equal(
    assertRepairExecutableBinding(input).actualSha256,
    expectedSoSha256,
  );
  for (const changed of [
    { genesisHash: "local" },
    { policy: { ...policy, programId: String(PublicKey.default) } },
    { policy: { ...policy, genesisHash: "local" } },
    { expectedSoSha256: undefined },
    { expectedSoSha256: "0".repeat(64) },
    { snapshot: { ...snapshot, policySha256: "0".repeat(64) } },
    {
      snapshot: {
        ...snapshot,
        payload: Buffer.concat([binaryBytes, Buffer.from([1])]),
      },
    },
    { snapshot: { ...snapshot, payload: Buffer.alloc(15) } },
  ])
    assert.throws(() =>
      assertRepairExecutableBinding({ ...input, ...changed }),
    );
});
