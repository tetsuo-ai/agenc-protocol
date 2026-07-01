import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoreJobSpecInput, StoredJobSpec } from "./activate-job-spec.js";

const HASH_HEX_RE = /^[0-9a-f]{64}$/i;

export interface FileJobSpecStoreConfig {
  directory: string;
  publicBaseUrl: string;
}

export function createFileJobSpecStore({
  directory,
  publicBaseUrl,
}: FileJobSpecStoreConfig): (input: StoreJobSpecInput) => Promise<StoredJobSpec> {
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  if (!directory.trim()) {
    throw new Error("createFileJobSpecStore: directory is required.");
  }
  if (!baseUrl) {
    throw new Error("createFileJobSpecStore: publicBaseUrl is required.");
  }

  return async function storeJobSpec(input): Promise<StoredJobSpec> {
    if (!HASH_HEX_RE.test(input.jobSpecHashHex)) {
      throw new Error("storeJobSpec: jobSpecHashHex must be a 32-byte hex string.");
    }
    await mkdir(directory, { recursive: true });
    const fileName = `${input.jobSpecHashHex.toLowerCase()}.json`;
    await writeFile(join(directory, fileName), `${input.canonicalJson}\n`, "utf8");
    return { uri: `${baseUrl}/${fileName}` };
  };
}
