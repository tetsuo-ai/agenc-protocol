import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  accountView,
  ObservationTracker,
  PublicKey,
} from "./watchdog-core.mjs";
import {
  decodeProtocolControls,
  PROTOCOL_CONFIG_MONITOR_BYTES,
} from "./protocol-config-monitor.mjs";

const key = (n) => new PublicKey(Buffer.alloc(32, n));
const settings = {
  programId: key(9).toBase58(),
  vaultTopUpLamports: "100000",
  vaultOutflowLamports: "100000",
  protocolMonitoring: {
    treasuryInflowLamports: "100",
    treasuryOutflowLamports: "100",
  },
};
function fixture() {
  // Wire offsets independently match the published 351-byte revision-5 account.
  const data = Buffer.alloc(351);
  createHash("sha256")
    .update("account:ProtocolConfig")
    .digest()
    .subarray(0, 8)
    .copy(data);
  key(1).toBuffer().copy(data, 8);
  key(2).toBuffer().copy(data, 40);
  data[140] = 2;
  data[141] = 3;
  for (let i = 0; i < 3; i++)
    key(i + 1)
      .toBuffer()
      .copy(data, 189 + 32 * i);
  data[185] = 1;
  data[186] = 1;
  data.writeUInt16LE(5, 349);
  return { data, owner: key(9), executable: false, lamports: 3000000 };
}
test("IDL-derived controls match the deployed layout and reject malformed schema/multisig", () => {
  assert.equal(PROTOCOL_CONFIG_MONITOR_BYTES, 351);
  const original = fixture();
  const controls = decodeProtocolControls(original.data);
  assert.equal(controls.treasury, key(2).toBase58());
  assert.equal(controls.multisig_threshold, 2);
  assert.equal(controls.surface_revision, 5);
  assert.equal(Object.hasOwn(controls, "total_tasks"), false);
  assert.throws(
    () => decodeProtocolControls(original.data.subarray(0, 349)),
    /IDL layout/,
  );
  original.data[140] = 3;
  assert.throws(() => decodeProtocolControls(original.data), /multisig/);
  original.data[140] = 2;
  original.data[187] = 2;
  assert.throws(() => decodeProtocolControls(original.data), /bool/);
});
test("ordinary telemetry is quiet; every requested admin field and invalid data alert", () => {
  const original = fixture(),
    address = key(8).toBase58(),
    events = [];
  const tracker = new ObservationTracker(
    {
      settings,
      accounts: [
        {
          kind: "protocol",
          address,
          slot: 1,
          view: accountView("protocol", original, settings),
        },
      ],
    },
    (event) => events.push(event),
  );
  original.data.writeBigUInt64LE(4n, 115); // total_tasks: only telemetry
  tracker.observe("protocol", address, original, 2, "poll");
  assert.equal(events.length, 0);
  let slot = 3;
  for (const offset of [40, 140, 141, 186, 187, 189, 349]) {
    const changed = fixture();
    changed.data[offset] ^= 1;
    tracker.observe("protocol", address, changed, slot++, "websocket");
    assert.equal(events.at(-1).type, "protocol-changed");
    tracker.observe("protocol", address, fixture(), slot++, "websocket");
  }
  assert.equal(events.length, 14);
  tracker.observe(
    "protocol",
    address,
    { ...fixture(), owner: key(7) },
    slot++,
    "poll",
  );
  assert.match(events.at(-1).current.invalid, /owner/);
});
test("treasury/vault overlap uses the stricter treasury movement threshold", () => {
  const address = key(2).toBase58(),
    events = [];
  const vault = {
    data: Buffer.alloc(0),
    owner: key(0),
    executable: false,
    lamports: 1000,
  };
  const tracker = new ObservationTracker(
    {
      settings,
      accounts: [
        {
          kind: "vault",
          address,
          slot: 1,
          view: accountView("vault", vault, settings),
        },
        {
          kind: "protocol",
          address: key(8).toBase58(),
          slot: 1,
          view: accountView("protocol", fixture(), settings),
        },
      ],
    },
    (event) => events.push(event),
  );
  tracker.observe("vault", address, { ...vault, lamports: 850 }, 2, "poll");
  assert.equal(events[0].deltaLamports, "-150");
});
