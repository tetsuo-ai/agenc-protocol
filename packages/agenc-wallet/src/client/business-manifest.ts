/** C's immutable room manifest. Its files are addressed by digest. A rehearsal
 * receipt is device-local and never part of this format. */
export interface BusinessManifest {
  version: 1;
  entry: string;
  outputs: string[];
  seconds: number;
  tools: string[];
  runtimeDigest: string;
  permissionDigest: string;
  capabilities: "1" | "5";
  files: { name: string; bytes: number; sha256: string }[];
}

export function parseBusinessManifest(value: unknown): BusinessManifest {
  const m = value as BusinessManifest;
  const name = (s: unknown) =>
    typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s);
  const sha = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  if (
    !m ||
    m.version !== 1 ||
    !name(m.entry) ||
    !m.entry.endsWith(".py") ||
    !sha(m.runtimeDigest) ||
    !sha(m.permissionDigest) ||
    !Number.isSafeInteger(m.seconds) ||
    m.seconds < 1 ||
    m.seconds > 120 ||
    !Array.isArray(m.outputs) ||
    !m.outputs.length ||
    m.outputs.length > 8 ||
    !m.outputs.every(name) ||
    new Set(m.outputs).size !== m.outputs.length ||
    !Array.isArray(m.files) ||
    !m.files.length ||
    m.files.length > 14 ||
    m.files.some(
      (f) =>
        !f ||
        !name(f.name) ||
        f.name === "client-request.txt" ||
        !sha(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 1,
    ) ||
    m.files.reduce((n, f) => n + f.bytes, 0) > 4 * 1024 * 1024 ||
    !m.files.some((f) => f.name === m.entry) ||
    new Set(m.files.map((f) => f.name.toLowerCase())).size !== m.files.length ||
    m.capabilities !== (m.files.length > 1 ? "5" : "1") ||
    JSON.stringify(m.tools) !==
      JSON.stringify(
        m.files.length > 1
          ? ["guest-python", "read-references"]
          : ["guest-python"],
      )
  )
    throw new Error("The service manifest is invalid.");
  return m;
}

/** Service sources are installed in the seller's own room directory. */
export const serviceRehearsalKey = (agentId: string, manifest: string) =>
  JSON.stringify([agentId, manifest]);
