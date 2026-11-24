import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import type { PortableBusiness } from "./client/business.js";
import {
  serviceRehearsalKey,
  parseBusinessManifest,
} from "./client/business-manifest.js";
import { sellerTermsProblem } from "./client/seller-terms.js";
import { WalletError } from "./errors.js";
import type { WalletState } from "./store.js";

export const BUSINESS_FILE = "restored-business.json";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const sha = /^[0-9a-f]{64}$/;
function invalid(): never {
  throw new WalletError(
    "BAD_REQUEST",
    "The business backup contains invalid drafts or assets.",
  );
}
function fields(obj: unknown, allowed: string[]): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.keys(obj).every((k) => allowed.includes(k))
  );
}
function identifier(id: unknown) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

export function verifyPortableBusiness(
  business: PortableBusiness,
): PortableBusiness {
  if (
    !fields(business, ["version", "drafts", "services"]) ||
    business.version !== 1 ||
    !Array.isArray(business.drafts) ||
    business.drafts.length > 512 ||
    !Array.isArray(business.services) ||
    business.services.length > 512
  )
    invalid();
  const ids = new Set<string>();
  for (const draft of business.drafts) {
    if (
      !fields(draft, [
        "id",
        "agentId",
        "name",
        "description",
        "priceCents",
        "lamports",
        "terms",
        "createdAt",
      ]) ||
      !identifier(draft.id) ||
      !identifier(draft.agentId) ||
      typeof draft.name !== "string" ||
      !draft.name.trim() ||
      draft.name.length > 120 ||
      typeof draft.description !== "string" ||
      draft.description.length > 4096 ||
      !Number.isSafeInteger(draft.createdAt) ||
      !(draft.priceCents === null
        ? typeof draft.lamports === "string" &&
          /^[1-9][0-9]{0,19}$/.test(draft.lamports)
        : Number.isSafeInteger(draft.priceCents) &&
          draft.priceCents > 0 &&
          draft.lamports === undefined)
    )
      invalid();
    if (
      draft.terms &&
      (!fields(draft.terms, [
        "category",
        "tags",
        "inputs",
        "outputs",
        "maxOpenJobs",
        "deliverySecs",
        "operator",
        "operatorFeeBps",
        "childPolicy",
        "servicePin",
        "minimumMarginCents",
        "modelCapCents",
      ]) ||
        sellerTermsProblem(draft.terms))
    )
      invalid();
    const terms = draft.terms as
      | {
          servicePin?: {
            digest: string;
            runtimeDigest: string;
            permissionDigest: string;
            capabilities: string;
          };
          minimumMarginCents?: number;
          modelCapCents?: number;
        }
      | undefined;
    if (terms?.servicePin !== undefined) {
      const pin = terms.servicePin;
      if (
        !fields(pin, [
          "digest",
          "runtimeDigest",
          "permissionDigest",
          "capabilities",
        ]) ||
        ![pin.digest, pin.runtimeDigest, pin.permissionDigest].every(
          (v) => typeof v === "string" && sha.test(v),
        ) ||
        !["1", "5"].includes(pin.capabilities)
      )
        invalid();
    }
    if (
      terms?.modelCapCents !== undefined &&
      (!Number.isSafeInteger(terms.modelCapCents) || terms.modelCapCents < 1)
    )
      invalid();
    if (
      terms?.minimumMarginCents !== undefined &&
      (!Number.isSafeInteger(terms.minimumMarginCents) ||
        terms.minimumMarginCents < 0)
    )
      invalid();
    const key = draft.agentId + "/" + draft.id;
    if (ids.has(key)) invalid();
    ids.add(key);
  }
  let total = 0;
  const versions = new Set<string>();
  for (const service of business.services) {
    if (
      !fields(service, [
        "agentId",
        "listingId",
        "version",
        "assets",
        "manifest",
      ]) ||
      !identifier(service.agentId) ||
      !identifier(service.listingId) ||
      !identifier(service.version) ||
      !sha.test(service.manifest) ||
      !Array.isArray(service.assets) ||
      service.assets.length > 256
    )
      invalid();
    const key = [service.agentId, service.listingId, service.version].join("/");
    if (versions.has(key)) invalid();
    versions.add(key);
    const hashes = new Set<string>();
    for (const asset of service.assets) {
      if (
        !fields(asset, ["sha256", "base64"]) ||
        !sha.test(asset.sha256) ||
        hashes.has(asset.sha256) ||
        typeof asset.base64 !== "string" ||
        asset.base64.length > 2 * MAX_ASSET_BYTES
      )
        invalid();
      const bytes = Buffer.from(asset.base64, "base64");
      total += bytes.length;
      if (
        total > MAX_ASSET_BYTES ||
        bytes.toString("base64") !== asset.base64 ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
      )
        invalid();
      hashes.add(asset.sha256);
    }
    const encoded = service.assets.find(
      (a) => a.sha256 === service.manifest,
    )?.base64;
    if (!encoded || encoded.length > 44_000) invalid();
    const manifest = parseBusinessManifest(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    const assets = new Map(service.assets.map((a) => [a.sha256, a.base64]));
    if (
      hashes.size !==
        new Set([service.manifest, ...manifest.files.map((f) => f.sha256)])
          .size ||
      manifest.files.some(
        (f) =>
          !assets.has(f.sha256) ||
          Buffer.from(assets.get(f.sha256)!, "base64").length !== f.bytes,
      )
    )
      invalid();
  }
  return business;
}

export function restoredBusiness(dir: string): PortableBusiness | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, BUSINESS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return verifyPortableBusiness(JSON.parse(text) as PortableBusiness);
}

