// Revision-4 wire-compatibility and loader-upload race regressions for
// set_service_listing_state. The deployed instruction has exactly three fixed
// account metas: [listing, protocol_config, authority]. Reactivation appends the
// provider-agent proof as a remaining account; pause/retire remain old-wire exits.

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TransactionInstruction } from "@solana/web3.js";
import {
  coder,
  decode,
  expectFail,
  expectOk,
  freshWorld,
  Keypair,
  PID,
  send,
  setProtocolPaused,
  SystemProgram,
} from "./harness.mjs";

const SET_LISTING_STATE_DISCRIMINATOR = Buffer.from([
  87, 136, 109, 167, 206, 112, 223, 72,
]);

const lamports = (svm, address) => {
  const account = svm.getAccount(address);
  return account ? BigInt(account.lamports) : 0n;
};

function oldWireSetStateIx(
  w,
  newState,
  { authority = w.provider.publicKey, providerProof = null } = {},
) {
  const keys = [
    { pubkey: w.listing, isSigner: false, isWritable: true },
    { pubkey: w.protocolPda, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: false },
  ];
  if (providerProof) {
    keys.push({ pubkey: providerProof, isSigner: false, isWritable: false });
  }
  return new TransactionInstruction({
    programId: PID,
    keys,
    data: Buffer.concat([
      SET_LISTING_STATE_DISCRIMINATOR,
      Buffer.from([newState]),
    ]),
  });
}

function closeProviderAgent(w) {
  w.svm.setAccount(w.providerAgent, {
    lamports: 0,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
    rentEpoch: 0,
  });
}

async function setProviderAuthority(w, authority) {
  const account = w.svm.getAccount(w.providerAgent);
  const agent = coder.accounts.decode(
    "AgentRegistration",
    Buffer.from(account.data),
  );
  agent.authority = authority;
  w.svm.setAccount(w.providerAgent, {
    ...account,
    data: await coder.accounts.encode("AgentRegistration", agent),
  });
}

async function setProviderLifecycle(w, status, reserved = [0, 0, 0, 0]) {
  const account = w.svm.getAccount(w.providerAgent);
  const agent = coder.accounts.decode(
    "AgentRegistration",
    Buffer.from(account.data),
  );
  agent.status = { [status]: {} };
  agent._reserved = [...reserved];
  w.svm.setAccount(w.providerAgent, {
    ...account,
    data: await coder.accounts.encode("AgentRegistration", agent),
  });
}

test("set_service_listing_state: revision-4 owner can pause and retire after its provider PDA was closed", async () => {
  const w = await freshWorld();
  const before = decode(w.svm, "ServiceListing", w.listing);
  const listingRent = lamports(w.svm, w.listing);
  await setProtocolPaused(w.svm, true);
  closeProviderAgent(w);

  const pauseIx = oldWireSetStateIx(w, 1);
  assert.equal(pauseIx.keys.length, 3, "revision-4 exit has three fixed metas");
  expectOk(send(w.svm, pauseIx, [w.provider]), "old-wire orphan pause");

  const paused = decode(w.svm, "ServiceListing", w.listing);
  assert.ok(paused.state.Paused !== undefined, "orphan listing is paused");
  assert.equal(
    paused.version.toString(),
    before.version.addn(1).toString(),
    "exit still invalidates stale signed hires",
  );
  assert.equal(
    paused.authority.toBase58(),
    w.provider.publicKey.toBase58(),
    "listing ownership is unchanged",
  );
  assert.equal(
    lamports(w.svm, w.listing),
    listingRent,
    "state recovery neither closes the listing nor moves rent",
  );

  await setProtocolPaused(w.svm, false);
  expectFail(
    send(
      w.svm,
      oldWireSetStateIx(w, 0, { providerProof: w.providerAgent }),
      [w.provider],
    ),
    "AccountNotInitialized",
    "closed provider cannot reactivate",
  );
  assert.ok(
    decode(w.svm, "ServiceListing", w.listing).state.Paused !== undefined,
    "failed reactivation is atomic",
  );

  await setProtocolPaused(w.svm, true);
  expectOk(
    send(w.svm, oldWireSetStateIx(w, 2), [w.provider]),
    "old-wire orphan retirement",
  );
  const retired = decode(w.svm, "ServiceListing", w.listing);
  assert.ok(retired.state.Retired !== undefined, "orphan listing is retired");
  assert.equal(
    lamports(w.svm, w.listing),
    listingRent,
    "retirement does not expose listing rent",
  );
});

