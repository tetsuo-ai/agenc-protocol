import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
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
import { validateBaseline } from "./upgrade-watchdog.mjs";

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
  try {
    const first = new AlertOutbox(directory, url);
    const id = first.enqueue({ type: "program-data-changed", slot: 99 });
    await first.deliver();
    assert.equal(first.pending().length, 1);
    responseCode = 302;
    await first.deliver();
    assert.equal(first.pending().length, 1);
    responseCode = 204;
    const restarted = new AlertOutbox(directory, url);
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
