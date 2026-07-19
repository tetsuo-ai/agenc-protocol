// Security regression tests for the retired reputation-delegation entry point.
// New delegations are disabled because the account never benefited the delegatee;
// it only sheltered the delegator's reputation from slashing. The legacy revoke
// path remains available only as a permissionless, no-restore retirement purge.

import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld,
  makeProgram,
  send,
  expectOk,
  expectFail,
  decode,
  isClosed,
  pda,
  enc,
  arr,
  id32,
  coder,
  PID,
  BN,
  Keypair,
  SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const PROBATIONARY_REPUTATION = 3000;

const lamports = (svm, address) => {
  const account = svm.getAccount(address);
  return account ? BigInt(account.lamports) : 0n;
};

const delegationPda = (delegator, delegatee) =>
  pda([
    enc("reputation_delegation"),
    delegator.toBuffer(),
    delegatee.toBuffer(),
  ])[0];

async function registerAgent(w) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(arr(agentId), new BN(1), "http://agent.test", null, new BN(0))
        .accounts({
          agent: agentPda,
          protocolConfig: w.protocolPda,
          authority: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "register agent",
  );
  return { kp, prog, agentPda };
}

async function injectLegacyDelegation(w, delegator, delegatee, amount = 1000) {
  const clock = w.svm.getClock();
  clock.unixTimestamp += 2n;
  w.svm.setClock(clock);

  const [delegation, bump] = pda([
    enc("reputation_delegation"),
    delegator.agentPda.toBuffer(),
    delegatee.agentPda.toBuffer(),
  ]);
  const createdAt = w.svm.getClock().unixTimestamp;
  const data = await coder.accounts.encode("ReputationDelegation", {
    delegator: delegator.agentPda,
    delegatee: delegatee.agentPda,
    amount,
    expires_at: new BN(0),
    created_at: new BN(createdAt.toString()),
    bump,
    _reserved: Array(8).fill(0),
  });
  w.svm.setAccount(delegation, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });

  const account = w.svm.getAccount(delegator.agentPda);
  const agent = coder.accounts.decode(
    "AgentRegistration",
    Buffer.from(account.data),
  );
  agent.reputation -= amount;
  w.svm.setAccount(delegator.agentPda, {
    ...account,
    data: await coder.accounts.encode("AgentRegistration", agent),
  });

  return delegation;
}

function recoveryAccounts(w, treasury = w.admin.publicKey) {
  return [
    { pubkey: w.protocolPda, isSigner: false, isWritable: false },
    { pubkey: treasury, isSigner: false, isWritable: true },
  ];
}

async function revokeIx(prog, {
  authority,
  delegatorAgent,
  delegation,
  remainingAccounts,
}) {
  let builder = prog.methods.revokeDelegation().accounts({
    authority,
    delegatorAgent,
    delegation,
  });
  if (remainingAccounts !== undefined) {
    builder = builder.remainingAccounts(remainingAccounts);
  }
  return builder.instruction();
}

function replaceWithClosedAgentPda(w, agentPda) {
  w.svm.setAccount(agentPda, {
    lamports: 0,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
    rentEpoch: 0,
  });
}

async function replaceWithDiscontinuousClone(
  w,
  agentPda,
  delegationAddress,
  cloneAuthority,
  registeredAtOffset,
) {
  const account = w.svm.getAccount(agentPda);
  const agent = coder.accounts.decode(
    "AgentRegistration",
    Buffer.from(account.data),
  );
  const delegation = decode(
    w.svm,
    "ReputationDelegation",
    delegationAddress,
  );
  agent.authority = cloneAuthority;
  agent.registered_at = delegation.created_at.addn(registeredAtOffset);
  agent.reputation = PROBATIONARY_REPUTATION;
  w.svm.setAccount(agentPda, {
    ...account,
    data: await coder.accounts.encode("AgentRegistration", agent),
  });
}

test("delegate_reputation: new entry is disabled atomically", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delegation = delegationPda(delegator.agentPda, delegatee.agentPda);
  const reputationBefore = decode(
    w.svm,
    "AgentRegistration",
    delegator.agentPda,
  ).reputation;

  expectFail(
    send(
      w.svm,
      await delegator.prog.methods
        .delegateReputation(1000, new BN(0))
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegateeAgent: delegatee.agentPda,
          delegation,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [delegator.kp],
    ),
    "ReputationDelegationDisabled",
    "new delegation",
  );

  assert.ok(isClosed(w.svm, delegation), "failed entry creates no account");
  assert.equal(
    decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
    reputationBefore,
    "failed entry changes no reputation",
  );
});

