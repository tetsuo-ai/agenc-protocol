// P6.5 surface-versioning contract — SDK unit tests.
//
// The load-bearing requirement (PLAN.md P6.5 "done-when"): getDeployedSurface against
// an OLD-layout (349-byte, pre-surface_revision) ProtocolConfig — today's mainnet
// account — MUST return `listings: false` via the fallback path WITHOUT throwing; a
// full-surface (new-layout, surface_revision stamped) account returns `listings: true`.
//
// These tests hand-build raw ProtocolConfig buffers (old size vs new size) and feed
// them through a minimal fake kit RPC, so they prove the tolerance without an on-chain
// program.
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { getU16Encoder, type Address } from "@solana/kit";
import {
  getDeployedSurface,
  capabilitiesForRevision,
  readSurfaceRevision,
  assertCapability,
  SurfaceNotDeployedError,
  SURFACE_REVISION_FULL,
  SURFACE_REVISION_OFFSET,
  OLD_PROTOCOL_CONFIG_SIZE,
  NEW_PROTOCOL_CONFIG_SIZE,
  type CapabilitySet,
} from "../src/facade/surface.js";

// ---------------------------------------------------------------------------
// Hand-built ProtocolConfig buffers.
// readSurfaceRevision only inspects the buffer LENGTH and the 2 bytes at offset
// 349, so a zero-filled prefix is a faithful stand-in for the real account here.
// ---------------------------------------------------------------------------

/** Today's mainnet account: 349 bytes, no surface_revision tail. */
function oldLayoutBuffer(): Uint8Array {
  return new Uint8Array(OLD_PROTOCOL_CONFIG_SIZE);
}

/** A migrated account: 351 bytes with surface_revision = `revision` at offset 349. */
function newLayoutBuffer(revision: number): Uint8Array {
  const buf = new Uint8Array(NEW_PROTOCOL_CONFIG_SIZE);
  getU16Encoder().write(revision, buf, SURFACE_REVISION_OFFSET);
  return buf;
}

/**
 * Minimal fake kit RPC exposing just `getAccountInfo` in the base64 shape
 * `fetchEncodedAccount` consumes (`{ value: null }` or
 * `{ value: { data: [b64, "base64"], ... } }`).
 */
function makeAccountRpc(data: Uint8Array | null) {
  return {
    getAccountInfo() {
      return {
        send: async () =>
          data === null
            ? { value: null }
            : {
                value: {
                  data: [Buffer.from(data).toString("base64"), "base64"],
                  executable: false,
                  lamports: 1n,
                  owner: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK" as Address,
                  rentEpoch: 0n,
                  space: BigInt(data.length),
                },
              },
      };
    },
  } as never;
}

describe("readSurfaceRevision (pure decode, old-layout tolerant)", () => {
  it("returns 0 for the OLD 349-byte layout (no surface_revision tail) without throwing", () => {
    expect(readSurfaceRevision(oldLayoutBuffer())).toBe(0);
  });

  it("returns 0 for an unstamped new-layout account", () => {
    expect(readSurfaceRevision(newLayoutBuffer(0))).toBe(0);
  });

  it("reads the stamped revision from a new-layout account", () => {
    expect(readSurfaceRevision(newLayoutBuffer(SURFACE_REVISION_FULL))).toBe(
      SURFACE_REVISION_FULL,
    );
    expect(readSurfaceRevision(newLayoutBuffer(258))).toBe(258); // multi-byte LE check
  });

  it("returns 0 for a truncated/garbage buffer instead of throwing", () => {
    expect(readSurfaceRevision(new Uint8Array(0))).toBe(0);
    expect(readSurfaceRevision(new Uint8Array(8))).toBe(0);
    expect(readSurfaceRevision(new Uint8Array(350))).toBe(0); // 1 byte short of the u16
  });
});

describe("capabilitiesForRevision (typed mapping)", () => {
  it("revision 0 -> conservative canary surface (every capability false)", () => {
    const caps = capabilitiesForRevision(0);
    expect(caps.fullSurface).toBe(false);
    expect(caps.listings).toBe(false);
    expect(caps.disputes).toBe(false);
    expect(caps.bonds).toBe(false);
    expect(caps.referrals).toBe(false);
    expect(caps.surfaceRevision).toBe(0);
  });

  it("revision FULL -> full surface (every capability true)", () => {
    const caps = capabilitiesForRevision(SURFACE_REVISION_FULL);
    expect(caps.fullSurface).toBe(true);
    expect(caps.listings).toBe(true);
    expect(caps.disputes).toBe(true);
    expect(caps.bonds).toBe(true);
    expect(caps.referrals).toBe(true);
    expect(caps.governance).toBe(true);
    expect(caps.skills).toBe(true);
    expect(caps.reputation).toBe(true);
    expect(caps.bids).toBe(true);
    expect(caps.surfaceRevision).toBe(SURFACE_REVISION_FULL);
  });
});

describe("getDeployedSurface (the acceptance test)", () => {
  it("OLD-layout mainnet account -> returns listings:false via fallback WITHOUT erroring", async () => {
    const rpc = makeAccountRpc(oldLayoutBuffer());
    const surface = await getDeployedSurface(rpc);
    expect(surface.listings).toBe(false);
    expect(surface.fullSurface).toBe(false);
    expect(surface.surfaceRevision).toBe(0);
  });

  it("full-surface (new-layout, surface_revision stamped) account -> returns listings:true", async () => {
    const rpc = makeAccountRpc(newLayoutBuffer(SURFACE_REVISION_FULL));
    const surface = await getDeployedSurface(rpc);
    expect(surface.listings).toBe(true);
    expect(surface.fullSurface).toBe(true);
    expect(surface.surfaceRevision).toBe(SURFACE_REVISION_FULL);
  });

  it("migrated-but-unstamped (new-layout, surface_revision=0) account -> conservative surface", async () => {
    const rpc = makeAccountRpc(newLayoutBuffer(0));
    const surface = await getDeployedSurface(rpc);
    expect(surface.listings).toBe(false);
    expect(surface.surfaceRevision).toBe(0);
  });

  it("missing account -> conservative surface (no throw)", async () => {
    const rpc = makeAccountRpc(null);
    const surface = await getDeployedSurface(rpc);
    expect(surface.listings).toBe(false);
    expect(surface.surfaceRevision).toBe(0);
  });
});

describe("assertCapability + SurfaceNotDeployedError", () => {
  it("throws a typed SurfaceNotDeployedError when the capability is not live", () => {
    const surface: CapabilitySet = capabilitiesForRevision(0);
    let thrown: unknown;
    try {
      assertCapability(surface, "listings");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SurfaceNotDeployedError);
    const e = thrown as SurfaceNotDeployedError;
    expect(e.capability).toBe("listings");
    expect(e.surface.surfaceRevision).toBe(0);
    expect(e.name).toBe("SurfaceNotDeployedError");
    expect(e.message).toContain("not deployed");
  });

  it("does not throw when the capability is live (full surface)", () => {
    const surface = capabilitiesForRevision(SURFACE_REVISION_FULL);
    expect(() => assertCapability(surface, "listings")).not.toThrow();
    expect(() => assertCapability(surface, "disputes")).not.toThrow();
  });
});
