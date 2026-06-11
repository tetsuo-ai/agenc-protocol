// In-process litesvm integration tests for P7.3 agent domain verification.
//   - record_agent_verification   (recordAgentVerification)  via the global moderator key
//   - record_agent_verification   (recordAgentVerification)  via a registered attestor
//   - revoke_agent_verification   (revokeAgentVerification)
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end. The
// authorization path is the EXACT mirror of record_*_moderation (same trusted roster), so
// this reuses the moderation-attestor world setup.
//
// In the test world, ModerationConfig is injected with:
//   authority            = admin   (owns the roster: assign/revoke signer)
//   moderation_authority = modAuth (the single global recorder)
//
// REVERT-SENSITIVE INTENT — each negative isolates exactly one new guard:
//   - "stranger cannot record (no attestor entry)"  -> handler require_moderation_authorized
//        (UnauthorizedModerationAttestor). The same OR-branch that gates moderation.
//   - "empty / malformed / too-long domain rejected" -> validate_verified_domain
//        (InvalidVerifiedDomain).
//   - "unknown method rejected"                      -> is_valid_agent_verification_method
//        (InvalidAgentVerificationMethod).
// The positives prove the global authority AND a registered attestor (who is NOT the global
// moderation authority) can record, re-verification overwrites in place, and revoke marks
// the record revoked.
//
// NOTE: requires the rebuilt .so + regenerated IDL (the integrator runs anchor build +
// artifacts:refresh first). It references the to-be-generated `recordAgentVerification` /
// `revokeAgentVerification` / `assignModerationAttestor` builders and the `AgentVerification`
// account decoder by their naming-convention names.
//
// Run:  cd agenc-protocol && node --test tests-integration/agent-verification.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  enc, pda,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, BN, Keypair, SystemProgram,
} from "./harness.mjs";

// Verification methods (mirror state.rs agent_verification_method::*).
const METHOD_TXT_RECORD = 0;
const METHOD_WELL_KNOWN = 1;

const verificationPda = (agent) =>
  pda([enc("agent_verification"), agent.toBuffer()]);
const attestorPda = (attestor) =>
  pda([enc("moderation_attestor"), attestor.toBuffer()]);

// Assign `attestor` to the moderation roster, signed by the roster authority (admin).
async function assign(w, attestor) {
  const [entry] = attestorPda(attestor);
  return send(
    w.svm,
    await makeProgram(w.admin).methods
      .assignModerationAttestor(attestor)
      .accounts({
        moderationConfig: w.modCfg,
        moderationAttestor: entry,
        authority: w.admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [w.admin],
  );
}

// Build a record_agent_verification ix from `recorder`, optionally passing the attestor PDA.
async function recordVerification(
  w,
  { recorder, domain, method = METHOD_TXT_RECORD, expiresAt = 0, attestorEntry = null },
) {
  const [verification] = verificationPda(w.providerAgent);
  return {
    verification,
    ix: await makeProgram(recorder).methods
      .recordAgentVerification(domain, method, new BN(expiresAt))
      .accounts({
        moderationConfig: w.modCfg,
        agent: w.providerAgent,
        agentVerification: verification,
        attestor: recorder.publicKey,
        moderationAttestor: attestorEntry,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  };
}

// ---------------------------------------------------------------------------
// Positive: the global moderation authority records
// ---------------------------------------------------------------------------

test("record_agent_verification: the global moderation authority records a verification", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  const { verification, ix } = await recordVerification(w, {
    recorder: w.modAuth,
    domain: "provider.example.com",
    method: METHOD_TXT_RECORD,
  });
  assert.ok(isClosed(w.svm, verification), "verification does not exist yet");
  expectOk(send(w.svm, ix, [w.modAuth]), "global authority records verification");

  const v = decode(w.svm, "AgentVerification", verification);
  assert.equal(v.agent.toBase58(), w.providerAgent.toBase58(), "agent recorded");
  assert.equal(v.verified_domain, "provider.example.com", "domain recorded");
  assert.equal(v.method, METHOD_TXT_RECORD, "method recorded");
  assert.equal(v.verified_by.toBase58(), w.modAuth.publicKey.toBase58(), "verified_by = the recorder");
  assert.equal(Number(v.expires_at), 0, "no expiry");
  assert.equal(v.revoked, false, "fresh verification is not revoked");
  assert.ok(Number(v.verified_at) > 0, "verified_at set from the clock");
});

// ---------------------------------------------------------------------------
// Positive: a registered attestor (not the global authority) records
// ---------------------------------------------------------------------------

test("record_agent_verification: a registered attestor (not the global authority) records", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  const { verification, ix } = await recordVerification(w, {
    recorder: attestor,
    domain: "agent.operators.example.io",
    method: METHOD_WELL_KNOWN,
    attestorEntry: entry,
  });
  expectOk(send(w.svm, ix, [attestor]), "registered attestor records verification");

  const v = decode(w.svm, "AgentVerification", verification);
  assert.equal(v.verified_by.toBase58(), attestor.publicKey.toBase58(), "recorded by the attestor");
  assert.equal(v.verified_domain, "agent.operators.example.io", "domain recorded");
  assert.equal(v.method, METHOD_WELL_KNOWN, "well-known method recorded");
});

// ---------------------------------------------------------------------------
// Negative: authorization mirrors record_*_moderation
// ---------------------------------------------------------------------------

test("record_agent_verification: a stranger with NO roster entry cannot record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));

  const { ix } = await recordVerification(w, {
    recorder: stranger,
    domain: "stranger.example.com",
    attestorEntry: null,
  });
  expectFail(send(w.svm, ix, [stranger]), "UnauthorizedModerationAttestor", "stranger record");
});

// ---------------------------------------------------------------------------
// Negative: domain + method validation
// ---------------------------------------------------------------------------

test("record_agent_verification: an empty domain is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { ix } = await recordVerification(w, { recorder: w.modAuth, domain: "" });
  expectFail(send(w.svm, ix, [w.modAuth]), "InvalidVerifiedDomain", "empty domain");
});

