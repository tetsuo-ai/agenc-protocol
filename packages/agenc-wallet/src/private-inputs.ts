import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type KeyPairSigner } from "@solana/kit";
import { findClaimPda, getTaskClaimDecoder, getTaskClaimDiscriminatorBytes, taskThread, TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import { readAgent, readProgramAccount, readTask } from "./market.js";
import type { Chain } from "./chain.js";
import { checkOutputAgreement, type OutputAgreement, type ExchangeReceipt, type PrivateFileView, type PrivateInputPart, type PrivateRequirement } from "./client/job-exchange.js";

export type Parties = taskThread.ExchangeParties;
export type Packet = taskThread.SignedPacket;
type Purpose = taskThread.ExchangePurpose;
export const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw new Error("The private job exchange could not verify this handoff."); };

export async function confirmedParties(chain: Chain, task: Address, worker: Address, room: string): Promise<Parties> {
  const [claim] = await findClaimPda({ task, bidder: worker });
  const [job, agent, held, now] = await Promise.all([readTask(chain, task), readAgent(chain, worker),
    readProgramAccount(chain, claim, getTaskClaimDiscriminatorBytes(), bytes => getTaskClaimDecoder().decode(bytes)), chain.clusterTime()]);
  if (!job || !agent || !held || held.task !== task || held.worker !== worker || held.isCompleted ||
      ![TaskStatus.InProgress, TaskStatus.PendingValidation].includes(job.status) ||
      (job.status === TaskStatus.InProgress && (now === null || [held.expiresAt, job.deadline].some(end => end > 0n && BigInt(now) >= end)))) return fail();
  const parties = { task, worker, claim, room, authority: agent.authority, buyer: job.creator, generation: Buffer.from(job.reserved).readBigUInt64LE(3).toString(), claimedAt: String(held.claimedAt) };
  taskThread.exchangeContext(parties);
  return parties;
}

/** One wallet service owns the directory under its existing process lock. Names
 * and file hashes are encrypted too. Only the signer can reopen the journal. */
export class ExchangeJournal {
  private constructor(private dir: string, private key: Buffer) {}
  static async open(dir: string, signer: KeyPairSigner) {
    const seed = await crypto.subtle.sign("Ed25519", signer.keyPair.privateKey, new TextEncoder().encode("agenc.private-wallet-storage.v1"));
    const folder = join(dir, "job-exchange", signer.address);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return new ExchangeJournal(folder, createHash("sha256").update(Buffer.from(seed)).digest());
  }
  read<T>(id: string): T | undefined {
    let raw: Buffer;
    try { raw = readFileSync(join(this.dir, digest(id))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    const cipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString("utf8"));
  }
  write(id: string, value: unknown) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const file = join(this.dir, digest(id));
    const temp = file + "." + randomBytes(8).toString("hex");
    writeFileSync(temp, Buffer.concat([nonce, cipher.getAuthTag(), data]), { mode: 0o600, flag: "wx", flush: true });
    renameSync(temp, file);
  }
}

export interface ExchangeFile extends PrivateFileView { base64: string }
export interface PrivateBundle {
  processing?: string;
  outputs?: OutputAgreement;
  salt: string;
  version: number;
  files: ExchangeFile[];
  text: string;
}

export function bundleManifest(bundle: PrivateBundle) {
  if (!/^[a-f0-9]{64}$/.test(bundle.salt) || !Number.isSafeInteger(bundle.version) || bundle.version < 1 ||
      !Array.isArray(bundle.files) || bundle.files.length > 8 || typeof bundle.text !== "string" || Buffer.byteLength(bundle.text) > 256 * 1024) return fail();
  const names = new Set<string>();
  const manifest = bundle.files.map(file => {
    if (typeof file.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(file.name) || file.name.includes("..") ||
        names.has(file.name.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 262144) return fail();
    names.add(file.name.toLowerCase());
    const bytes = taskThread.decodeExchangeBase64(file.base64, file.bytes);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) return fail();
    return [file.name, file.bytes, file.sha256];
  });
  return digest(JSON.stringify(["agenc.private-bundle.v1", bundle.salt, bundle.version, digest(bundle.text), manifest, ...(bundle.outputs ? [checkOutputAgreement(bundle.outputs)] : []), ...(bundle.processing !== undefined ? [bundle.processing] : [])]));
}

