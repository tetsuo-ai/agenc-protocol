import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { openPrivateStateDirectory } from "./localnet-process-identity.mjs";

const MAX_PROGRAM_BYTES = 32 * 1024 * 1024;
const PROGRAMDATA_METADATA_BYTES = 45;
const PROGRAMDATA_VARIANT = 3;
const PROGRAM_METADATA_BYTES = 36;
const PROGRAM_VARIANT = 2;
const SNAPSHOT_PREFIX = "program-snapshot";
const capturedBytes = new WeakMap();

export class LocalnetProgramSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalnetProgramSnapshotError";
  }
}

function fail(message) {
  throw new LocalnetProgramSnapshotError(message);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableStatMatches(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/** Read one coherent source inode exactly once and detach its bytes in memory. */
export async function captureLocalnetProgramArtifact(sourcePath) {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    fail(
      "localnet program snapshots require Linux and a numeric user identity",
    );
  }
  if (!path.isAbsolute(sourcePath)) {
    fail("localnet program source path must be absolute");
  }
  let handle;
  try {
    handle = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_PROGRAM_BYTES)
    ) {
      fail(
        "program source must be a current-user-owned, single-link regular file of bounded size",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !stableStatMatches(before, after) ||
      BigInt(bytes.length) !== after.size
    ) {
      fail("program source changed while its exact bytes were captured");
    }
    const artifact = Object.freeze({
      sha256: hash(bytes),
      size: bytes.length,
    });
    capturedBytes.set(artifact, bytes);
    return artifact;
  } catch (error) {
    if (error instanceof LocalnetProgramSnapshotError) throw error;
    fail(`could not capture localnet program artifact (${error.message})`);
  } finally {
    await handle?.close();
  }
}

/** Verify the executable payload currently stored in a loader-v3 ProgramData account. */
export function assertLocalnetProgramAccountLinksProgramData(
  programAccountBytes,
  expectedProgramDataAddressBytes,
) {
  if (
    !Buffer.isBuffer(programAccountBytes) ||
    programAccountBytes.length !== PROGRAM_METADATA_BYTES ||
    programAccountBytes.readUInt32LE(0) !== PROGRAM_VARIANT ||
    !(expectedProgramDataAddressBytes instanceof Uint8Array) ||
    expectedProgramDataAddressBytes.length !== 32 ||
    !programAccountBytes
      .subarray(4)
      .equals(Buffer.from(expectedProgramDataAddressBytes))
  ) {
    fail("Program account does not link the canonical ProgramData address");
  }
}

export function assertLocalnetProgramDataMatchesArtifact(
  artifact,
  programDataBytes,
  expectedUpgradeAuthorityBytes,
) {
  const expected = capturedBytes.get(artifact);
  if (expected === undefined)
    fail("program artifact was not captured by this rail");
  if (
    !Buffer.isBuffer(programDataBytes) ||
    programDataBytes.length < PROGRAMDATA_METADATA_BYTES + expected.length ||
    programDataBytes.readUInt32LE(0) !== PROGRAMDATA_VARIANT ||
    programDataBytes[12] !== 1 ||
    !(expectedUpgradeAuthorityBytes instanceof Uint8Array) ||
    expectedUpgradeAuthorityBytes.length !== 32 ||
    !programDataBytes
      .subarray(13, PROGRAMDATA_METADATA_BYTES)
      .equals(Buffer.from(expectedUpgradeAuthorityBytes))
  ) {
    fail(
      "ProgramData account has an invalid loader layout or upgrade authority",
    );
  }
  const payload = programDataBytes.subarray(PROGRAMDATA_METADATA_BYTES);
  if (!payload.subarray(0, expected.length).equals(expected)) {
    fail("ProgramData executable bytes do not match the captured artifact");
  }
  if (payload.subarray(expected.length).some((byte) => byte !== 0)) {
    fail("ProgramData contains nonzero executable bytes after the artifact");
  }
}

/**
 * Materialize captured bytes into a private read-only inode, validate it, open
 * the descriptor that will be inherited by the validator, then unlink it.
 */
export async function materializeLocalnetProgramSnapshot(
  artifact,
  stateDirectory,
) {
  const bytes = capturedBytes.get(artifact);
  if (bytes === undefined)
    fail("program artifact was not captured by this rail");
  if (!path.isAbsolute(stateDirectory)) {
    fail("localnet state directory must be absolute");
  }
  const directoryHandle = await openPrivateStateDirectory(stateDirectory, {
    create: true,
    repairPermissions: true,
  });
  const leaf = `${SNAPSHOT_PREFIX}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const temporary = path.join(
    "/proc/self/fd",
    String(directoryHandle.fd),
    leaf,
  );
  let writeHandle;
  let validationHandle;
  let pinnedHandle;
  let temporaryLinked = false;
  let actionError;
  try {
    writeHandle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryLinked = true;
    await writeHandle.writeFile(bytes);
    await writeHandle.chmod(0o400);
    await writeHandle.sync();
    await writeHandle.close();
    writeHandle = undefined;

    validationHandle = await open(
      temporary,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    await unlink(temporary);
    temporaryLinked = false;
    await directoryHandle.sync();

    const validationMetadata = await validationHandle.stat();
    const copied = await validationHandle.readFile();
    if (
      !validationMetadata.isFile() ||
      validationMetadata.uid !== process.getuid() ||
      validationMetadata.nlink !== 0 ||
      (validationMetadata.mode & 0o777) !== 0o400 ||
      copied.length !== artifact.size ||
      hash(copied) !== artifact.sha256
    ) {
      fail("private program snapshot does not match its captured artifact");
    }
    // Retain the exact descriptor that was hashed. There is no pathname left
    // to replace or mutate before the validator inherits it.
    pinnedHandle = validationHandle;
    validationHandle = undefined;
  } catch (error) {
    actionError = error;
  }

  const cleanupErrors = [];
  for (const handle of [writeHandle, validationHandle]) {
    try {
      await handle?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (temporaryLinked) {
    try {
      await unlink(temporary);
      temporaryLinked = false;
      await directoryHandle.sync();
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupErrors.push(error);
    }
  }
  try {
    await directoryHandle.close();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (actionError !== undefined || cleanupErrors.length > 0) {
    if (pinnedHandle !== undefined) {
      try {
        await pinnedHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const failures = [actionError, ...cleanupErrors].filter(
      (error) => error !== undefined,
    );
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(
      failures,
      "localnet program snapshot creation or cleanup failed",
    );
  }

  let closed = false;
  return Object.freeze({
    sha256: artifact.sha256,
    size: artifact.size,
    get fd() {
      if (closed) fail("localnet program snapshot is already closed");
      return pinnedHandle.fd;
    },
    async close() {
      if (closed) return;
      closed = true;
      await pinnedHandle.close();
    },
  });
}
