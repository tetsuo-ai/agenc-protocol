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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  decodeUpgradeableProgramAccount,
  decodeUpgradeableProgramDataAccount,
  UPGRADEABLE_LOADER_ID,
} from "./program-upgrade-authority-policy.mjs";
import { decodeProtocolControls } from "./protocol-config-monitor.mjs";

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
      ...(Object.hasOwn(value ?? {}, "protocolMonitoring")
        ? ["protocolMonitoring"]
        : []),
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
  if (value.protocolMonitoring !== undefined) {
    keys(
      value.protocolMonitoring,
      ["treasuryInflowLamports", "treasuryOutflowLamports"],
      "protocolMonitoring",
    );
    for (const threshold of Object.values(value.protocolMonitoring))
      if (
        typeof threshold !== "string" ||
        !decimal.test(threshold) ||
        BigInt(threshold) < 1n
      )
        throw new Error("invalid treasury threshold");
  }
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
    ...(settings.protocolMonitoring
      ? [
          {
            kind: "protocol",
            address: PublicKey.findProgramAddressSync(
              [Buffer.from("protocol")],
              new PublicKey(settings.programId),
            )[0].toBase58(),
          },
        ]
      : []),
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
  if (kind === "protocol") {
    if (account.owner.toBase58() !== settings.programId || account.executable)
      throw new Error("invalid ProtocolConfig owner/executable flag");
    view.admin = decodeProtocolControls(data);
  } else if (kind === "program") {
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
  constructor(
    directory,
    webhook,
    token,
    {
      now = Date.now,
      maxAttempts = 8,
      retryBaseMs = 1000,
      retryMaxMs = 60_000,
      requestTimeoutMs = 5000,
    } = {},
  ) {
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
    for (const value of [
      maxAttempts,
      retryBaseMs,
      retryMaxMs,
      requestTimeoutMs,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("invalid outbox retry policy");
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.requestTimeoutMs = requestTimeoutMs;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const subdirectory of ["delivered", "attempts", "dead-letter"])
      mkdirSync(join(directory, subdirectory), {
        recursive: true,
        mode: 0o700,
      });
    this.refreshDeliveryError();
  }
  enqueue(event) {
    const id = hash(JSON.stringify(event));
    const path = join(this.directory, `${id}.json`);
    if (
      !existsSync(path) &&
      !existsSync(join(this.directory, "delivered", `${id}.json`)) &&
      !existsSync(join(this.directory, "dead-letter", `${id}.json`))
    )
      atomicJson(path, {
        ...event,
        schemaVersion: 1,
        id,
        observedAt: new Date(this.now()).toISOString(),
      });
    return id;
  }
  pending() {
    return readdirSync(this.directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => {
        let observedAt = "";
        try {
          observedAt =
            JSON.parse(readFileSync(join(this.directory, name), "utf8"))
              .observedAt ?? "";
        } catch {
          /* Invalid records are quarantined individually by deliver(). */
        }
        return { name, observedAt: String(observedAt) };
      })
      .sort(
        (a, b) =>
          a.observedAt.localeCompare(b.observedAt) ||
          a.name.localeCompare(b.name),
      )
      .map(({ name }) => name);
  }
  deadLetterIds() {
    return readdirSync(join(this.directory, "dead-letter"))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5))
      .sort();
  }
  refreshDeliveryError() {
    this.lastDeliveryError = this.pending().some((name) =>
      existsSync(join(this.directory, "attempts", name)),
    )
      ? "RetryPending"
      : null;
  }
  move(name, destination) {
    renameSync(
      join(this.directory, name),
      join(this.directory, destination, name),
    );
    for (const directory of [
      this.directory,
      join(this.directory, destination),
    ]) {
      const fd = openSync(directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  async deliver({ signal } = {}) {
    if (this.delivering) return;
    this.delivering = true;
    try {
      let attempted = 0;
      for (const name of this.pending()) {
        if (signal?.aborted) break;
        const attemptPath = join(this.directory, "attempts", name);
        let retry, body;
        try {
          retry = existsSync(attemptPath)
            ? JSON.parse(readFileSync(attemptPath, "utf8"))
            : { attempts: 0, nextAttemptAt: 0 };
          if (
            !Number.isSafeInteger(retry.attempts) ||
            retry.attempts < 0 ||
            !Number.isSafeInteger(retry.nextAttemptAt) ||
            retry.nextAttemptAt < 0
          )
            throw new Error("invalid retry state");
          body = readFileSync(join(this.directory, name), "utf8");
          const event = JSON.parse(body);
          if (
            event.id !== name.slice(0, -5) ||
            event.schemaVersion !== 1 ||
            !Number.isFinite(Date.parse(event.observedAt))
          )
            throw new Error("invalid alert record");
        } catch {
          atomicJson(attemptPath, { lastError: "InvalidOutboxRecord" });
          this.move(name, "dead-letter");
          continue;
        }
        if (retry.attempts >= this.maxAttempts) {
          this.move(name, "dead-letter");
          continue;
        }
        if (retry.nextAttemptAt > this.now()) continue;
        if (attempted++ >= 20) break;
        retry = {
          attempts: retry.attempts + 1,
          nextAttemptAt:
            this.now() +
            Math.min(
              this.retryMaxMs,
              this.retryBaseMs * 2 ** Math.min(retry.attempts, 30),
            ),
          lastError: "DeliveryInterrupted",
        };
        // Write before sending: a process crash cannot reset attempts or backoff.
        atomicJson(attemptPath, retry);
        let delivered = false;
        try {
          const timeout = AbortSignal.timeout(this.requestTimeoutMs);
          const response = await fetch(this.webhook, {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              "idempotency-key": name.slice(0, -5),
              ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
            body,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          // A bare 409/422 is not proof of durable acceptance by the receiver.
          delivered =
            response.ok ||
            (response.status === 409 &&
              response.headers.get("idempotency-key") === name.slice(0, -5) &&
              response.headers.get("x-agenc-delivery-status") === "duplicate");
          await response.body?.cancel();
          if (!delivered) retry.lastError = `HTTP${response.status}`;
        } catch (error) {
          // Never persist endpoint credentials, headers or arbitrary error messages.
          retry.lastError =
            error?.name === "TimeoutError" ? "TimeoutError" : "DeliveryError";
        }
        if (delivered) {
          this.move(name, "delivered");
          unlinkSync(attemptPath);
        } else {
          atomicJson(attemptPath, retry);
          if (retry.attempts >= this.maxAttempts)
            this.move(name, "dead-letter");
        }
      }
    } finally {
      this.refreshDeliveryError();
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
    const comparable = (value) => {
      if (kind === "protocol") {
        // Telemetry and unsolicited donations do not alter administrative controls.
        const {
          dataSha256: _telemetry,
          lamports: _donations,
          ...adminView
        } = value;
        return adminView;
      }
      if (kind !== "program" && kind !== "program-data") return value;
      const { lamports: _donations, ...semantic } = value;
      return semantic;
    };
    const changed =
      !previous ||
      JSON.stringify(comparable(previous.view)) !==
        JSON.stringify(comparable(view));
    if (!changed) {
      this.latest.set(address, entry);
      return;
    }
    const type = !previous ? `${kind}-discovered` : `${kind}-changed`;
    let deltaLamports = null;
    if (
      (kind === "vault" || kind === "treasury") &&
      previous?.view.lamports !== undefined &&
      view.lamports !== undefined
    ) {
      deltaLamports = BigInt(view.lamports) - BigInt(previous.view.lamports);
      const s = this.baseline.settings;
      const isTreasury =
        kind === "treasury" ||
        (s.protocolMonitoring &&
          [...this.latest.values()].some(
            (entry) =>
              entry.kind === "protocol" &&
              entry.view.admin?.treasury === address,
          ));
      const smaller = (a, b) => (BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b));
      const inflow = isTreasury
        ? kind === "vault"
          ? smaller(
              s.vaultTopUpLamports,
              s.protocolMonitoring.treasuryInflowLamports,
            )
          : BigInt(s.protocolMonitoring.treasuryInflowLamports)
        : BigInt(s.vaultTopUpLamports);
      const outflow = isTreasury
        ? kind === "vault"
          ? smaller(
              s.vaultOutflowLamports,
              s.protocolMonitoring.treasuryOutflowLamports,
            )
          : BigInt(s.protocolMonitoring.treasuryOutflowLamports)
        : BigInt(s.vaultOutflowLamports);
      const structuralChange =
        previous.view.owner !== view.owner ||
        previous.view.executable !== view.executable ||
        previous.view.dataSha256 !== view.dataSha256;
      if (
        !structuralChange &&
        deltaLamports < inflow &&
        -deltaLamports < outflow
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