interface Staged { bundle: PrivateBundle; recipient: string | null; processing: string }
export function stagePrivateInputs(journal: ExchangeJournal, parts: PrivateInputPart[], recipient: string | null, processing: string, outputs?: OutputAgreement): PrivateRequirement {
  if (!Array.isArray(parts) || !parts.length || parts.length > 8 || typeof processing !== "string" || !processing.trim() || processing.length > 512) return fail();
  const files = parts.map(part => {
    if (!("stagedCommitment" in part)) return part;
    if (!/^[a-f0-9]{64}$/.test(part.stagedCommitment)) return fail();
    const saved = journal.read<Staged>("stage/" + part.stagedCommitment);
    if (!saved || saved.bundle.files.length !== 1 || saved.recipient !== recipient || saved.processing !== processing ||
        JSON.stringify(saved.bundle.outputs) !== JSON.stringify(outputs && checkOutputAgreement(outputs)) ||
        bundleManifest(saved.bundle) !== part.stagedCommitment) return fail();
    return saved.bundle.files[0]!;
  });
  const bundle = { files, processing, ...(outputs && { outputs: checkOutputAgreement(outputs) }), text: "", version: 1, salt: randomBytes(32).toString("hex") };
  const commitment = bundleManifest(bundle);
  journal.write("stage/" + commitment, { bundle, recipient, processing } satisfies Staged);
  return { required: true, version: 1, commitment };
}

export function requireHandoff(requirement: PrivateRequirement | undefined, supported: boolean) {
  if (requirement && (requirement.required !== true || requirement.version !== 1 || !/^[a-f0-9]{64}$/.test(requirement.commitment) || !supported)) {
    throw new Error("This job needs a room that supports private files.");
  }
}

/** Each operation re-reads confirmed chain state. The caller supplies its
 * trusted local room binding and derives task and worker from the job record. */
export class JobExchange {
  constructor(readonly journal: ExchangeJournal, readonly signer: KeyPairSigner, readonly live: () => Promise<Parties>, private staging = journal, private pinned?: () => Promise<PrivateRequirement | undefined>) {}
  private async checkRequirement(requirement: PrivateRequirement) {
    requireHandoff(requirement, true);
    if (this.pinned && (await this.pinned())?.commitment !== requirement.commitment) return fail();
  }

  async announceKey(): Promise<Packet> {
    const parties = await this.live();
    const id = "key/" + taskThread.exchangeContext(parties);
    let key = this.journal.read<Awaited<ReturnType<typeof taskThread.createExchangeKey>>>(id);
    if (!key) {
      const candidate = await taskThread.createExchangeKey();
      key = this.journal.read<typeof candidate>(id) ?? candidate;
      this.journal.write(id, key);
    }
    return taskThread.signPacket({ ...parties, purpose: "key", sender: this.signer.address, id: digest(id + key.publicKey).slice(0, 32) }, key.publicKey, this.signer);
  }

