import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  accountView,
  AlertOutbox,
  discriminator,
  discoveryFilters,
  fixedAccounts,
  LOADER,
  ObservationTracker,
  PublicKey,
  validateSettings,
} from "./watchdog-core.mjs";
import { validateBaseline, watch } from "./upgrade-watchdog.mjs";

const key = (n) => new PublicKey(Buffer.alloc(32, n));
const settings = {
  programId: key(1).toBase58(),
  genesisHash: key(2).toBase58(),
  expectedUpgradeAuthority: key(3).toBase58(),
  vaultAddress: key(4).toBase58(),
  bufferAuthorities: [key(3).toBase58()],
  squads: { programId: key(5).toBase58(), multisig: key(6).toBase58() },
  pollIntervalMs: 1000,
  discoveryIntervalMs: 2000,
  staleAfterMs: 5000,
  vaultTopUpLamports: "100",
  vaultOutflowLamports: "100",
};
const account = (data, owner = LOADER, lamports = 123456) => ({
  data,
  owner,
  lamports,
  executable: false,
});
function programData(
  slot = 1n,
  authority = key(3),
  payload = Buffer.from([1, 2, 3]),
) {
  const data = Buffer.alloc(45 + payload.length);
  data.writeUInt32LE(3);
  data.writeBigUInt64LE(slot, 4);
  data[12] = 1;
  authority.toBuffer().copy(data, 13);
  payload.copy(data, 45);
  return account(data);
}

function monitorBaseline() {
  const monitorSettings = { ...settings, squads: null };
  const dataAddress = fixedAccounts(monitorSettings)[1].address;
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(2);
  new PublicKey(dataAddress).toBuffer().copy(bytes, 4);
  const fixtures = [
    { ...account(bytes), executable: true },
    programData(),
    account(Buffer.alloc(0), key(7)),
  ];
  const baseline = {
    schemaVersion: 1,
    settings: monitorSettings,
    accounts: fixedAccounts(monitorSettings).map((entry, i) => ({
      ...entry,
      slot: 10,
      view: accountView(entry.kind, fixtures[i], monitorSettings),
    })),
  };
  return baseline;
}

test("ProgramData independently detects deployment slot, authority, payload, owner and malformed metadata", () => {
  const original = accountView("program-data", programData(), settings);
  assert.notEqual(
    accountView("program-data", programData(2n), settings).deployedSlot,
    original.deployedSlot,
  );
  assert.notEqual(
    accountView("program-data", programData(1n, key(8)), settings)
      .upgradeAuthority,
    original.upgradeAuthority,
  );
  assert.notEqual(
    accountView(
      "program-data",
      programData(1n, key(3), Buffer.from([1, 2, 4])),
      settings,
    ).allocatedPayloadSha256,
    original.allocatedPayloadSha256,
  );
  assert.throws(
    () =>
      accountView(
        "program-data",
        account(programData().data, key(8)),
        settings,
      ),
    /owner/,
  );
  const invalid = programData();
  invalid.data[12] = 2;
  assert.throws(
    () => accountView("program-data", invalid, settings),
    /Option tag/,
  );
  assert.throws(() =>
    accountView("program-data", account(Buffer.alloc(44)), settings),
  );
});

test("Buffer filtering uses loader variant and authority; no nonexistent target-program field", () => {
  const filters = discoveryFilters(settings);
  assert.equal(filters.length, 4);
  assert.equal(filters[0].filters[1].memcmp.offset, 5);
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32LE(1);
  bytes[4] = 1;
  key(3).toBuffer().copy(bytes, 5);
  bytes[39] = 42;
  const view = accountView("buffer", account(bytes), settings);
  assert.equal(view.authority, key(3).toBase58());
  assert.equal(view.payloadBytes, 3);
  assert.equal(Object.hasOwn(view, "programId"), false);
  assert.throws(() => accountView("buffer", account(bytes, key(8)), settings));
});

