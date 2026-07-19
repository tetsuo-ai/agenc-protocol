// litesvm integration tests for the protocol admin / config instructions of
// agenc-coordination. Covers the multisig-gated protocol-config mutators
// (update_protocol_fee, update_treasury, update_rate_limits, update_multisig,
// update_min_version), the per-agent update_state, and the release-disabled
// ZK-config activation/rotation instructions.
//
// Mirrors the style of marketplace.test.mjs and reuses the shared harness.
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, makeProgram, send, expectOk, expectFail, decode,
  pda, enc, arr, id32, setMultisig, setMinAgentStake,
  BN, Keypair, PublicKey, SystemProgram,
  coder, PID,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Shared helpers (local to this file — harness helpers are not all exported)
// ---------------------------------------------------------------------------

// Stand up a real 2-of-N multisig over the live ProtocolConfig. Returns the
// extra owner keypair plus the AccountMeta list to pass as remainingAccounts
// and the signer list to sign the tx with.
function twoOfTwoMultisig(w) {
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  return { owner2, signerMetas, signers: [w.admin, owner2] };
}

// Force-set min_supported_version on the live ProtocolConfig in place so a
// positive update_min_version can demonstrate a real 0 -> 1 transition (the
// injected default already sits at the only otherwise-valid value, 1).
async function setMinSupportedVersion(svm, value) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.min_supported_version = value;
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, {
    lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0,
  });
}

// ---------------------------------------------------------------------------
// update_protocol_fee (multisig gated)
// ---------------------------------------------------------------------------

test("update_protocol_fee: 2-of-2 multisig sets the fee; single signer rejected; 2000 bps (20%) cap accepted, >2000 rejected", async () => {
  const w = await freshWorld();
  const { signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);

  const before = decode(w.svm, "ProtocolConfig", w.protocolPda).protocol_fee_bps;
  assert.equal(before, 100, "harness injects fee=100");

  const feeIx = (bps, metas) => makeProgram(w.admin).methods
    .updateProtocolFee(bps)
    .accounts({ protocolConfig: w.protocolPda, authority: w.admin.publicKey })
    .remainingAccounts(metas)
    .instruction();

  // NEGATIVE: a single signer cannot satisfy the 2-of-2 gate.
  expectFail(
    send(w.svm, await feeIx(250, [signerMetas[0]]), [w.admin]),
    "MultisigNotEnoughSigners",
    "update_protocol_fee single signer rejected",
  );

  // NEGATIVE: fee above the 2000 bps (20%) cap is rejected even with full multisig.
  expectFail(
    send(w.svm, await feeIx(2001, signerMetas), signers),
    "InvalidProtocolFee",
    "update_protocol_fee >2000 bps rejected",
  );

  // POSITIVE: the 2000 bps (20%) cap itself is accepted (the raised MAX_PROTOCOL_FEE_BPS).
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await feeIx(2000, signerMetas), signers), "update_protocol_fee at 20% cap ok");
  assert.equal(
    decode(w.svm, "ProtocolConfig", w.protocolPda).protocol_fee_bps, 2000,
    "protocol_fee_bps set to the 2000 bps (20%) cap",
  );

  // POSITIVE: full multisig changes the on-chain fee.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await feeIx(250, signerMetas), signers), "update_protocol_fee ok");
  assert.equal(
    decode(w.svm, "ProtocolConfig", w.protocolPda).protocol_fee_bps, 250,
    "protocol_fee_bps changed to 250",
  );
});

// ---------------------------------------------------------------------------
// update_treasury (multisig gated)
// ---------------------------------------------------------------------------

test("update_treasury: 2-of-2 multisig rotates treasury to a system-owned signer; single signer rejected", async () => {
  const w = await freshWorld();
  const { signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);

  // A fresh system-owned account that co-signs is an accepted treasury target
  // (is_system_owned_signer branch in the handler).
  const newTreasury = Keypair.generate();
  w.svm.airdrop(newTreasury.publicKey, BigInt(1e9));

  const oldTreasury = decode(w.svm, "ProtocolConfig", w.protocolPda).treasury;

  const treasuryIx = (metas) => makeProgram(w.admin).methods
    .updateTreasury()
    .accounts({
      protocolConfig: w.protocolPda,
      newTreasury: newTreasury.publicKey,
      authority: w.admin.publicKey,
    })
    .remainingAccounts(metas)
    .instruction();

  // NEGATIVE: single signer cannot satisfy the gate (newTreasury must also sign).
  expectFail(
    send(w.svm, await treasuryIx([signerMetas[0]]), [w.admin, newTreasury]),
    "MultisigNotEnoughSigners",
    "update_treasury single signer rejected",
  );

  // POSITIVE: full multisig + the new treasury signs -> treasury rotates.
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await treasuryIx(signerMetas), [...signers, newTreasury]),
    "update_treasury ok",
  );
  const after = decode(w.svm, "ProtocolConfig", w.protocolPda).treasury;
  assert.ok(!after.equals(oldTreasury), "treasury actually changed");
  assert.ok(after.equals(newTreasury.publicKey), "treasury == new system-owned signer");
});

