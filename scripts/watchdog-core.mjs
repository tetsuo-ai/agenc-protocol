import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  decodeUpgradeableProgramAccount,
  decodeUpgradeableProgramDataAccount,
  UPGRADEABLE_LOADER_ID,
} from "./program-upgrade-authority-policy.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
export const { Connection, PublicKey } = require("@solana/web3.js");
export const hash = (data) => createHash("sha256").update(data).digest("hex");
export const discriminator = (name) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
export const LOADER = new PublicKey(UPGRADEABLE_LOADER_ID);
const decimal = /^(0|[1-9][0-9]*)$/;

function keys(value, allowed, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} does not match the reviewed schema`);
  }
}

export function validateSettings(value) {
  keys(
    value,
    [
      "programId",
      "genesisHash",
      "expectedUpgradeAuthority",
      "vaultAddress",
      "bufferAuthorities",
      "squads",
      "pollIntervalMs",
      "discoveryIntervalMs",
      "staleAfterMs",
      "vaultTopUpLamports",
      "vaultOutflowLamports",
    ],
    "settings",
  );
  for (const name of [
    "programId",
    "genesisHash",
    "expectedUpgradeAuthority",
    "vaultAddress",
  ])
    new PublicKey(value[name]);
  if (
    !Array.isArray(value.bufferAuthorities) ||
    value.bufferAuthorities.length === 0 ||
    new Set(value.bufferAuthorities).size !== value.bufferAuthorities.length
  )
    throw new Error("bufferAuthorities must be a nonempty unique list");
  for (const address of value.bufferAuthorities) new PublicKey(address);
  if (!value.bufferAuthorities.includes(value.expectedUpgradeAuthority))
    throw new Error("bufferAuthorities must include expectedUpgradeAuthority");
  if (value.squads !== null) {
    keys(value.squads, ["programId", "multisig"], "squads");
    new PublicKey(value.squads.programId);
    new PublicKey(value.squads.multisig);
  }
  for (const name of ["pollIntervalMs", "discoveryIntervalMs", "staleAfterMs"])
    if (
      !Number.isSafeInteger(value[name]) ||
      value[name] < 100 ||
      value[name] > 300_000
    )
      throw new Error(`invalid ${name}`);
  if (value.staleAfterMs < value.pollIntervalMs * 2)
    throw new Error("staleAfterMs must allow two polling intervals");
  for (const name of ["vaultTopUpLamports", "vaultOutflowLamports"])
    if (
      typeof value[name] !== "string" ||
      !decimal.test(value[name]) ||
      BigInt(value[name]) < 1n
    )
      throw new Error(`invalid ${name}`);
  return structuredClone(value);
}

export function fixedAccounts(settings) {
  const [programData] = PublicKey.findProgramAddressSync(
    [new PublicKey(settings.programId).toBuffer()],
    LOADER,
  );
  return [
    { kind: "program", address: settings.programId },
    { kind: "program-data", address: programData.toBase58() },
    { kind: "vault", address: settings.vaultAddress },
    ...(settings.squads
      ? [{ kind: "multisig", address: settings.squads.multisig }]
      : []),
  ];
}

const memcmp = (offset, bytes) => ({
  memcmp: {
    offset,
    bytes: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
  },
});
export function discoveryFilters(settings) {
  return [
    ...settings.bufferAuthorities.map((authority) => ({
      kind: "buffer",
      program: LOADER,
      filters: [
        memcmp(0, [1, 0, 0, 0, 1]),
        memcmp(5, new PublicKey(authority).toBuffer()),
      ],
    })),
    ...(settings.squads
      ? ["Proposal", "VaultTransaction", "ConfigTransaction"].map((name) => ({
          kind: `squads-${name}`,
          program: new PublicKey(settings.squads.programId),
          filters: [
            memcmp(0, discriminator(name)),
            memcmp(8, new PublicKey(settings.squads.multisig).toBuffer()),
          ],
        }))
      : []),
  ];
}

export function accountView(kind, account, settings) {
  if (!account) return { missing: true };
  if (!Number.isSafeInteger(account.lamports) || account.lamports < 0)
    throw new Error("account lamports exceed the precise RPC integer range");
  const data = Buffer.from(account.data);
  const view = {
    owner: account.owner.toBase58(),
    executable: account.executable,
    lamports: String(account.lamports),
    dataSha256: hash(data),
    dataBytes: data.length,
  };
  if (kind === "program") {
    Object.assign(view, decodeUpgradeableProgramAccount(account, LOADER));
  } else if (kind === "program-data") {
    const decoded = decodeUpgradeableProgramDataAccount(account, LOADER);
    Object.assign(view, {
      upgradeAuthority: decoded.authority,
      deployedSlot: String(decoded.slot),
      // Includes all allocated payload padding, unlike a trimmed ELF hash.
      allocatedPayloadSha256: hash(decoded.payload),
      allocatedPayloadBytes: decoded.payload.length,
    });
  } else if (kind === "buffer") {
    if (
      !account.owner.equals(LOADER) ||
      account.executable ||
      data.length < 37 ||
      data.readUInt32LE(0) !== 1 ||
      data[4] !== 1
    )
      throw new Error("invalid upgradeable Buffer account");
    Object.assign(view, {
      authority: new PublicKey(data.subarray(5, 37)).toBase58(),
      payloadSha256: hash(data.subarray(37)),
      payloadBytes: data.length - 37,
    });
  } else if (kind === "multisig" || kind.startsWith("squads-")) {
    const name = kind === "multisig" ? "Multisig" : kind.slice(7);
    if (
      !settings.squads ||
      !account.owner.equals(new PublicKey(settings.squads.programId)) ||
      account.executable ||
      data.length < 40 ||
      !data.subarray(0, 8).equals(discriminator(name))
    )
      throw new Error("invalid Squads account owner/discriminator");
    if (kind !== "multisig") {
      const multisig = new PublicKey(data.subarray(8, 40)).toBase58();
      if (multisig !== settings.squads.multisig)
        throw new Error("wrong Squads multisig");
      const indexOffset = name === "Proposal" ? 40 : 72;
      if (data.length < indexOffset + 8)
        throw new Error("truncated Squads account");
      Object.assign(view, {
        multisig,
        transactionIndex: String(data.readBigUInt64LE(indexOffset)),
      });
      if (name === "Proposal") {
        if (data.length < 49 || data[48] > 6)
          throw new Error("unknown Squads proposal status");
        view.proposalStatus = [
          "Draft",
          "Active",
          "Rejected",
          "Approved",
          "Executing",
          "Executed",
          "Cancelled",
        ][data[48]];
      }
    }
  }
  return view;
}

export function atomicJson(path, value) {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

/** A local durable outbox. Delivery is at-least-once; receivers deduplicate by id. */
export class AlertOutbox {
  constructor(directory, webhook, token) {
    this.directory = directory;
    this.webhook = new URL(webhook);
    if (
      this.webhook.username ||
      this.webhook.password ||
      !(
        this.webhook.protocol === "https:" ||
        (this.webhook.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(this.webhook.hostname))
      )
    )
      throw new Error("webhook requires HTTPS (HTTP allowed only on loopback)");
    this.token = token;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "delivered"), { recursive: true, mode: 0o700 });
    this.lastDeliveryError = null;
  }
  enqueue(event) {
    const id = hash(JSON.stringify(event));
    const path = join(this.directory, `${id}.json`);
    if (
      !existsSync(path) &&
      !existsSync(join(this.directory, "delivered", `${id}.json`))
    )
      atomicJson(path, {
        schemaVersion: 1,
        id,
        observedAt: new Date().toISOString(),
        ...event,
      });
    return id;
  }
  pending() {
    return readdirSync(this.directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
  }
  async deliver() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const name of this.pending().slice(0, 20)) {
        const path = join(this.directory, name);
        const body = readFileSync(path, "utf8");
        const response = await fetch(this.webhook, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "idempotency-key": name.slice(0, -5),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        renameSync(path, join(this.directory, "delivered", name));
      }
      this.lastDeliveryError = null;
    } catch (error) {
      // Never print endpoint credentials, authorization headers, or RPC URLs.
      this.lastDeliveryError =
        error instanceof Error ? error.name : "DeliveryError";
    } finally {
      this.delivering = false;
    }
  }
}

export class ObservationTracker {
  constructor(baseline, emit) {
    this.baseline = baseline;
    this.emit = emit;
    this.latest = new Map(
      baseline.accounts.map((entry) => [entry.address, entry]),
    );
  }
  observe(kind, address, account, slot, source) {
    if (!Number.isSafeInteger(slot) || slot < 0)
      throw new Error("invalid RPC context slot");
    const previous = this.latest.get(address);
    if (previous && slot < previous.slot) return; // late poll must not roll back a WS observation
    let view;
    try {
      view = accountView(kind, account, this.baseline.settings);
    } catch (error) {
      view = {
        invalid: error.message,
        dataSha256: hash(Buffer.from(account?.data ?? [])),
      };
    }
    const entry = { kind, address, slot, view };
    const changed =
      !previous || JSON.stringify(previous.view) !== JSON.stringify(view);
    if (!changed) {
      this.latest.set(address, entry);
      return;
    }
    const type = !previous ? `${kind}-discovered` : `${kind}-changed`;
    let deltaLamports = null;
    if (
      kind === "vault" &&
      previous?.view.lamports !== undefined &&
      view.lamports !== undefined
    ) {
      deltaLamports = BigInt(view.lamports) - BigInt(previous.view.lamports);
      const s = this.baseline.settings;
      const structuralChange =
        previous.view.owner !== view.owner ||
        previous.view.dataSha256 !== view.dataSha256;
      if (
        !structuralChange &&
        deltaLamports < BigInt(s.vaultTopUpLamports) &&
        -deltaLamports < BigInt(s.vaultOutflowLamports)
      ) {
        // Keep the last reported balance: multiple small transfers accumulate.
        this.latest.set(address, { ...previous, slot });
        return;
      }
    }
    this.emit({
      type,
      address,
      slot,
      source,
      previous: previous?.view ?? null,
      current: view,
      ...(deltaLamports === null
        ? {}
        : { deltaLamports: String(deltaLamports) }),
    });
    this.latest.set(address, entry);
  }
}