export function stagedBusiness(dir: string, id: string): PortableBusiness {
  if (!/^[0-9a-f]{32}$/.test(id)) invalid();
  const fd = openSync(
    path.join(dir, "backup-business-" + id + ".json"),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) invalid();
    return verifyPortableBusiness(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function requireFreshRehearsals(
  dir: string,
  restoredAt: number,
  business?: PortableBusiness,
) {
  const expected = [
    ...new Set(
      business?.services.map((s) => serviceRehearsalKey(s.agentId, s.manifest)),
    ),
  ].sort();
  if (!expected.length) return;
  try {
    const receipt = JSON.parse(
      readFileSync(path.join(dir, "business-rehearsals.json"), "utf8"),
    );
    if (
      receipt.restoredAt === restoredAt &&
      JSON.stringify(receipt.services) === JSON.stringify(expected)
    )
      return;
  } catch {
    /* A restored book does not grant permission to execute it. */
  }
  throw new WalletError(
    "NOT_AVAILABLE",
    "Rehearse each restored service on this device first.",
  );
}

/** Restored data supplies history. Admission and machine permissions are local. */
export function pauseRestoredBusiness(
  state: WalletState,
  business: PortableBusiness | undefined,
  now: number,
  hasWork: boolean,
) {
  delete state.setupQuotes;
  const agents = Object.values(state.agents);
  for (const agent of agents) if (agent.scope) agent.scope = null;
  if (
    !(
      hasWork ||
      state.businessRecovery?.requiresConsent ||
      pendingBusinessPayments(state).length ||
      Object.values(state.reviewIntents ?? {}).some(
        (v) => v.receipt && !v.reconciled,
      ) ||
      Object.values(state.jobs ?? {}).some((j) =>
        ["hiring", "hired", "active", "cleared"].includes(j.phase),
      ) ||
      Object.values(state.childHires ?? {}).some(unresolvedChildDispatch) ||
      business?.drafts.length ||
      business?.services.length ||
      agents.some(
        (a) =>
          a.earn?.enabled ||
          a.earn?.offer ||
          a.earn?.offers?.length ||
          a.earn?.pendingListingSends?.length,
      )
    )
  )
    return;
  // Agents that sold before the restore need the room check and rehearsal.
  const sellers = agents
    .filter((a) => a.earn?.enabled || a.earn?.offer || a.earn?.offers?.length || a.earn?.pendingListingSends?.length ||
      business?.services.some((s) => s.agentId === a.id))
    .map((a) => a.id);
  const before = state.businessRecovery?.sellers ?? [];
  for (const agent of agents) if (agent.earn) agent.earn.enabled = false;
  state.businessRecovery = { restoredAt: now, requiresConsent: true, sellers: [...new Set([...before, ...sellers])] };
}

// A adds the money journal when its contract is installed. Older backups omit it.
export function pendingBusinessPayments(state: WalletState) {
  const book = state as WalletState & {
    moneyOperations?: Record<
      string,
      {
        id: string;
        state: string;
        receipt: { signature: string };
      }
    >;
  };
  return Object.values(book.moneyOperations ?? {}).filter(
    (row) => row.state === "pending",
  );
}

/** A supplier purchase still waiting on its signed send. G archives a resolved
 * send as `dispatch` (landed, expired or failed) and keeps it as history. */
export function unresolvedChildDispatch(child: {
  view: { phase: string };
  send?: { signature: string };
  dispatch?: { signature: string; outcome: string };
}) {
  if (child.dispatch && (!child.send || child.send.signature === child.dispatch.signature)) return false;
  return child.view.phase === "dispatching" || child.send !== undefined;
}