test("revoke_delegation: third party immediately retires a continuous delegation without restoring reputation", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delegation = await injectLegacyDelegation(w, delegator, delegatee);
  const cranker = Keypair.generate();
  const fakeProtocol = Keypair.generate();
  const redirect = Keypair.generate();
  for (const account of [cranker, fakeProtocol, redirect]) {
    w.svm.airdrop(account.publicKey, BigInt(1e9));
  }

  const reputationBefore = decode(
    w.svm,
    "AgentRegistration",
    delegator.agentPda,
  ).reputation;
  const authorityBefore = lamports(w.svm, delegator.kp.publicKey);
  const redirectBefore = lamports(w.svm, redirect.publicKey);
  const delegationRent = lamports(w.svm, delegation);
  assert.equal(
    reputationBefore,
    PROBATIONARY_REPUTATION - 1000,
    "legacy delegation debit is present",
  );

  expectOk(
    send(
      w.svm,
      await revokeIx(makeProgram(cranker), {
        authority: delegator.kp.publicKey,
        delegatorAgent: delegator.agentPda,
        delegation,
        // A continuous identity must ignore all attacker-supplied suffixes.
        remainingAccounts: [
          { pubkey: fakeProtocol.publicKey, isSigner: false, isWritable: false },
          { pubkey: redirect.publicKey, isSigner: false, isWritable: true },
        ],
      }),
      [cranker],
    ),
    "permissionless continuous retirement",
  );

  assert.ok(isClosed(w.svm, delegation), "delegation is closed immediately");
  assert.equal(
    decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
    reputationBefore,
    "retirement restores zero reputation",
  );
  assert.equal(
    lamports(w.svm, delegator.kp.publicKey) - authorityBefore,
    delegationRent,
    "all delegation rent goes to the recorded authority",
  );
  assert.equal(
    lamports(w.svm, redirect.publicKey),
    redirectBefore,
    "attacker-supplied recipient receives nothing",
  );
});

test("revoke_delegation: wrong authority cannot redirect a continuous delegation", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delegation = await injectLegacyDelegation(w, delegator, delegatee);
  const attacker = Keypair.generate();
  w.svm.airdrop(attacker.publicKey, BigInt(1e9));

  const reputationBefore = decode(
    w.svm,
    "AgentRegistration",
    delegator.agentPda,
  ).reputation;
  const delegationRent = lamports(w.svm, delegation);
  const authorityBefore = lamports(w.svm, delegator.kp.publicKey);
  const treasuryBefore = lamports(w.svm, w.admin.publicKey);

  expectFail(
    send(
      w.svm,
      await revokeIx(makeProgram(attacker), {
        authority: attacker.publicKey,
        delegatorAgent: delegator.agentPda,
        delegation,
        remainingAccounts: recoveryAccounts(w),
      }),
      [attacker],
    ),
    "UnauthorizedAgent",
    "wrong continuous rent recipient",
  );

  assert.equal(lamports(w.svm, delegation), delegationRent, "failure is atomic");
  assert.equal(
    decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
    reputationBefore,
    "failure changes no reputation",
  );
  assert.equal(
    lamports(w.svm, delegator.kp.publicKey),
    authorityBefore,
    "recorded authority receives no partial transfer",
  );
  assert.equal(
    lamports(w.svm, w.admin.publicKey),
    treasuryBefore,
    "treasury receives no partial transfer",
  );
});

test("revoke_delegation: absent identity retires only to the canonical treasury", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delegation = await injectLegacyDelegation(w, delegator, delegatee);
  replaceWithClosedAgentPda(w, delegator.agentPda);

  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));
  const treasuryBefore = lamports(w.svm, w.admin.publicKey);
  const delegationRent = lamports(w.svm, delegation);

  expectOk(
    send(
      w.svm,
      await revokeIx(makeProgram(cranker), {
        authority: cranker.publicKey,
        delegatorAgent: delegator.agentPda,
        delegation,
        remainingAccounts: recoveryAccounts(w),
      }),
      [cranker],
    ),
    "permissionless absent-identity retirement",
  );

  assert.ok(isClosed(w.svm, delegation), "orphan delegation is closed");
  assert.ok(isClosed(w.svm, delegator.agentPda), "agent remains absent");
  assert.equal(
    lamports(w.svm, w.admin.publicKey) - treasuryBefore,
    delegationRent,
    "all delegation rent goes to the configured treasury",
  );
});