  async stagedPreview(requirement: PrivateRequirement) {
    await this.checkRequirement(requirement);
    const staged = this.staging.read<Staged>("stage/" + requirement.commitment);
    if (!staged || bundleManifest(staged.bundle) !== requirement.commitment) return fail();
    return { processing: staged.processing, files: staged.bundle.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) };
  }

  /** Owner-only handler. Consent pins the selected claim instance, room,
   * recipient key, and previously approved file set. */
  async grant(requirement: PrivateRequirement, approved: Parties, recipient: Packet) {
    await this.checkRequirement(requirement);
    const p = await this.live();
    const staged = this.staging.read<Staged>("stage/" + requirement.commitment);
    if (!staged || this.signer.address !== p.buyer || (staged.recipient && staged.recipient !== p.authority) ||
        bundleManifest(staged.bundle) !== requirement.commitment || taskThread.exchangeContext(p) !== taskThread.exchangeContext(approved)) return fail();
    await taskThread.verifyPacket(recipient, approved, approved.authority, "key");
    this.journal.write("grant/" + requirement.commitment + taskThread.exchangeContext(p), recipient);
  }

  /** Retrying an upload returns the original signed bytes. The relay uses
   * the signed ID as its idempotency key. A replaced claim has no grant. */
  async inputs(requirement: PrivateRequirement): Promise<Packet> {
    await this.checkRequirement(requirement);
    const parties = await this.live();
    const staged = this.staging.read<Staged>("stage/" + requirement.commitment);
    const recipient = this.journal.read<Packet>("grant/" + requirement.commitment + taskThread.exchangeContext(parties));
    if (!staged || !recipient || this.signer.address !== parties.buyer) return fail();
    return this.prepare(parties, "inputs", staged.bundle, recipient, requirement.commitment);
  }

  async prepare(parties: Parties, purpose: Exclude<Purpose, "read" | "collect" | "key">, value: unknown, recipient: Packet, operation: string): Promise<Packet> {
    if (taskThread.exchangeContext(await this.live()) !== taskThread.exchangeContext(parties)) return fail();
    const id = purpose === "output" ? digest(operation) : digest(JSON.stringify([taskThread.exchangeContext(parties), this.signer.address, purpose, operation, recipient.payload])).slice(0, 32);
    const body = JSON.stringify(value);
    const fingerprint = digest(body);
    const saved = () => this.journal.read<{ packet: Packet; fingerprint: string }>("out/" + id);
    const previous = saved();
    if (previous && previous.fingerprint !== fingerprint) return fail();
    const header = { ...parties, purpose, sender: this.signer.address, id,
      ...(purpose === "output" && { manifest: bundleManifest(value as PrivateBundle) }) };
    const packet = previous?.packet ?? await taskThread.sealPacket(header, Buffer.from(body), recipient, this.signer);
    const winner = saved();
    if (winner && winner.fingerprint !== fingerprint) return fail();
    if (winner) return winner.packet;
    this.journal.write("out/" + id, { packet, fingerprint });
    return packet;
  }

  async receive<T>(packet: Packet, purpose: Exclude<Purpose, "read" | "collect" | "key">): Promise<T> {
    const parties = await this.live();
    if (![parties.buyer, parties.authority].includes(this.signer.address)) return fail();
    const peer = this.signer.address === parties.buyer ? parties.authority : parties.buyer;
    const key = this.journal.read<Awaited<ReturnType<typeof taskThread.createExchangeKey>>>("key/" + taskThread.exchangeContext(parties));
    if (!key || (purpose === "inputs" && peer !== parties.buyer) || (purpose === "output" && peer !== parties.authority)) return fail();
    const bytes = await taskThread.openPacket(packet, parties, peer, purpose, key.privateKey);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  async receiveBundle(packet: Packet, purpose: "inputs" | "output", commitment: string) {
    if (purpose === "inputs") await this.checkRequirement({ version: 1, required: true, commitment });
    const bundle = await this.receive<PrivateBundle>(packet, purpose);
    if (bundleManifest(bundle) !== commitment) return fail();
    return bundle;
  }

  async confirmImport(requirement: PrivateRequirement, receipt: ExchangeReceipt, buyerKey: Packet): Promise<Packet> {
    const p = await this.live();
    if (this.signer.address !== p.authority || receipt.room !== p.room || requirement.commitment !== receipt.commitment ||
        receipt.manifest !== receipt.commitment || receipt.version < 1) return fail();
    return this.prepare(p, "receipt", receipt, buyerKey, receipt.commitment);
  }
}

export function privateOutputPointer(bundle: PrivateBundle, parties?: Parties) {
  const manifest = bundleManifest(bundle);
  return parties ? "agenc.private-output.v2:" + digest(JSON.stringify([taskThread.exchangeContext(parties), manifest]))
    : "agenc.private-output.v1:" + manifest;
}