test("Squads proposal namespace is owner/multisig/discriminator-bound, including cancelled status", () => {
  const bytes = Buffer.alloc(80);
  discriminator("Proposal").copy(bytes);
  key(6).toBuffer().copy(bytes, 8);
  bytes.writeBigUInt64LE(512n, 40);
  bytes[48] = 6;
  const view = accountView("squads-Proposal", account(bytes, key(5)), settings);
  assert.equal(view.transactionIndex, "512");
  assert.equal(view.proposalStatus, "Cancelled");
  assert.throws(() =>
    accountView("squads-Proposal", account(bytes, key(8)), settings),
  );
  bytes[48] = 7;
  assert.throws(
    () => accountView("squads-Proposal", account(bytes, key(5)), settings),
    /unknown/,
  );
  bytes[48] = 3;
  key(9).toBuffer().copy(bytes, 8);
  assert.throws(
    () => accountView("squads-Proposal", account(bytes, key(5)), settings),
    /multisig/,
  );
});

test("tracker reports startup drift, ignores older RPC slots, detects restoration and accumulates small vault transfers", () => {
  const events = [];
  const dataAddress = fixedAccounts(settings)[1].address;
  const vault = account(Buffer.alloc(0), key(7), 1000);
  const baseline = {
    settings,
    accounts: [
      {
        kind: "program-data",
        address: dataAddress,
        slot: 10,
        view: accountView("program-data", programData(), settings),
      },
      {
        kind: "vault",
        address: settings.vaultAddress,
        slot: 10,
        view: accountView("vault", vault, settings),
      },
    ],
  };
  const tracker = new ObservationTracker(baseline, (event) =>
    events.push(event),
  );
  tracker.observe(
    "program-data",
    dataAddress,
    programData(2n),
    15,
    "websocket",
  );
  tracker.observe("program-data", dataAddress, programData(), 14, "poll");
  assert.equal(events.length, 1);
  tracker.observe("program-data", dataAddress, programData(), 16, "poll");
  assert.equal(events.length, 2);
  tracker.observe(
    "vault",
    settings.vaultAddress,
    { ...vault, lamports: 1060 },
    17,
    "poll",
  );
  assert.equal(events.length, 2);
  tracker.observe(
    "vault",
    settings.vaultAddress,
    { ...vault, lamports: 1120 },
    18,
    "poll",
  );
  assert.equal(events[2].deltaLamports, "120");
  tracker.observe("program-data", dataAddress, null, 19, "poll");
  assert.equal(events[3].current.missing, true);
  tracker.observe(
    "program-data",
    dataAddress,
    account(Buffer.alloc(1)),
    20,
    "poll",
  );
  assert.match(events[4].current.invalid, /length/);
});

test("settings and baseline reject incomplete monitoring and unknown policy fields", () => {
  assert.deepEqual(validateSettings(settings), settings);
  assert.throws(() => validateSettings({ ...settings, bufferAuthorities: [] }));
  assert.throws(() =>
    validateSettings({ ...settings, bufferAuthorities: [key(9).toBase58()] }),
  );
  assert.throws(() =>
    validateSettings({ ...settings, vaultTopUpLamports: "-1" }),
  );
  assert.throws(() => validateSettings({ ...settings, typo: true }));
  assert.throws(
    () => validateBaseline({ schemaVersion: 1, settings, accounts: [] }),
    /pin/,
  );
});

test("outbox survives failed delivery and process recreation, preserves idempotency and does not follow redirects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-watchdog-outbox-"));
  let responseCode = 503;
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({
      event: JSON.parse(body),
      id: req.headers["idempotency-key"],
    });
    res.writeHead(responseCode, {
      location: "http://127.0.0.1:1/must-not-follow",
    });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let now = Date.now();
  const options = { now: () => now };
  try {
    const first = new AlertOutbox(directory, url, undefined, options);
    const id = first.enqueue({ type: "program-data-changed", slot: 99 });
    await first.deliver();
    assert.equal(first.pending().length, 1);
    responseCode = 302;
    now += 1000;
    await first.deliver();
    assert.equal(first.pending().length, 1);
    responseCode = 204;
    now += 2000;
    const restarted = new AlertOutbox(directory, url, undefined, options);
    await restarted.deliver();
    assert.equal(restarted.pending().length, 0);
    assert.equal(
      restarted.enqueue({ type: "program-data-changed", slot: 99 }),
      id,
    );
    assert.equal(restarted.pending().length, 0);
    assert.equal(
      JSON.parse(readFileSync(join(directory, "delivered", `${id}.json`))).id,
      id,
    );
    assert.ok(
      received.every((entry) => entry.event.id === id && entry.id === id),
    );
    assert.throws(
      () => new AlertOutbox(directory, "http://example.com"),
      /HTTPS/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});

