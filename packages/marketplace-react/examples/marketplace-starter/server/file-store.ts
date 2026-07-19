import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { values } from "@tetsuo-ai/marketplace-sdk";
import type { StoreJobSpecInput, StoredJobSpec } from "./activate-job-spec.js";

const HASH_HEX_RE = /^[0-9a-f]{64}$/i;
const MAX_WORKER_JOB_SPEC_BYTES = 64 * 1024;
const MAX_TASK_JOB_SPEC_URI_BYTES = 256;

export interface FileJobSpecStoreConfig {
  directory: string;
  publicBaseUrl: string;
}

function isAlreadyExistsError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFoundError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function normalizePublicBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("createFileJobSpecStore: publicBaseUrl must be an absolute HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    throw new Error(
      "createFileJobSpecStore: publicBaseUrl must be credential-free HTTP(S) with no query or fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export function createFileJobSpecStore({
  directory,
  publicBaseUrl,
}: FileJobSpecStoreConfig): (input: StoreJobSpecInput) => Promise<StoredJobSpec> {
  if (!directory.trim()) {
    throw new Error("createFileJobSpecStore: directory is required.");
  }
  if (!publicBaseUrl.trim()) {
    throw new Error("createFileJobSpecStore: publicBaseUrl is required.");
  }
  const baseUrl = normalizePublicBaseUrl(publicBaseUrl);

  return async function storeJobSpec(input): Promise<StoredJobSpec> {
    if (!HASH_HEX_RE.test(input.jobSpecHashHex)) {
      throw new Error("storeJobSpec: jobSpecHashHex must be a 32-byte hex string.");
    }
    const jobSpecHashHex = input.jobSpecHashHex.toLowerCase();
    const { integrity, payload } = input.envelope;
    if (
      integrity.algorithm !== "sha256" ||
      integrity.canonicalization !== "json-stable-v1"
    ) {
      throw new Error("storeJobSpec: unsupported job-spec envelope integrity metadata.");
    }
    if (integrity.payloadHash !== jobSpecHashHex) {
      throw new Error("storeJobSpec: envelope payload hash does not match its address.");
    }
    if (payload.taskPda !== input.taskPda) {
      throw new Error("storeJobSpec: envelope task PDA does not match the storage input.");
    }
    const computedHashHex = (await values.canonicalJobSpecHash(payload)).hex;
    if (computedHashHex !== jobSpecHashHex) {
      throw new Error("storeJobSpec: canonical envelope payload does not match its address.");
    }

    await mkdir(directory, { recursive: true });
    const fileName = `${jobSpecHashHex}.json`;
    const filePath = join(directory, fileName);
    const tempPath = join(
      directory,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
    );
    const document = `${values.canonicalJobSpecJson(input.envelope)}\n`;
    if (
      new TextEncoder().encode(document).byteLength >
      MAX_WORKER_JOB_SPEC_BYTES
    ) {
      throw new Error(
        `storeJobSpec: hosted envelope exceeds ${MAX_WORKER_JOB_SPEC_BYTES} bytes.`,
      );
    }
    const uri = `${baseUrl}/${fileName}`;
    if (
      new TextEncoder().encode(uri).byteLength > MAX_TASK_JOB_SPEC_URI_BYTES
    ) {
      throw new Error(
        `storeJobSpec: public URI exceeds ${MAX_TASK_JOB_SPEC_URI_BYTES} bytes.`,
      );
    }
    let tempCreated = false;
    try {
      // Publish only a fully written, fsynced inode. `link` is atomic and will
      // not replace a concurrent immutable winner at the content address.
      const handle = await open(tempPath, "wx", 0o600);
      tempCreated = true;
      try {
        await handle.writeFile(document, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tempPath, filePath);
      } catch (cause) {
        if (!isAlreadyExistsError(cause)) throw cause;
        const existing = await readFile(filePath, "utf8");
        if (existing !== document) {
          throw new Error(
            `storeJobSpec: ${fileName} already exists with different contents.`,
          );
        }
      }
      // Persist both the final hard-link and removal of the private temporary
      // name before reporting a successful (or idempotently verified) publish.
      await unlink(tempPath);
      tempCreated = false;
      await syncDirectory(directory);
    } finally {
      if (tempCreated) {
        try {
          await unlink(tempPath);
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !("code" in cause) ||
            (cause as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            throw cause;
          }
        }
      }
    }
    return { uri };
  };
}

/**
 * Public GET handler for the immutable files emitted by
 * {@link createFileJobSpecStore}. Mount it at
 * `<publicBaseUrl>/[hash].json`; the Next.js example in this directory shows
 * the exact route shape.
 */
export function createFileJobSpecGetHandler({
  directory,
}: Pick<FileJobSpecStoreConfig, "directory">): (
  request: Request,
) => Promise<Response> {
  if (!directory.trim()) {
    throw new Error("createFileJobSpecGetHandler: directory is required.");
  }

  return async function getJobSpec(request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json(
        { error: "GET only" },
        { status: 405, headers: { allow: "GET" } },
      );
    }

    let fileName: string;
    try {
      const segments = new URL(request.url).pathname.split("/");
      fileName = segments.at(-1) ?? "";
    } catch {
      return Response.json({ error: "invalid job-spec URL" }, { status: 400 });
    }
    const match = /^([0-9a-f]{64})\.json$/u.exec(fileName);
    if (!match) {
      return Response.json({ error: "invalid job-spec hash" }, { status: 400 });
    }

    try {
      const document = await readFile(join(directory, fileName));
      if (document.byteLength > MAX_WORKER_JOB_SPEC_BYTES) {
        return Response.json(
          { error: "stored job spec exceeds the worker fetch limit" },
          { status: 500 },
        );
      }
      return new Response(document, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (cause) {
      if (isNotFoundError(cause)) {
        return Response.json({ error: "job spec not found" }, { status: 404 });
      }
      return Response.json(
        { error: "job-spec storage unavailable" },
        { status: 500 },
      );
    }
  };
}
