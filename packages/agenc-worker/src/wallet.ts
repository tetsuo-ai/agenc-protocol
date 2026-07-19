import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/** A wallet file failed structural or filesystem-safety validation. */
export class WalletFileError extends Error {
  override name = "WalletFileError";
}

const KEYPAIR_BYTES = 64;
const MAX_WALLET_FILE_BYTES = 4 * 1024;

/** Parse the canonical Solana CLI keypair JSON representation. */
export function parseSolanaKeypairJson(
  body: string,
  label = "wallet",
): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new WalletFileError(
      `${label}: invalid JSON (${(error as Error).message})`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== KEYPAIR_BYTES) {
    throw new WalletFileError(
      `${label}: expected exactly ${KEYPAIR_BYTES} keypair bytes`,
    );
  }
  for (let index = 0; index < parsed.length; index += 1) {
    const value = parsed[index];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 255
    ) {
      throw new WalletFileError(
        `${label}: byte ${index} must be a finite safe integer in 0..255`,
      );
    }
  }
  return Uint8Array.from(parsed as number[]);
}

/**
 * Read a keypair without following symlinks and require a private, owner-held
 * regular file on platforms that expose POSIX ownership/mode metadata.
 */
export function loadSolanaKeypairFile(walletPath: string): Uint8Array {
  let pathMetadata: ReturnType<typeof lstatSync>;
  try {
    pathMetadata = lstatSync(walletPath);
  } catch (error) {
    throw new WalletFileError(
      `wallet ${walletPath}: cannot inspect file (${(error as Error).message})`,
    );
  }
  if (pathMetadata.isSymbolicLink()) {
    throw new WalletFileError(
      `wallet ${walletPath}: symbolic links are not allowed`,
    );
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(walletPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const suffix = code === "ELOOP" ? " (symbolic links are not allowed)" : "";
    throw new WalletFileError(
      `wallet ${walletPath}: cannot open safely${suffix} (${(error as Error).message})`,
    );
  }
  try {
    const metadata = fstatSync(fd);
    if (
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw new WalletFileError(
        `wallet ${walletPath}: file changed while it was being opened`,
      );
    }
    if (!metadata.isFile()) {
      throw new WalletFileError(
        `wallet ${walletPath}: expected a regular file`,
      );
    }
    if (metadata.size > MAX_WALLET_FILE_BYTES) {
      throw new WalletFileError(
        `wallet ${walletPath}: file exceeds ${MAX_WALLET_FILE_BYTES} bytes`,
      );
    }
    const getuid = process.getuid;
    if (typeof getuid === "function" && metadata.uid !== getuid.call(process)) {
      throw new WalletFileError(
        `wallet ${walletPath}: file must be owned by the current user`,
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new WalletFileError(
        `wallet ${walletPath}: permissions must not grant group or other access (use chmod 600)`,
      );
    }
    return parseSolanaKeypairJson(readFileSync(fd, "utf8"), `wallet ${walletPath}`);
  } finally {
    closeSync(fd);
  }
}