test("a rejected alert cannot block later alerts; backoff, attempts and dead letters survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-watchdog-poison-"));
  let now = Date.now();
  const options = { now: () => now, maxAttempts: 3 };
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const event = JSON.parse(body);
    received.push(event);
    res.writeHead(event.poison ? 400 : 204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    let outbox = new AlertOutbox(directory, url, undefined, options);
    const bad = outbox.enqueue({ type: "program-data-changed", poison: true });
    const good = [];
    for (let slot = 1; slot <= 7; slot++) {
      now++;
      good.push(outbox.enqueue({ type: "program-data-changed", slot }));
    }
    await outbox.deliver();
    assert.deepEqual(outbox.pending(), [`${bad}.json`]);
    assert.deepEqual(
      received.map((e) => e.id),
      [bad, ...good],
    );
    assert.ok(outbox.lastDeliveryError);
    outbox = new AlertOutbox(directory, url, undefined, options);
    for (let i = 0; i < 50; i++) await outbox.deliver();
    assert.equal(
      received.length,
      8,
      "restart and polling must not reset backoff",
    );
    now += 1000;
    await outbox.deliver();
    assert.equal(received.length, 9);
    now += 1999;
    await outbox.deliver();
    assert.equal(received.length, 9, "second retry waits two seconds");
    now++;
    await outbox.deliver();
    assert.equal(received.length, 10);
    assert.deepEqual(outbox.pending(), []);
    assert.deepEqual(outbox.deadLetterIds(), [bad]);
    outbox = new AlertOutbox(directory, url, undefined, options);
    assert.deepEqual(outbox.deadLetterIds(), [bad]);
    assert.equal(
      outbox.enqueue({ type: "program-data-changed", poison: true }),
      bad,
    );
    assert.deepEqual(
      outbox.pending(),
      [],
      "dead letters require explicit operator recovery",
    );
    const last = outbox.enqueue({ type: "vault-changed", slot: 100 });
    await outbox.deliver();
    assert.equal(received.at(-1).id, last);
    assert.equal(
      JSON.parse(readFileSync(join(directory, "attempts", `${bad}.json`)))
        .attempts,
      3,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});

test("timeout after receiver acceptance is recovered only by a duplicate acknowledgement bound to the same id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-watchdog-duplicate-"));
  let now = Date.now(),
    attempts = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(body);
    attempts++;
    if (attempts === 1) return; // Durably accepted, but the response is lost.
    res
      .writeHead(409, {
        "idempotency-key":
          attempts === 2 ? "wrong-id" : req.headers["idempotency-key"],
        ...(attempts >= 4 ? { "x-agenc-delivery-status": "duplicate" } : {}),
      })
      .end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { now: () => now, requestTimeoutMs: 200 };
  try {
    let outbox = new AlertOutbox(directory, url, undefined, options);
    const id = outbox.enqueue({ type: "program-data-changed", slot: 8 });
    await outbox.deliver();
    assert.equal(outbox.pending().length, 1);
    for (const wait of [1000, 2000, 4000]) {
      now += wait;
      outbox = new AlertOutbox(directory, url, undefined, options);
      await outbox.deliver();
      assert.equal(outbox.pending().length, wait === 4000 ? 0 : 1);
    }
    assert.equal(attempts, 4);
    assert.equal(
      new Set(requests).size,
      1,
      "retry body and id remain immutable",
    );
    assert.equal(
      JSON.parse(readFileSync(join(directory, "delivered", `${id}.json`))).id,
      id,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});

