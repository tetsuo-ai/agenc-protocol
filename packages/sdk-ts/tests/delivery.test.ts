// P7.2 encrypted deliverable handoff — SDK unit tests.
//
// Load-bearing requirements (PLAN.md Phase 7 wave 2):
//  - encrypt -> decrypt round-trips for BOTH wrap modes (raw symKey and the
//    X25519 pubkey wrap);
//  - a WRONG key fails to decrypt (GCM tag mismatch), so a leaked manifest
//    without the gated key cannot recover the plaintext;
//  - the PUBLIC manifest carries the review fields and (for x25519) the wrap,
//    never the bare plaintext key.
import { describe, it, expect } from "vitest";
import {
  encryptDeliverable,
  encryptDeliverableV2,
  decryptDeliverable,
  buildDeliveryManifest,
  generateSymKey,
  generateRecipientKeyPair,
  DELIVERY_ENC_ALGO,
  DELIVERY_KEY_AGREEMENT,
  AES_KEY_BYTES,
} from "../src/delivery/index.js";
import { bytesToHex } from "../src/values/index.js";

const TASK_PDA = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PLAINTEXT = "the full deliverable: a 5000-word report + figures";

describe("encrypt/decrypt round-trip — symmetric key (P7.2)", () => {
  it("recovers the plaintext with the same key", async () => {
    const symKey = generateSymKey();
    expect(symKey.length).toBe(AES_KEY_BYTES);

    const { ciphertext, manifest } = await encryptDeliverable(
      PLAINTEXT,
      { symKey },
      {
        taskPda: TASK_PDA,
        ciphertextUri: "agenc://ct/1",
        previewUri: "https://prev/1",
      },
    );

    expect(manifest.encAlgo).toBe(DELIVERY_ENC_ALGO);
    expect(manifest.taskPda).toBe(TASK_PDA);
    expect(manifest.previewUri).toBe("https://prev/1");
    expect(manifest.keyWrap.mode).toBe("symmetric");

    const recovered = await decryptDeliverable(
      ciphertext,
      { symKey },
      manifest,
    );
    expect(new TextDecoder().decode(recovered)).toBe(PLAINTEXT);
  });

  it("a WRONG symmetric key fails to decrypt", async () => {
    const symKey = generateSymKey();
    const { ciphertext, manifest } = await encryptDeliverable(
      PLAINTEXT,
      { symKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/1" },
    );
    const wrongKey = generateSymKey();
    await expect(
      decryptDeliverable(ciphertext, { symKey: wrongKey }, manifest),
    ).rejects.toThrow();
  });

  it("round-trips raw bytes (not just strings)", async () => {
    const symKey = generateSymKey();
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const { ciphertext, manifest } = await encryptDeliverable(
      bytes,
      { symKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/raw" },
    );
    const recovered = await decryptDeliverable(
      ciphertext,
      { symKey },
      manifest,
    );
    expect(Array.from(recovered)).toEqual(Array.from(bytes));
  });

  // FAIR-EXCHANGE BLOCKER (revert-sensitive): the symmetric-mode PUBLIC manifest
  // must carry NO raw key. Pre-fix encryptDeliverable set
  // keyWrap = { mode, wrappedKey: bytesToHex(symKey) }, so the published object
  // leaked the AES key and any holder could decrypt the ciphertext before the
  // on-chain Accept — defeating the gate. This asserts the serialized public
  // manifest contains NONE of the key's hex bytes.
  it("the PUBLIC symmetric manifest never contains the raw symKey (fair-exchange gate)", async () => {
    const symKey = generateSymKey();
    const { manifest } = await encryptDeliverable(
      PLAINTEXT,
      { symKey },
      {
        taskPda: TASK_PDA,
        ciphertextUri: "agenc://ct/sym",
        gateRef: "agenc://wrapped-key/T",
      },
    );

    expect(manifest.keyWrap.mode).toBe("symmetric");
    const keyHex = bytesToHex(symKey);
    // The full key hex must not appear anywhere in the publishable manifest...
    const serialized = JSON.stringify(manifest);
    expect(serialized.includes(keyHex)).toBe(false);
    // ...and no field of the keyWrap descriptor may carry key bytes — only the
    // mode + an opaque gateRef survive.
    expect(
      JSON.stringify(
        manifest.keyWrap.mode === "symmetric" ? manifest.keyWrap : {},
      ),
    ).not.toContain(keyHex);
    expect("wrappedKey" in manifest.keyWrap).toBe(false);
    if (manifest.keyWrap.mode === "symmetric") {
      expect(manifest.keyWrap.gateRef).toBe("agenc://wrapped-key/T");
    }

    // The raw key is still returned SEPARATELY for the out-of-band gated upload.
    const { symKey: returnedKey } = await encryptDeliverable(
      PLAINTEXT,
      { symKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/sym" },
    );
    expect(bytesToHex(returnedKey)).toBe(keyHex);
  });
});

describe("delivery integrity and v2 context binding", () => {
  it("requires a manifest and verifies plaintextHash for v1", async () => {
    const symKey = generateSymKey();
    const { ciphertext, manifest } = await encryptDeliverable(
      PLAINTEXT,
      { symKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/v1" },
    );
    await expect(decryptDeliverable(ciphertext, { symKey })).rejects.toThrow(
      /manifest/i,
    );
    await expect(
      decryptDeliverable(
        ciphertext,
        { symKey },
        {
          ...manifest,
          plaintextHash: "00".repeat(32),
        },
      ),
    ).rejects.toThrow(/plaintextHash|integrity/i);
  });

  it("v2 authenticates stable manifest context as AES-GCM AAD while v1 remains readable", async () => {
    const symKey = generateSymKey();
    const v2 = await encryptDeliverableV2(
      PLAINTEXT,
      { symKey },
      {
        taskPda: TASK_PDA,
        ciphertextUri: "agenc://ct/v2",
        previewUri: "https://preview.test/v2",
      },
    );
    expect(v2.manifest.v).toBe(2);
    await expect(
      decryptDeliverable(v2.ciphertext, { symKey }, v2.manifest),
    ).resolves.toBeInstanceOf(Uint8Array);
    await expect(
      decryptDeliverable(
        v2.ciphertext,
        { symKey },
        {
          ...v2.manifest,
          taskPda: "So11111111111111111111111111111111111111112",
        },
      ),
    ).rejects.toThrow();

    const v1 = await encryptDeliverable(
      PLAINTEXT,
      { symKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/v1-preserved" },
    );
    expect(v1.manifest.v).toBe(1);
    await expect(
      decryptDeliverable(v1.ciphertext, { symKey }, v1.manifest),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("encrypt/decrypt round-trip — X25519 pubkey wrap (P7.2)", () => {
  it("wraps to the recipient pubkey and the recipient private key unwraps", async () => {
    const recipient = await generateRecipientKeyPair();

    const { ciphertext, manifest } = await encryptDeliverable(
      PLAINTEXT,
      { recipientPublicKey: recipient.publicKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/2" },
    );

    expect(manifest.keyWrap.mode).toBe("x25519");
    if (manifest.keyWrap.mode !== "x25519") throw new Error("unreachable");
    expect(manifest.keyWrap.agreement).toBe(DELIVERY_KEY_AGREEMENT);
    expect(manifest.keyWrap.wrappedKey).toMatch(/^[0-9a-f]+$/);
    expect(manifest.keyWrap.ephemeralPublicKey).toMatch(/^[0-9a-f]{64}$/);
    // The bare plaintext AES key is NOT in the public manifest.
    expect(manifest.keyWrap.wrappedKey).not.toBe("");

    const recovered = await decryptDeliverable(
      ciphertext,
      {
        recipientPrivateKey: recipient.privateKey,
        recipientPublicKey: recipient.publicKey,
      },
      manifest,
    );
    expect(new TextDecoder().decode(recovered)).toBe(PLAINTEXT);
  });

  it("a WRONG recipient private key fails to unwrap/decrypt", async () => {
    const recipient = await generateRecipientKeyPair();
    const attacker = await generateRecipientKeyPair();

    const { ciphertext, manifest } = await encryptDeliverable(
      PLAINTEXT,
      { recipientPublicKey: recipient.publicKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/2" },
    );

    await expect(
      decryptDeliverable(
        ciphertext,
        {
          // attacker private key paired with the legit recipient's public key:
          // ECDH yields a different shared secret -> wrong AES key -> GCM fail.
          recipientPrivateKey: attacker.privateKey,
          recipientPublicKey: recipient.publicKey,
        },
        manifest,
      ),
    ).rejects.toThrow();
  });

  it("decrypt with the recipient-key path requires an x25519 manifest", async () => {
    const recipient = await generateRecipientKeyPair();
    const { ciphertext } = await encryptDeliverable(
      PLAINTEXT,
      { recipientPublicKey: recipient.publicKey },
      { taskPda: TASK_PDA, ciphertextUri: "agenc://ct/2" },
    );
    await expect(
      decryptDeliverable(ciphertext, {
        recipientPrivateKey: recipient.privateKey,
        recipientPublicKey: recipient.publicKey,
      }),
    ).rejects.toThrow(/manifest/);
  });
});

describe("buildDeliveryManifest (P7.2)", () => {
  it("stamps version + algo and omits previewUri when absent", () => {
    const m = buildDeliveryManifest({
      taskPda: TASK_PDA,
      ciphertextUri: "agenc://ct/x",
      plaintextHash: "ab".repeat(32),
      keyWrap: { mode: "symmetric" },
    });
    expect(m.v).toBe(1);
    expect(m.encAlgo).toBe(DELIVERY_ENC_ALGO);
    expect("previewUri" in m).toBe(false);
  });
});