test("record_agent_verification: a malformed domain (bad charset) is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { ix } = await recordVerification(w, { recorder: w.modAuth, domain: "https://x.com" });
  expectFail(send(w.svm, ix, [w.modAuth]), "InvalidVerifiedDomain", "scheme/slashes domain");
});

test("record_agent_verification: an over-long domain (>253) is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // 254 label-legal chars, one over the DNS cap.
  const tooLong = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`;
  assert.equal(tooLong.length, 254);
  const { ix } = await recordVerification(w, { recorder: w.modAuth, domain: tooLong });
  expectFail(send(w.svm, ix, [w.modAuth]), "InvalidVerifiedDomain", "over-long domain");
});

test("record_agent_verification: an unknown method is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { ix } = await recordVerification(w, {
    recorder: w.modAuth,
    domain: "ok.example.com",
    method: 7,
  });
  expectFail(send(w.svm, ix, [w.modAuth]), "InvalidAgentVerificationMethod", "unknown method");
});

// ---------------------------------------------------------------------------
// Re-verification overwrites the same PDA in place
// ---------------------------------------------------------------------------

test("record_agent_verification: re-verification updates the same PDA in place", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  const first = await recordVerification(w, {
    recorder: w.modAuth,
    domain: "old.example.com",
    method: METHOD_TXT_RECORD,
  });
  expectOk(send(w.svm, first.ix, [w.modAuth]), "first verification");
  assert.equal(
    decode(w.svm, "AgentVerification", first.verification).verified_domain,
    "old.example.com",
    "first domain recorded",
  );

  w.svm.expireBlockhash();
  const second = await recordVerification(w, {
    recorder: w.modAuth,
    domain: "new.example.com",
    method: METHOD_WELL_KNOWN,
  });
  expectOk(send(w.svm, second.ix, [w.modAuth]), "re-verification");

  assert.equal(second.verification.toBase58(), first.verification.toBase58(), "same PDA");
  const v = decode(w.svm, "AgentVerification", second.verification);
  assert.equal(v.verified_domain, "new.example.com", "domain updated in place");
  assert.equal(v.method, METHOD_WELL_KNOWN, "method updated in place");
  assert.equal(v.revoked, false, "re-verification clears any prior revocation");
});

// ---------------------------------------------------------------------------
// Revoke marks the record revoked (without closing it)
// ---------------------------------------------------------------------------

test("revoke_agent_verification: the global authority marks a verification revoked", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  const { verification, ix } = await recordVerification(w, {
    recorder: w.modAuth,
    domain: "revoke-me.example.com",
  });
  expectOk(send(w.svm, ix, [w.modAuth]), "record verification");
  assert.equal(decode(w.svm, "AgentVerification", verification).revoked, false, "not revoked yet");

  w.svm.expireBlockhash();
  expectOk(
    send(
      w.svm,
      await makeProgram(w.modAuth).methods
        .revokeAgentVerification()
        .accounts({
          moderationConfig: w.modCfg,
          agentVerification: verification,
          attestor: w.modAuth.publicKey,
          moderationAttestor: null,
        })
        .instruction(),
      [w.modAuth],
    ),
    "revoke verification",
  );

  const v = decode(w.svm, "AgentVerification", verification);
  assert.equal(v.revoked, true, "verification marked revoked (record kept readable)");
  assert.equal(v.verified_domain, "revoke-me.example.com", "domain still readable after revoke");
});

test("revoke_agent_verification: a stranger cannot revoke", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));

  const { verification, ix } = await recordVerification(w, {
    recorder: w.modAuth,
    domain: "guarded.example.com",
  });
  expectOk(send(w.svm, ix, [w.modAuth]), "record verification");

  w.svm.expireBlockhash();
  expectFail(
    send(
      w.svm,
      await makeProgram(stranger).methods
        .revokeAgentVerification()
        .accounts({
          moderationConfig: w.modCfg,
          agentVerification: verification,
          attestor: stranger.publicKey,
          moderationAttestor: null,
        })
        .instruction(),
      [stranger],
    ),
    "UnauthorizedModerationAttestor",
    "stranger revoke",
  );
  assert.equal(decode(w.svm, "AgentVerification", verification).revoked, false, "still not revoked");
});
