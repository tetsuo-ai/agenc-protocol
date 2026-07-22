import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  LOCALNET_PROGRAM_ID,
  LOCALNET_PROGRAM_LOAD_METHOD,
} from "./localnet-program-binding.mjs";
import {
  assertLedgerPurgeIsAttested,
  purgeAttestedLedger,
  stopProcess,
} from "./localnet-down.mjs";
import { observeLinuxProcess } from "./localnet-process-identity.mjs";
import {
  assertRaceFreeProcessSignallingAvailable,
  openLinuxProcessReference,
  processReferenceSignalNumber,
  signalProcessIfIdentityMatches,
  signalProcessReference,
} from "./localnet-process-signal.mjs";
import {
  assertCanonicalProgramIdentity,
  assertLedgerLaunchIsAttested,
  expectedLocalnetProtocolMode,
  invalidateFixturesAfterValidatorBoot,
  localnetBidMarketplaceDiffs,
  localnetBidMarketplaceInitializeInput,
  parseArgs as parseLocalnetUpArgs,
  stopPid,
} from "./localnet-up.mjs";

// The preflight test glob keeps these shutdown safety regressions in ordinary CI.
const RECORD = Object.freeze({ pid: 42 });
const PROGRAM_ID = "test-program-id";

test("fixture cache is invalidated only after a new reset boot", async () => {
  let removals = 0;
  const removeFixtures = async () => {
    removals += 1;
  };
  assert.equal(
    await invalidateFixturesAfterValidatorBoot(
      { booted: false, keepLedger: false },
      removeFixtures,
    ),
    false,
  );
  assert.equal(
    await invalidateFixturesAfterValidatorBoot(
      { booted: true, keepLedger: true },
      removeFixtures,
    ),
    false,
  );
  assert.equal(removals, 0);
  assert.equal(
    await invalidateFixturesAfterValidatorBoot(
      { booted: true, keepLedger: false },
      removeFixtures,
    ),
    true,
  );
  assert.equal(removals, 1);
});

const implementations = [
  {
    name: "localnet-down",
    stop: (dependencies) =>
      stopProcess("validator", RECORD, {
        log: () => {},
        ...dependencies,
      }),
  },
  {
    name: "localnet-up",
    stop: (dependencies) =>
      stopPid("validator", RECORD, PROGRAM_ID, dependencies),
  },
];

function identitySequence(...results) {
  let index = 0;
  return async () => {
    assert.ok(index < results.length, "unexpected identity revalidation");
    const result = results[index];
    index += 1;
    if (result instanceof Error) throw result;
    return result;
  };
}