test("set_service_listing_state: an orphan exit still requires the immutable listing authority", async () => {
  const w = await freshWorld();
  closeProviderAgent(w);
  const attacker = Keypair.generate();
  w.svm.airdrop(attacker.publicKey, BigInt(1e9));

  const before = decode(w.svm, "ServiceListing", w.listing);
  const listingRent = lamports(w.svm, w.listing);
  expectFail(
    send(
      w.svm,
      oldWireSetStateIx(w, 2, { authority: attacker.publicKey }),
      [attacker],
    ),
    "UnauthorizedAgent",
    "attacker orphan retirement",
  );

  const after = decode(w.svm, "ServiceListing", w.listing);
  assert.ok(after.state.Active !== undefined, "attacker cannot mutate state");
  assert.equal(after.version.toString(), before.version.toString());
  assert.equal(lamports(w.svm, w.listing), listingRent);
});

test("set_service_listing_state: reactivation requires the exact active provider owned by the listing authority", async () => {
  const w = await freshWorld();
  expectOk(
    send(w.svm, oldWireSetStateIx(w, 1), [w.provider]),
    "pause before reactivation checks",
  );
  const pausedVersion = decode(
    w.svm,
    "ServiceListing",
    w.listing,
  ).version.toString();

  expectFail(
    send(w.svm, oldWireSetStateIx(w, 0), [w.provider]),
    "InvalidInput",
    "reactivation without provider proof",
  );
  expectFail(
    send(
      w.svm,
      oldWireSetStateIx(w, 0, { providerProof: w.buyerAgent }),
      [w.provider],
    ),
    "InvalidInput",
    "reactivation with another canonical agent",
  );

  await setProviderAuthority(w, w.buyer.publicKey);
  expectFail(
    send(
      w.svm,
      oldWireSetStateIx(w, 0, { providerProof: w.providerAgent }),
      [w.provider],
    ),
    "UnauthorizedAgent",
    "reactivation with a revision-4 clone owned by another wallet",
  );
  assert.equal(
    decode(w.svm, "ServiceListing", w.listing).version.toString(),
    pausedVersion,
    "all failed proof checks are atomic",
  );

  await setProviderAuthority(w, w.provider.publicKey);
  await setProviderLifecycle(w, "Suspended");
  w.svm.expireBlockhash();
  expectFail(
    send(
      w.svm,
      oldWireSetStateIx(w, 0, { providerProof: w.providerAgent }),
      [w.provider],
    ),
    "AgentNotActive",
    "suspended provider cannot reactivate a listing",
  );

  await setProviderLifecycle(w, "Inactive", Buffer.from("RETD"));
  w.svm.expireBlockhash();
  expectFail(
    send(
      w.svm,
      oldWireSetStateIx(w, 0, { providerProof: w.providerAgent }),
      [w.provider],
    ),
    "AgentNotActive",
    "retired provider cannot reactivate a listing",
  );
  assert.equal(
    decode(w.svm, "ServiceListing", w.listing).version.toString(),
    pausedVersion,
    "inactive and retired provider failures are atomic",
  );

  await setProviderLifecycle(w, "Active");
  w.svm.expireBlockhash();
  expectOk(
    send(
      w.svm,
      oldWireSetStateIx(w, 0, { providerProof: w.providerAgent }),
      [w.provider],
    ),
    "reactivation with exact active provider proof",
  );
  assert.ok(
    decode(w.svm, "ServiceListing", w.listing).state.Active !== undefined,
    "valid provider proof reactivates",
  );
});
