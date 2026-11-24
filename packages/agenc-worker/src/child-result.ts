// Host-only spool, outside the guest. The scheduler joins the existing run by receipt after restart.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";

interface ResultBinding {
  parentTask: string;
  claimedAt: string;
  roomId: string;
  childTask: string;
  purchaseKey: string;
}
interface ChildDelivery extends ResultBinding {
  round: number;
  deliveryHash: string;
  text: string;
  receipt: string;
  files: { name: string; sha256: string; bytes: number; base64: string }[];
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (fields: unknown) => hash(JSON.stringify(fields));

export async function stageChildResult(hostSpool: string, expected: ResultBinding, delivery: ChildDelivery) {
  if (
    (["parentTask", "claimedAt", "roomId", "childTask", "purchaseKey"] as const).some(
      (k) => delivery[k] !== expected[k],
    ) ||
    !/^[0-9a-f]{64}$/.test(delivery.deliveryHash) ||
    !Number.isSafeInteger(delivery.round) ||
    delivery.round < 0 ||
    delivery.files.length > 8 ||
    Buffer.byteLength(delivery.text) > 262144
  )
    throw new Error("The supplier result does not match the parent room.");
  const receipt = digest([
    expected.parentTask,
    expected.claimedAt,
    expected.roomId,
    expected.childTask,
    delivery.round,
    delivery.deliveryHash,
    digest(delivery.text),
    delivery.files.map((f) => [f.name, f.bytes, f.sha256]),
  ]);
  if (receipt !== delivery.receipt) throw new Error("The supplier result receipt does not match.");
  const names = new Set<string>();
  const files = delivery.files.map((f) => {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(f.name) ||
      f.name.includes("..") ||
      names.has(f.name.toLowerCase()) ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes < 1 ||
      f.bytes > 262144 ||
      f.base64.length > 349528
    )
      throw new Error("The supplier file is invalid.");
    names.add(f.name.toLowerCase());
    const bytes = Buffer.from(f.base64, "base64");
    if (bytes.length !== f.bytes || hash(bytes) !== f.sha256 || bytes.toString("base64") !== f.base64)
      throw new Error("The supplier file failed verification.");
    return { name: f.name, bytes };
  });
  const group = join(hostSpool, digest([expected.parentTask, expected.claimedAt, expected.roomId]));
  await mkdir(group, { recursive: true, mode: 0o700 });
  const folder = join(group, "supplier-" + receipt);
  const staged = await mkdtemp(join(group, ".incoming-"));
  try {
    await mkdir(join(staged, "files"), { mode: 0o700 });
    for (const f of files)
      await writeFile(join(staged, "files", f.name), f.bytes, { flag: "wx", mode: 0o400 });
    await writeFile(join(staged, "result.txt"), delivery.text, { mode: 0o400 });
    await writeFile(join(staged, "receipt"), receipt, { mode: 0o400 });
    try {
      await rename(staged, folder);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    // Even a replay verifies the actual saved bytes before the room receives a read-only copy.
    if (
      !(await lstat(folder)).isDirectory() ||
      (await readFile(join(folder, "receipt"), "utf8")) !== receipt ||
      (await readFile(join(folder, "result.txt"), "utf8")) !== delivery.text
    )
      throw new Error("The stored supplier result changed.");
    for (const f of files) {
      const saved = join(folder, "files", f.name);
      if (!(await lstat(saved)).isFile() || !(await readFile(saved)).equals(f.bytes))
        throw new Error("The stored supplier file changed.");
    }
    return { receipt, folder };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

type RoomIdentity = Pick<ResultBinding, "parentTask" | "claimedAt" | "roomId">;
function roomFolder(spool: string, room: RoomIdentity) {
  return join(spool, digest([room.parentTask, room.claimedAt, room.roomId]));
}

/** Immutable markers. A failed process can leave only an unreferenced temporary directory. */
async function recordOnce(folder: string, name: string, value: string) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const staged = await mkdtemp(join(folder, ".state-"));
  try {
    await writeFile(join(staged, "value"), value, { mode: 0o400 });
    try {
      await rename(staged, join(folder, name));
      return true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if ((await readFile(join(folder, name, "value"), "utf8")) !== value)
        throw new Error("The parked room belongs to another supplier purchase.");
      return false;
    }
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
export async function parkChildRun(spool: string, room: RoomIdentity, purchaseKey: string) {
  return recordOnce(roomFolder(spool, room), "parked", purchaseKey);
}
async function inputFolder(folder: string, purchaseKey: string, receipt: string) {
  if (receipt === "timeout:" + purchaseKey) {
    const empty = join(folder, "timeout");
    await mkdir(empty, { recursive: true, mode: 0o500 });
    return empty;
  }
  if (!/^[0-9a-f]{64}$/.test(receipt)) throw new Error("Invalid supplier receipt.");
  for (const name of ["supplier-" + receipt, "supplier"]) {
    // The old fixed folder is readable on upgrade only for its exact receipt.
    const saved = join(folder, name);
    const stored = await readFile(join(saved, "receipt"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (stored === receipt) return saved;
  }
  throw new Error("The parked room has no matching supplier result.");
}

/** Make exactly one durable run available. The room runner consumes it with takeChildResume. */
export async function enqueueChildResume(
  spool: string,
  room: RoomIdentity,
  purchaseKey: string,
  receipt: string,
) {
  const folder = roomFolder(spool, room);
  if ((await readFile(join(folder, "parked", "value"), "utf8")) !== purchaseKey)
    throw new Error("The parked room has no matching supplier result.");
  await inputFolder(folder, purchaseKey, receipt);
  return recordOnce(folder, "ready", receipt);
}
/** A previous start is recovered through the original run ID. It cannot create a second model turn. */
export async function takeChildResume(spool: string, room: RoomIdentity, receipt: string) {
  const folder = roomFolder(spool, room);
  if ((await readFile(join(folder, "ready", "value"), "utf8")) !== receipt)
    throw new Error("The supplier delivery is not ready to resume.");
  const input = await inputFolder(folder, await readFile(join(folder, "parked", "value"), "utf8"), receipt);
  return {
    runId: receipt,
    start: await recordOnce(folder, "started", receipt),
    inputFolder: input,
  };
}