function expireTermGrace() {
  let call = 0;
  return () => (call++ === 0 ? 0 : 1);
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function fakeProcessReference(pid) {
  return {
    pid,
    fd: 3,
    close() {},
  };
}

function fakeOpenProcessReference(pid) {
  return fakeProcessReference(pid);
}

test("runtime pidfd signalling capability probe succeeds", (t) => {
  if (process.platform !== "linux") {
    t.skip("pidfd signalling is Linux-only");
    return;
  }
  assert.doesNotThrow(() => assertRaceFreeProcessSignallingAvailable());
});

test("localnet operational mode is explicit and cannot be relabeled on converge", () => {
  assert.deepEqual(expectedLocalnetProtocolMode(false, 5), {
    protocolPaused: true,
    surfaceRevision: 0,
  });
  assert.deepEqual(expectedLocalnetProtocolMode(true, 5), {
    protocolPaused: false,
    surfaceRevision: 5,
  });
  assert.equal(parseLocalnetUpArgs([]).devReady, false);
  assert.equal(parseLocalnetUpArgs(["--dev-ready"]).devReady, true);
  assert.equal(
    parseLocalnetUpArgs(["--unsafe-unpaused-fixture"]).devReady,
    true,
  );
  assert.throws(
    () => parseLocalnetUpArgs(["--dev-ready", "--keep-ledger"]),
    /fresh disposable genesis/u,
  );
});

test("localnet-up initializes and verifies the exact bid marketplace singleton", () => {
  const authority = { address: "authority" };
  const moderator = { address: "moderator" };
  const seeder = { address: "seeder" };
  const input = localnetBidMarketplaceInitializeInput({
    authority,
    moderator,
    seeder,
  });
  assert.equal(input.authority, authority);
  assert.deepEqual(input.multisigSigners, [authority, moderator]);
  assert.deepEqual(
    { ...input, authority: undefined, multisigSigners: undefined },
    {
      authority: undefined,
      multisigSigners: undefined,
      minBidBondLamports: 1_000_000n,
      bidCreationCooldownSecs: 60n,
      maxBidsPer24h: 50,
      maxActiveBidsPerTask: 20,
      maxBidLifetimeSecs: 604_800n,
      acceptedNoShowSlashBps: 1_000,
    },
  );
  assert.throws(
    () =>
      localnetBidMarketplaceInitializeInput({
        authority,
        moderator: authority,
      }),
    /distinct authority and moderator/u,
  );

  const discriminator = new Uint8Array([47, 42, 142, 40, 13, 39, 48, 107]);
  const account = {
    exists: true,
    executable: false,
    programAddress: LOCALNET_PROGRAM_ID,
    data: {
      discriminator,
      authority: authority.address,
      minBidBondLamports: 1_000_000n,
      bidCreationCooldownSecs: 60n,
      maxBidsPer24h: 50,
      maxActiveBidsPerTask: 20,
      maxBidLifetimeSecs: 604_800n,
      acceptedNoShowSlashBps: 1_000,
      bump: 255,
    },
  };
  const compare = (candidate) =>
    localnetBidMarketplaceDiffs({
      account: candidate,
      expectedAuthority: authority.address,
      expectedBump: 255,
      expectedDiscriminator: discriminator,
    });
  assert.deepEqual(compare(account), []);

  for (const [field, candidate] of [
    ["owner", { ...account, programAddress: "wrong-program" }],
    ["executable", { ...account, executable: true }],
    [
      "discriminator",
      {
        ...account,
        data: { ...account.data, discriminator: new Uint8Array(8) },
      },
    ],
    [
      "authority",
      { ...account, data: { ...account.data, authority: "wrong-authority" } },
    ],
    [
      "minBidBondLamports",
      {
        ...account,
        data: { ...account.data, minBidBondLamports: 2_000_000n },
      },
    ],
    [
      "bidCreationCooldownSecs",
      {
        ...account,
        data: { ...account.data, bidCreationCooldownSecs: 61n },
      },
    ],
    [
      "maxBidsPer24h",
      { ...account, data: { ...account.data, maxBidsPer24h: 51 } },
    ],
    [
      "maxActiveBidsPerTask",
      { ...account, data: { ...account.data, maxActiveBidsPerTask: 21 } },
    ],
    [
      "maxBidLifetimeSecs",
      {
        ...account,
        data: { ...account.data, maxBidLifetimeSecs: 604_801n },
      },
    ],
    [
      "acceptedNoShowSlashBps",
      {
        ...account,
        data: { ...account.data, acceptedNoShowSlashBps: 10_001 },
      },
    ],
    ["bump", { ...account, data: { ...account.data, bump: 254 } }],
  ]) {
    assert.equal(
      compare(candidate).some((diff) => diff.field === field),
      true,
    );
  }
});

test("ledger purge requires a live identity or verified-stopped marker", () => {
  assert.doesNotThrow(() =>
    assertLedgerPurgeIsAttested({
      ledgerExists: false,
      stoppedMarkerFound: false,
      startingMarkerFound: false,
    }),
  );
  for (const proof of [
    { stoppedMarkerFound: true, startingMarkerFound: false },
    { stoppedMarkerFound: false, startingMarkerFound: true },
    { stoppedMarkerFound: true, startingMarkerFound: true },
  ]) {
    assert.doesNotThrow(() =>
      assertLedgerPurgeIsAttested({ ledgerExists: true, ...proof }),
    );
  }
  assert.throws(
    () =>
      assertLedgerPurgeIsAttested({
        ledgerExists: true,
        stoppedMarkerFound: false,
        startingMarkerFound: false,
      }),
    /ledger exists without verified stopped\/startup lifecycle evidence/,
  );
});

test("ledger launch cannot mint its own proof and keep requires exact artifact evidence", () => {
  const current = {
    programSha256: "ab".repeat(32),
    programSize: 2_284_496,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
  };
  const stale = {
    programSha256: "cd".repeat(32),
    programSize: 2_000_000,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
  };
  assert.doesNotThrow(() =>
    assertLedgerLaunchIsAttested({
      ledgerExists: false,
      keepLedger: true,
      stoppedMarker: null,
      startingMarker: null,
      ...current,
    }),
  );
  for (const keepLedger of [false, true]) {
    assert.throws(
      () =>
        assertLedgerLaunchIsAttested({
          ledgerExists: true,
          keepLedger,
          stoppedMarker: null,
          startingMarker: null,
          ...current,
        }),
      /no prior stopped\/startup lifecycle evidence/,
    );
  }
  assert.doesNotThrow(() =>
    assertLedgerLaunchIsAttested({
      ledgerExists: true,
      keepLedger: false,
      stoppedMarker: stale,
      startingMarker: null,
      ...current,
    }),
  );
  for (const evidence of [
    { stoppedMarker: current, startingMarker: null },
    { stoppedMarker: null, startingMarker: current },
    { stoppedMarker: current, startingMarker: current },
  ]) {
    assert.doesNotThrow(() =>
      assertLedgerLaunchIsAttested({
        ledgerExists: true,
        keepLedger: true,
        ...evidence,
        ...current,
      }),
    );
  }
  for (const evidence of [
    { stoppedMarker: stale, startingMarker: null },
    { stoppedMarker: null, startingMarker: stale },
    { stoppedMarker: current, startingMarker: stale },
  ]) {
    assert.throws(
      () =>
        assertLedgerLaunchIsAttested({
          ledgerExists: true,
          keepLedger: true,
          ...evidence,
          ...current,
        }),
      /does not prove the current program artifact is loaded/,
    );
  }
});

test("canonical program identity drift fails before lifecycle publication", () => {
  const canonical = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
  assert.doesNotThrow(() =>
    assertCanonicalProgramIdentity(canonical, canonical),
  );
  assert.throws(
    () => assertCanonicalProgramIdentity("wrong-idl", canonical),
    /program identity mismatch/,
  );
  assert.throws(
    () => assertCanonicalProgramIdentity(canonical, "wrong-sdk"),
    /program identity mismatch/,
  );
});

test("purge preserves stopped proof until ledger removal succeeds", async () => {
  const order = [];
  await purgeAttestedLedger(
    {
      ledgerExists: true,
      stoppedMarkerFound: true,
      startingMarkerFound: true,
    },
    {
      removeLedger: async () => order.push("ledger"),
      syncStateDirectory: async () => order.push("sync"),
      removeStoppedMarker: async () => order.push("stopped"),
      removeStartingMarker: async () => order.push("starting"),
    },
  );
  assert.deepEqual(order, ["ledger", "sync", "stopped", "starting", "sync"]);

  const failedOrder = [];
  const failure = new Error("recursive removal failed");
  await assert.rejects(
    purgeAttestedLedger(
      {
        ledgerExists: true,
        stoppedMarkerFound: true,
        startingMarkerFound: true,
      },
      {
        removeLedger: async () => {
          failedOrder.push("ledger");
          throw failure;
        },
        syncStateDirectory: async () => failedOrder.push("sync"),
        removeStoppedMarker: async () => failedOrder.push("stopped"),
        removeStartingMarker: async () => failedOrder.push("starting"),
      },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(failedOrder, ["ledger"]);

  const syncFailedOrder = [];
  await assert.rejects(
    purgeAttestedLedger(
      {
        ledgerExists: true,
        stoppedMarkerFound: true,
        startingMarkerFound: true,
      },
      {
        removeLedger: async () => syncFailedOrder.push("ledger"),
        syncStateDirectory: async () => {
          syncFailedOrder.push("sync");
          throw failure;
        },
        removeStoppedMarker: async () => syncFailedOrder.push("stopped"),
        removeStartingMarker: async () => syncFailedOrder.push("starting"),
      },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(syncFailedOrder, ["ledger", "sync"]);
});

test("PID 1 is capability-probe-only and never a delivered-signal target", () => {
  assert.equal(processReferenceSignalNumber(1, 0), 0);
  assert.throws(
    () => processReferenceSignalNumber(1, "SIGTERM"),
    /refusing to deliver a nonzero signal to pid 1/,
  );
});

for (const implementation of implementations) {
  test(`${implementation.name} treats absence before SIGTERM as already stopped`, async () => {
    const signals = [];
    await implementation.stop({
      assertIdentity: identitySequence(false),
      openProcessReference: fakeOpenProcessReference,
      sendSignal: (reference, signal) => signals.push([reference.pid, signal]),
    });
    assert.deepEqual(signals, []);
  });

  test(`${implementation.name} treats SIGTERM ESRCH as already stopped`, async () => {
    const signals = [];
    await implementation.stop({
      assertIdentity: identitySequence(true),
      openProcessReference: fakeOpenProcessReference,
      sendSignal: (reference, signal) => {
        signals.push([reference.pid, signal]);
        throw codedError("ESRCH");
      },
    });
    assert.deepEqual(signals, [[RECORD.pid, "SIGTERM"]]);
  });

  test(`${implementation.name} refuses an initial identity mismatch without signalling`, async () => {
    const mismatch = new Error("process identity mismatch");
    const signals = [];
    await assert.rejects(
      implementation.stop({
        assertIdentity: identitySequence(mismatch),
        openProcessReference: fakeOpenProcessReference,
        sendSignal: (reference, signal) =>
          signals.push([reference.pid, signal]),
      }),
      (error) => error === mismatch,
    );
    assert.deepEqual(signals, []);
  });

  test(`${implementation.name} does not SIGKILL when final identity is absent`, async () => {
    const signals = [];
    await implementation.stop({
      assertIdentity: identitySequence(true, false),
      openProcessReference: fakeOpenProcessReference,
      sendSignal: (reference, signal) => signals.push([reference.pid, signal]),
      now: expireTermGrace(),
      termGraceMs: 1,
    });
    assert.deepEqual(signals, [[RECORD.pid, "SIGTERM"]]);
  });

  test(`${implementation.name} treats SIGKILL ESRCH as already stopped`, async () => {
    const signals = [];
    await implementation.stop({
      assertIdentity: identitySequence(true, true),
      openProcessReference: fakeOpenProcessReference,
      sendSignal: (reference, signal) => {
        signals.push([reference.pid, signal]);
        if (signal === "SIGKILL") throw codedError("ESRCH");
      },
      now: expireTermGrace(),
      termGraceMs: 1,
    });
    assert.deepEqual(signals, [
      [RECORD.pid, "SIGTERM"],
      [RECORD.pid, "SIGKILL"],
    ]);
  });

  test(`${implementation.name} refuses a final identity mismatch without SIGKILL`, async () => {
    const mismatch = new Error("process identity mismatch");
    const signals = [];
    await assert.rejects(
      implementation.stop({
        assertIdentity: identitySequence(true, mismatch),
        openProcessReference: fakeOpenProcessReference,
        sendSignal: (reference, signal) =>
          signals.push([reference.pid, signal]),
        now: expireTermGrace(),
        termGraceMs: 1,
      }),
      (error) => error === mismatch,
    );
    assert.deepEqual(signals, [[RECORD.pid, "SIGTERM"]]);
  });

  test(`${implementation.name} propagates non-ESRCH signal failures`, async () => {
    const denied = codedError("EPERM");
    await assert.rejects(
      implementation.stop({
        assertIdentity: identitySequence(true),
        openProcessReference: fakeOpenProcessReference,
        sendSignal: () => {
          throw denied;
        },
      }),
      (error) => error === denied,
    );
  });

  test(`${implementation.name} propagates non-ESRCH SIGKILL failures`, async () => {
    const denied = codedError("EPERM");
    const signals = [];
    await assert.rejects(
      implementation.stop({
        assertIdentity: identitySequence(true, true),
        openProcessReference: fakeOpenProcessReference,
        sendSignal: (reference, signal) => {
          signals.push([reference.pid, signal]);
          if (signal === "SIGKILL") throw denied;
        },
        now: expireTermGrace(),
        termGraceMs: 1,
      }),
      (error) => error === denied,
    );
    assert.deepEqual(signals, [
      [RECORD.pid, "SIGTERM"],
      [RECORD.pid, "SIGKILL"],
    ]);
  });
}

test("identity verification and delivery receive the same stable process reference", async () => {
  const reference = fakeProcessReference(RECORD.pid);
  const seen = [];
  const delivered = await signalProcessIfIdentityMatches(RECORD, "SIGTERM", {
    openProcessReference: () => reference,
    assertIdentity: (_record, candidate) => {
      seen.push(["verify", candidate]);
      return true;
    },
    sendSignal: (candidate, signal) => {
      seen.push([signal, candidate]);
      return true;
    },
  });
  assert.equal(delivered, true);
  assert.deepEqual(seen, [
    ["verify", reference],
    ["SIGTERM", reference],
  ]);
});

test("stable process reference closes on identity refusal and signal failure", async () => {
  for (const scenario of ["refuse", "fail-send"]) {
    let closes = 0;
    const reference = {
      ...fakeProcessReference(RECORD.pid),
      close() {
        closes += 1;
      },
    };
    const operation = signalProcessIfIdentityMatches(RECORD, "SIGTERM", {
      openProcessReference: () => reference,
      assertIdentity: () => scenario !== "refuse",
      sendSignal: () => {
        throw codedError("EPERM");
      },
    });
    if (scenario === "refuse") assert.equal(await operation, false);
    else await assert.rejects(operation, { code: "EPERM" });
    assert.equal(closes, 1);
  }
});

test("closed Linux process references cannot expose or reuse their old descriptor", (t) => {
  if (process.platform !== "linux") {
    t.skip("pidfd signalling is Linux-only");
    return;
  }
  const reference = openLinuxProcessReference(process.pid);
  assert.notEqual(reference, null);
  assert.ok(Number.isSafeInteger(reference.fd));
  reference.close();
  assert.throws(() => reference.fd, /already closed/);
  assert.throws(() => signalProcessReference(reference, 0), /already closed/);
  assert.doesNotThrow(() => reference.close());
});

test("Linux pidfd helper signals the opened process and never retargets after exit", async (t) => {
  if (process.platform !== "linux") {
    t.skip("pidfd signalling is Linux-only");
    return;
  }
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  const reference = openLinuxProcessReference(child.pid);
  assert.notEqual(reference, null);
  try {
    const observed = await observeLinuxProcess(child.pid, {
      processReference: reference,
    });
    assert.notEqual(observed, null);
    assert.equal(signalProcessReference(reference, "SIGTERM"), true);
    await once(child, "exit");
    assert.equal(child.signalCode, "SIGTERM");
    assert.equal(
      await observeLinuxProcess(child.pid, { processReference: reference }),
      null,
    );
    assert.equal(signalProcessReference(reference, "SIGTERM"), false);
  } finally {
    reference.close();
  }
});