// ---------------------------------------------------------------------------
// update_rate_limits (multisig gated)
// ---------------------------------------------------------------------------

test("update_rate_limits: 2-of-2 multisig sets new limits; below-minimum cooldown rejected", async () => {
  const w = await freshWorld();
  const { signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);
  // The dispute floor is now registration-relative as well as absolutely
  // bounded. Give this config a coherent registration floor so the test reaches
  // the cooldown guard it is intended to exercise.
  await setMinAgentStake(w.svm, 5_000);

  const limitsIx = (args, metas) => makeProgram(w.admin).methods
    .updateRateLimits(
      new BN(args.taskCooldown),
      args.maxTasks,
      new BN(args.disputeCooldown),
      args.maxDisputes,
      new BN(args.minDisputeStake),
    )
    .accounts({ protocolConfig: w.protocolPda, authority: w.admin.publicKey })
    .remainingAccounts(metas)
    .instruction();

  // NEGATIVE: task_creation_cooldown = 0 trips the >= 1 minimum guard.
  expectFail(
    send(w.svm, await limitsIx(
      { taskCooldown: 0, maxTasks: 10, disputeCooldown: 60, maxDisputes: 5, minDisputeStake: 5000 },
      signerMetas,
    ), signers),
    "RateLimitBelowMinimum",
    "update_rate_limits zero cooldown rejected",
  );

  // POSITIVE: a valid set of limits is written to the config.
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await limitsIx(
      { taskCooldown: 120, maxTasks: 7, disputeCooldown: 300, maxDisputes: 3, minDisputeStake: 5000 },
      signerMetas,
    ), signers),
    "update_rate_limits ok",
  );
  const cfg = decode(w.svm, "ProtocolConfig", w.protocolPda);
  assert.equal(Number(cfg.task_creation_cooldown), 120, "task_creation_cooldown set");
  assert.equal(cfg.max_tasks_per_24h, 7, "max_tasks_per_24h set");
  assert.equal(Number(cfg.dispute_initiation_cooldown), 300, "dispute_initiation_cooldown set");
  assert.equal(cfg.max_disputes_per_24h, 3, "max_disputes_per_24h set");
  assert.equal(Number(cfg.min_stake_for_dispute), 5000, "min_stake_for_dispute set");
});

// ---------------------------------------------------------------------------
// update_multisig (multisig gated)
// ---------------------------------------------------------------------------

test("update_multisig: 2-of-2 rotates to a 2-of-3 owner set; single signer rejected", async () => {
  const w = await freshWorld();
  const { owner2, signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);

  // New 3-owner set; threshold 2 (< owner count, as the handler requires). The
  // current signers (admin + owner2) are members of the new set so the extra
  // new-set-approval guard is satisfied too.
  const owner3 = Keypair.generate();
  const newOwners = [w.admin.publicKey, owner2.publicKey, owner3.publicKey];

  const multisigIx = (threshold, owners, metas) => makeProgram(w.admin).methods
    .updateMultisig(threshold, owners)
    .accounts({ protocolConfig: w.protocolPda, authority: w.admin.publicKey })
    .remainingAccounts(metas)
    .instruction();

  // NEGATIVE: a single current signer cannot authorize the rotation.
  expectFail(
    send(w.svm, await multisigIx(2, newOwners, [signerMetas[0]]), [w.admin]),
    "MultisigNotEnoughSigners",
    "update_multisig single signer rejected",
  );

  // POSITIVE: full current multisig rotates the owner set + threshold.
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await multisigIx(2, newOwners, signerMetas), signers),
    "update_multisig ok",
  );
  const cfg = decode(w.svm, "ProtocolConfig", w.protocolPda);
  assert.equal(cfg.multisig_owners_len, 3, "owner count updated to 3");
  assert.equal(cfg.multisig_threshold, 2, "threshold updated to 2");
  assert.ok(cfg.multisig_owners[2].equals(owner3.publicKey), "owner3 stored in slot 2");
});

test("update_multisig (adversarial review): rotating the protocol authority OUT of the owner set stays ALLOWED", async () => {
  // The F-18 authority-membership require was REVERTED: on mainnet the authority is
  // a Squads vault PDA, which can never satisfy require_multisig_threshold
  // (owner-signers must be system-owned), so the require forced a dead PDA into
  // every future owner set and broke the operators' rotation construction. It also
  // protected nothing — the authority field is immutable by design, so its power
  // never depended on owner membership. This test pins the reverted behavior:
  // an owner set that excludes the authority (with enough new-set signers) rotates fine.
  const w = await freshWorld();
  const { owner2, signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);

  const owner3 = Keypair.generate();
  const owner4 = Keypair.generate();
  for (const kp of [owner3, owner4]) w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const newOwners = [owner2.publicKey, owner3.publicKey, owner4.publicKey];
  const allSigners = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner3.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner4.publicKey, isSigner: true, isWritable: false },
  ];

  expectOk(
    send(w.svm, await makeProgram(w.admin).methods
      .updateMultisig(2, newOwners)
      .accounts({ protocolConfig: w.protocolPda, authority: w.admin.publicKey })
      .remainingAccounts(allSigners)
      .instruction(), [w.admin, owner2, owner3, owner4]),
    "rotation excluding the authority succeeds (post-revert behavior)",
  );
  const cfg = decode(w.svm, "ProtocolConfig", w.protocolPda);
  assert.equal(cfg.multisig_owners_len, 3, "owner set rotated");
  assert.ok(cfg.multisig_owners[0].equals(owner2.publicKey), "new set stored");
});

