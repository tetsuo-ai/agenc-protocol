// A caller can name an existing rehearsal, but only the owner-side room host
// creates its receipt. Resolve every file from the seller's private directory.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validServicePin, type ServicePin } from "./client/seller-terms.js";
import { WalletError } from "./errors.js";
export function readServiceRehearsal(stateDir: string, pin: ServicePin, requiredFiles:readonly string[] = []) {
  try {
    if (!validServicePin(pin)) throw new Error();
    const dir = join(stateDir, "service-bundles", pin.digest);
    const bytes = readFileSync(join(dir, "manifest.json"));
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    if (bytes.length > 32768 || hash(bytes) !== pin.digest) throw new Error();
    const manifest = JSON.parse(bytes.toString("utf8"));
    const receipt = JSON.parse(readFileSync(join(dir, "passed.json"), "utf8"));
    if (receipt.digest !== pin.digest || receipt.passed !== true ||
        manifest.runtimeDigest !== pin.runtimeDigest || manifest.permissionDigest !== pin.permissionDigest ||
        manifest.capabilities !== pin.capabilities || !Array.isArray(manifest.files) || manifest.files.length > 14)
      throw new Error();
    if (requiredFiles.length && (!Array.isArray(manifest.outputs) || requiredFiles.some(name=>!manifest.outputs.includes(name))))
      throw new Error("The rehearsal does not produce the agreed files.");
    for (const file of manifest.files) {
      if (!/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 4 * 1024 * 1024)
        throw new Error();
      const asset = join(dir, file.sha256);
      if (statSync(asset).size !== file.bytes || hash(readFileSync(asset)) !== file.sha256) throw new Error();
    }
    return dir;
  } catch {
    throw new WalletError("NOT_AVAILABLE", "This version of the service needs its successful room rehearsal and original files.");
  }
}