for (const [cloneLabel, registeredAtOffset] of [
  ["same-time clone", 0],
  ["later clone", 1],
]) {
  test(`revoke_delegation: ${cloneLabel} receives no reputation or rent`, async () => {
    const w = await freshWorld();
    const delegator = await registerAgent(w);
    const delegatee = await registerAgent(w);
    const delegation = await injectLegacyDelegation(w, delegator, delegatee);
    const cloneAuthority = Keypair.generate();
    const cranker = Keypair.generate();
    for (const account of [cloneAuthority, cranker]) {
      w.svm.airdrop(account.publicKey, BigInt(1e9));
    }
    await replaceWithDiscontinuousClone(
      w,
      delegator.agentPda,
      delegation,
      cloneAuthority.publicKey,
      registeredAtOffset,
    );

    const cloneBefore = lamports(w.svm, cloneAuthority.publicKey);
    const treasuryBefore = lamports(w.svm, w.admin.publicKey);
    const delegationRent = lamports(w.svm, delegation);
    assert.equal(
      decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
      PROBATIONARY_REPUTATION,
      "clone starts with fresh probationary reputation",
    );

    expectOk(
      send(
        w.svm,
        await revokeIx(makeProgram(cranker), {
          authority: cloneAuthority.publicKey,
          delegatorAgent: delegator.agentPda,
          delegation,
          remainingAccounts: recoveryAccounts(w),
        }),
        [cranker],
      ),
      `permissionless ${cloneLabel} retirement`,
    );

    assert.ok(isClosed(w.svm, delegation), "clone-bound delegation is closed");
    assert.equal(
      decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
      PROBATIONARY_REPUTATION,
      "clone receives zero restored reputation",
    );
    assert.equal(
      lamports(w.svm, cloneAuthority.publicKey),
      cloneBefore,
      "clone authority receives no rent",
    );
    assert.equal(
      lamports(w.svm, w.admin.publicKey) - treasuryBefore,
      delegationRent,
      "all delegation rent goes to the configured treasury",
    );
  });
}

for (const recoveryFailure of [
  {
    name: "missing recovery accounts",
    error: "ReputationDelegationRecoveryAccountsRequired",
    accounts: () => undefined,
  },
  {
    name: "swapped protocol and treasury",
    error: "CorruptedData",
    accounts: (w) => [
      { pubkey: w.admin.publicKey, isSigner: false, isWritable: true },
      { pubkey: w.protocolPda, isSigner: false, isWritable: false },
    ],
  },
  {
    name: "fake treasury",
    error: "InvalidTreasury",
    accounts: (w, fakeTreasury) => recoveryAccounts(w, fakeTreasury),
  },
]) {
  test(`revoke_delegation: ${recoveryFailure.name} fails atomically`, async () => {
    const w = await freshWorld();
    const delegator = await registerAgent(w);
    const delegatee = await registerAgent(w);
    const delegation = await injectLegacyDelegation(w, delegator, delegatee);
    replaceWithClosedAgentPda(w, delegator.agentPda);

    const cranker = Keypair.generate();
    const fakeTreasury = Keypair.generate();
    for (const account of [cranker, fakeTreasury]) {
      w.svm.airdrop(account.publicKey, BigInt(1e9));
    }
    const delegationRent = lamports(w.svm, delegation);
    const treasuryBefore = lamports(w.svm, w.admin.publicKey);
    const fakeTreasuryBefore = lamports(w.svm, fakeTreasury.publicKey);

    expectFail(
      send(
        w.svm,
        await revokeIx(makeProgram(cranker), {
          authority: cranker.publicKey,
          delegatorAgent: delegator.agentPda,
          delegation,
          remainingAccounts: recoveryFailure.accounts(
            w,
            fakeTreasury.publicKey,
          ),
        }),
        [cranker],
      ),
      recoveryFailure.error,
      recoveryFailure.name,
    );

    assert.equal(
      lamports(w.svm, delegation),
      delegationRent,
      "failed recovery leaves delegation rent intact",
    );
    assert.ok(isClosed(w.svm, delegator.agentPda), "agent remains absent");
    assert.equal(
      lamports(w.svm, w.admin.publicKey),
      treasuryBefore,
      "failed recovery transfers nothing to treasury",
    );
    assert.equal(
      lamports(w.svm, fakeTreasury.publicKey),
      fakeTreasuryBefore,
      "failed recovery transfers nothing to a fake treasury",
    );
  });
}