export async function protectOutput(exchange: JobExchange, bundle: PrivateBundle, buyerKey: Packet): Promise<{ pointer: string; packet: Packet }> {
  const parties = await exchange.live();
  if (exchange.signer.address !== parties.authority) return fail();
  const pointer = privateOutputPointer(bundle, parties);
  const packet = await exchange.prepare(parties, "output", bundle, buyerKey, pointer);
  return { pointer, packet };
}

/** The original buyer can use its retained decryption key after claim closure.
 * Only a packet matching the submission or paid proof can enter this cache. */
export async function openBuyerOutput(journal: ExchangeJournal, parties: Parties, proofHash: string, packet: Packet) {
  if (packet.header.id !== proofHash) return fail();
  const key = journal.read<Awaited<ReturnType<typeof taskThread.createExchangeKey>>>("key/" + taskThread.exchangeContext(parties));
  if (!key) return fail();
  const bytes = await taskThread.openPacket(packet, parties, parties.authority, "output", key.privateKey);
  const bundle: PrivateBundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (digest(privateOutputPointer(bundle, parties)) !== proofHash) return fail();
  journal.write(JSON.stringify(["collected", parties.task, proofHash]), { parties, bundle });
  return bundle;
}

export async function openLegacyBuyerOutput(journal: ExchangeJournal, parties: Parties, pointer: string, key: Awaited<ReturnType<typeof taskThread.createExchangeKey>>, packet: Packet) {
  const id = digest(JSON.stringify([taskThread.legacyOutputContext(parties), parties.authority, "output", pointer, key.publicKey])).slice(0, 32);
  const bytes = await taskThread.openLegacyPaidOutput(packet, parties, id, key.privateKey);
  const bundle: PrivateBundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (privateOutputPointer(bundle) !== pointer) return fail();
  const commitment = bundleManifest(bundle);
  const { task, claim, claimedAt, authority: sender } = parties;
  journal.write(JSON.stringify(["output", task, claim, claimedAt, sender, commitment]), bundle);
  journal.write(JSON.stringify(["settled-output", task, digest(pointer)]), { claim, claimedAt, sender, commitment });
  return bundle;
}

export function approvedRequirement(journal: ExchangeJournal, commitment: string): PrivateRequirement {
  const staged = journal.read<Staged>("stage/" + commitment);
  if (!staged || bundleManifest(staged.bundle) !== commitment) return fail();
  return { version: 1, required: true, commitment };
}

/** Works with hosted job-spec schemas that retain only the canonical acceptance
 * list. Include this exact public criterion in both the quote and publication. */
const CRITERION = "Private input handoff v1: ";
export function privateInputCriterion(requirement: PrivateRequirement) {
  requireHandoff(requirement, true);
  return CRITERION + requirement.commitment;
}

export function privateRequirementFromSpec(spec: Record<string, unknown>): PrivateRequirement | undefined {
  const criteria = spec.acceptance ?? spec.acceptanceCriteria ?? [];
  if (!Array.isArray(criteria)) return fail();
  const rows = criteria.filter((row): row is string => typeof row === "string" && row.startsWith(CRITERION));
  if (rows.length > 1) return fail();
  const selected = rows.length ? { version: 1 as const, required: true as const, commitment: rows[0]!.slice(CRITERION.length) } : undefined;
  const explicit = spec.privateInputs as PrivateRequirement | undefined;
  if (explicit !== undefined && (!explicit || Object.keys(explicit).sort().join() !== "commitment,required,version")) return fail();
  requireHandoff(selected, true);
  requireHandoff(explicit, true);
  if (selected && explicit && selected.commitment !== explicit.commitment) return fail();
  return explicit ?? selected;
}


/** The provider authority the staged files were approved for, or null for any provider. */
export function approvedRecipient(journal: ExchangeJournal, commitment: string): string | null {
  const staged = journal.read<Staged>("stage/" + commitment);
  if (!staged || bundleManifest(staged.bundle) !== commitment) return fail();
  return staged.recipient;
}

export function approvedOutputs(journal: ExchangeJournal, requirement: PrivateRequirement) {
  const staged = journal.read<Staged>("stage/" + requirement.commitment);
  if (!staged || bundleManifest(staged.bundle) !== requirement.commitment) return fail();
  return staged.bundle.outputs;
}