// ---------------------------------------------------------------------------
// update_min_version (multisig gated)
// ---------------------------------------------------------------------------

test("update_min_version: 2-of-2 multisig raises min_supported_version 0 -> 1; rollback rejected; single signer rejected", async () => {
  const w = await freshWorld();
  const { signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);
  // Lower the baseline so a real upward transition can be observed.
  await setMinSupportedVersion(w.svm, 0);

  const minVerIx = (v, metas) => makeProgram(w.admin).methods
    .updateMinVersion(v)
    .accounts({ protocolConfig: w.protocolPda, authority: w.admin.publicKey })
    .remainingAccounts(metas)
    .instruction();

  // NEGATIVE: single signer cannot satisfy the gate.
  expectFail(
    send(w.svm, await minVerIx(1, [signerMetas[0]]), [w.admin]),
    "MultisigNotEnoughSigners",
    "update_min_version single signer rejected",
  );

  // POSITIVE: full multisig raises min_supported_version from 0 to 1.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await minVerIx(1, signerMetas), signers), "update_min_version ok");
  assert.equal(
    decode(w.svm, "ProtocolConfig", w.protocolPda).min_supported_version, 1,
    "min_supported_version raised to 1",
  );

  // NEGATIVE: rollback (1 -> 0) is below MIN_SUPPORTED_VERSION (1), which the
  // handler rejects with InvalidMigrationTarget before reaching the monotonic
  // guard.
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await minVerIx(0, signerMetas), signers),
    "InvalidMigrationTarget",
    "update_min_version rollback rejected",
  );
});

// ---------------------------------------------------------------------------
// update_state (per-agent, NOT multisig)
// ---------------------------------------------------------------------------

test("update_state: agent authority writes namespaced state; wrong authority rejected; version mismatch rejected", async () => {
  const w = await freshWorld();
  // The provider agent (registered in the harness) is owned by w.provider.
  const stateKey = id32();
  const [statePda] = pda([enc("state"), w.provider.publicKey.toBuffer(), stateKey]);
  const stateValue = Buffer.alloc(64, 7); // non-zero

  const stateIx = (signerKp, statePdaArg, agentPda, key, value, version) => makeProgram(signerKp).methods
    .updateState(arr(key), arr(value), new BN(version))
    .accounts({
      state: statePdaArg,
      agent: agentPda,
      authority: signerKp.publicKey,
      protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // NEGATIVE: an agent owned by a different authority cannot write state — the
  // agent's has_one = authority fails. The buyer signs and uses a state PDA
  // seeded with the buyer's own key (so the ConstraintSeeds check passes) but
  // passes the provider's agent (owned by w.provider, not the buyer).
  const [buyerStatePda] = pda([enc("state"), w.buyer.publicKey.toBuffer(), stateKey]);
  expectFail(
    send(w.svm, await stateIx(w.buyer, buyerStatePda, w.providerAgent, stateKey, stateValue, 0), [w.buyer]),
    "UnauthorizedAgent",
    "update_state wrong authority rejected",
  );

  // NEGATIVE: optimistic-lock check — expecting version 1 on a brand-new (v0)
  // state fails with VersionMismatch.
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await stateIx(w.provider, statePda, w.providerAgent, stateKey, stateValue, 1), [w.provider]),
    "VersionMismatch",
    "update_state version mismatch rejected",
  );

  // POSITIVE: the owning authority creates the state (v0 -> v1) and the value
  // is persisted.
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await stateIx(w.provider, statePda, w.providerAgent, stateKey, stateValue, 0), [w.provider]),
    "update_state create ok",
  );
  const st = decode(w.svm, "CoordinationState", statePda);
  assert.equal(Number(st.version), 1, "version incremented to 1");
  assert.ok(Buffer.from(st.state_value).equals(stateValue), "state_value persisted");
  assert.ok(st.owner.equals(w.provider.publicKey), "owner set to authority");
});

test("production release excludes every private-ZK entrypoint", async () => {
  const w = await freshWorld();
  const methods = makeProgram(w.admin).methods;
  assert.equal(methods.initializeZkConfig, undefined, "ZK trust-root initialization is absent");
  assert.equal(methods.updateZkImageId, undefined, "ZK trust-root rotation is absent");
  assert.equal(methods.completeTaskPrivate, undefined, "private settlement is absent");
});