test("lamport-only program donations do not masquerade as upgrades; semantic changes still alert", () => {
  const events = [];
  const dataAddress = fixedAccounts(settings)[1].address;
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(2);
  new PublicKey(dataAddress).toBuffer().copy(bytes, 4);
  const program = { ...account(bytes), executable: true };
  const fixtures = [
    ["program", settings.programId, program],
    ["program-data", dataAddress, programData()],
  ];
  const tracker = new ObservationTracker(
    {
      settings,
      accounts: fixtures.map(([kind, address, value]) => ({
        kind,
        address,
        slot: 10,
        view: accountView(kind, value, settings),
      })),
    },
    (event) => events.push(event),
  );
  for (const [kind, address, value] of fixtures) {
    tracker.observe(
      kind,
      address,
      { ...value, lamports: value.lamports + 1 },
      11,
      "websocket",
    );
  }
  assert.deepEqual(events, []);
  tracker.observe("program-data", dataAddress, programData(2n), 12, "poll");
  assert.equal(events[0].current.deployedSlot, "2");
  tracker.observe(
    "program",
    settings.programId,
    { ...program, owner: key(9) },
    13,
    "poll",
  );
  assert.ok(events[1].current.invalid);
});

test("recurring genesis mismatches create distinct incidents and mid-run mismatch retains its named reason", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-watchdog-genesis-"));
  const baseline = monitorBaseline();
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const outbox = new AlertOutbox(
    join(directory, "outbox"),
    `http://127.0.0.1:${server.address().port}`,
  );
  const controller = new AbortController();
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        watch({
          connection: { getGenesisHash: async () => key(9).toBase58() },
          baseline,
          stateDirectory: directory,
          outbox,
          signal: controller.signal,
          pollingOnly: true,
        }),
        /genesis mismatch/i,
      );
    }
    assert.equal(received.length, 2);
    assert.notEqual(received[0].id, received[1].id);
    let calls = 0;
    const running = watch({
      connection: {
        getGenesisHash: async () =>
          calls++ === 0 ? settings.genesisHash : key(9).toBase58(),
      },
      baseline,
      stateDirectory: directory,
      outbox,
      signal: controller.signal,
      pollingOnly: true,
    });
    try {
      for (
        let i = 0;
        i < 30 && !received.some((e) => e.reason === "GenesisMismatch");
        i++
      )
        await delay(50);
      assert.ok(
        received.some(
          (e) =>
            e.type === "monitor-degraded" && e.reason === "GenesisMismatch",
        ),
      );
    } finally {
      controller.abort();
      await running;
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});

test("dead letters remain visible in degraded health while unrelated alerts still arrive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-watchdog-health-"));
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const event = JSON.parse(body);
    received.push(event);
    res.writeHead(event.type === "rejected" ? 400 : 204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const outbox = new AlertOutbox(
    join(directory, "outbox"),
    `http://127.0.0.1:${server.address().port}`,
    undefined,
    { maxAttempts: 1 },
  );
  const controller = new AbortController();
  const baseline = monitorBaseline();
  const dataAddress = fixedAccounts(baseline.settings)[1].address;
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(2);
  new PublicKey(dataAddress).toBuffer().copy(bytes, 4);
  let slot = 11;
  const connection = {
    getGenesisHash: async () => settings.genesisHash,
    getMultipleAccountsInfoAndContext: async () => ({
      context: { slot: slot++ },
      value: [
        { ...account(bytes), executable: true },
        programData(),
        account(Buffer.alloc(0), key(7)),
      ],
    }),
    getProgramAccounts: async () => ({ context: { slot }, value: [] }),
  };
  let running;
  try {
    const id = outbox.enqueue({ type: "rejected" });
    await outbox.deliver();
    running = watch({
      connection,
      baseline,
      stateDirectory: directory,
      outbox,
      signal: controller.signal,
      pollingOnly: true,
    });
    for (
      let i = 0;
      i < 30 && !received.some((e) => e.reason === "pager-dead-letter");
      i++
    )
      await delay(50);
    const healthFile = join(directory, "health.json");
    assert.ok(existsSync(healthFile));
    const health = JSON.parse(readFileSync(healthFile));
    assert.equal(health.state, "pager-dead-letter");
    assert.deepEqual(health.deadLetterIds, [id]);
    assert.ok(
      received.some(
        (e) => e.reason === "pager-dead-letter" && e.deadLetterIds.includes(id),
      ),
    );
  } finally {
    controller.abort();
    await running;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true });
  }
});
