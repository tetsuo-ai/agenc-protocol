const ELF64_HEADER_BYTES = 64;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ET_DYN = 3;
const EM_SBF = 0x107;
const PT_LOAD = 1;
const SHT_NOBITS = 8;

const PRODUCTION_PROFILE_MARKER = "AGENC_SBF_PROFILE=PRODUCTION_V1";
const FORBIDDEN_PROFILE_MARKERS = [
  "AGENC_SBF_PROFILE=PRIVATE_ZK_V1",
  "AGENC_SBF_PROFILE=VALIDATION_V1",
  "Instruction: CompleteTaskPrivate",
  "Instruction: InitializeZkConfig",
  "Instruction: UpdateZkImageId",
];

function asBuffer(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("compiled SBF must be a Uint8Array");
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function safeU64(buffer, offset, label) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`SBF ELF ${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

function checkedEnd(offset, size, limit, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > limit ||
    size > limit - offset
  ) {
    throw new Error(`SBF ELF ${label} exceeds the ${limit}-byte file`);
  }
  return offset + size;
}

/** Validate the canonical ELF64/SBF container emitted by Solana build-sbf. */
function assertSbfElf(bytes) {
  const buffer = asBuffer(bytes);
  if (buffer.byteLength < ELF64_HEADER_BYTES) {
    throw new Error("compiled SBF is not a complete ELF64 file");
  }
  if (
    buffer[0] !== 0x7f ||
    buffer[1] !== 0x45 ||
    buffer[2] !== 0x4c ||
    buffer[3] !== 0x46 ||
    buffer[4] !== ELFCLASS64 ||
    buffer[5] !== ELFDATA2LSB ||
    buffer[6] !== 1
  ) {
    throw new Error("compiled SBF has an invalid ELF64 header");
  }
  if (
    buffer.readUInt16LE(16) !== ET_DYN ||
    buffer.readUInt16LE(18) !== EM_SBF ||
    buffer.readUInt32LE(20) !== 1 ||
    buffer.readUInt16LE(52) !== ELF64_HEADER_BYTES
  ) {
    throw new Error("compiled SBF is not a Solana SBF shared-object ELF");
  }

  const programHeaderOffset = safeU64(buffer, 32, "program-header offset");
  const sectionHeaderOffset = safeU64(buffer, 40, "section-header offset");
  const programHeaderSize = buffer.readUInt16LE(54);
  const programHeaderCount = buffer.readUInt16LE(56);
  const sectionHeaderSize = buffer.readUInt16LE(58);
  const sectionHeaderCount = buffer.readUInt16LE(60);
  const sectionNameIndex = buffer.readUInt16LE(62);
  if (
    programHeaderSize !== 56 ||
    programHeaderCount === 0 ||
    sectionHeaderSize !== 64 ||
    sectionHeaderCount === 0 ||
    sectionNameIndex >= sectionHeaderCount
  ) {
    throw new Error("compiled SBF has an invalid ELF header-table shape");
  }
  checkedEnd(
    programHeaderOffset,
    programHeaderSize * programHeaderCount,
    buffer.byteLength,
    "program-header table",
  );
  const sectionTableEnd = checkedEnd(
    sectionHeaderOffset,
    sectionHeaderSize * sectionHeaderCount,
    buffer.byteLength,
    "section-header table",
  );
  if (sectionTableEnd !== buffer.byteLength) {
    throw new Error("compiled SBF has trailing or incomplete ELF data");
  }

  let loadSegments = 0;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const header = programHeaderOffset + index * programHeaderSize;
    const type = buffer.readUInt32LE(header);
    const offset = safeU64(buffer, header + 8, `segment ${index} offset`);
    const fileSize = safeU64(buffer, header + 32, `segment ${index} file size`);
    const memorySize = safeU64(
      buffer,
      header + 40,
      `segment ${index} memory size`,
    );
    if (fileSize > memorySize) {
      throw new Error(`SBF ELF segment ${index} file size exceeds memory size`);
    }
    checkedEnd(offset, fileSize, buffer.byteLength, `segment ${index}`);
    if (type === PT_LOAD) loadSegments += 1;
  }
  if (loadSegments === 0) {
    throw new Error("compiled SBF ELF has no loadable segment");
  }

  for (let index = 0; index < sectionHeaderCount; index += 1) {
    const header = sectionHeaderOffset + index * sectionHeaderSize;
    const type = buffer.readUInt32LE(header + 4);
    if (type === SHT_NOBITS) continue;
    const offset = safeU64(buffer, header + 24, `section ${index} offset`);
    const size = safeU64(buffer, header + 32, `section ${index} size`);
    checkedEnd(offset, size, sectionHeaderOffset, `section ${index}`);
  }
  return buffer;
}

/**
 * Reject a canary, private-ZK, validation-timing, corrupt, or incomplete SBF
 * before it can become the SDK's published LiteSVM testing asset.
 */
export function assertProductionSbf(
  bytes,
  { expectedInstructionNames, sourceLabel = "compiled SBF" },
) {
  const buffer = assertSbfElf(bytes);
  if (
    !Array.isArray(expectedInstructionNames) ||
    expectedInstructionNames.length === 0 ||
    new Set(expectedInstructionNames).size !== expectedInstructionNames.length
  ) {
    throw new Error(
      "production IDL instruction names must be nonempty and unique",
    );
  }

  const missing = [
    PRODUCTION_PROFILE_MARKER,
    ...expectedInstructionNames.map((name) => `Instruction: ${name}`),
  ].filter((marker) => !buffer.includes(Buffer.from(marker, "utf8")));
  const forbidden = FORBIDDEN_PROFILE_MARKERS.filter((marker) =>
    buffer.includes(Buffer.from(marker, "utf8")),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      [
        `sync-testing-so: ${sourceLabel} is not the full default-production program`,
        ...(missing.length > 0
          ? [
              "Missing required production surface markers:",
              ...missing.map((marker) => `  - ${marker}`),
            ]
          : []),
        ...(forbidden.length > 0
          ? [
              "Forbidden development-profile markers:",
              ...forbidden.map((marker) => `  - ${marker}`),
            ]
          : []),
        "Refusing to copy a canary, development-profile, corrupt, or incomplete SBF into SDK testing-assets.",
        "Rebuild the default production profile with `anchor build` and retry.",
      ].join("\n"),
    );
  }
}

export function getIdlInstructionLogNames(idl) {
  if (!idl || !Array.isArray(idl.instructions)) {
    throw new TypeError("production IDL must contain an instruction array");
  }
  return idl.instructions.map(({ name }) => {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(name)) {
      throw new TypeError(
        `invalid Anchor IDL instruction name: ${String(name)}`,
      );
    }
    return name
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  });
}

export { FORBIDDEN_PROFILE_MARKERS, PRODUCTION_PROFILE_MARKER, assertSbfElf };
