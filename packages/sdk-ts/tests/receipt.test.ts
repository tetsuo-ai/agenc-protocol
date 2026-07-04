import { describe, expect, it } from "vitest";
import { settlementReceiptUrl } from "../src/receipt.js";

const SIGNATURE =
  "XB6kqfYbKb9agso1Xfi8jsE1PX5JjbcnV58urD5MfZaPsXBTFHhXRLxHj7B64ogYj6pAsVoKJassXf4safQzgUR";

describe("settlementReceiptUrl", () => {
  it("builds the canonical hosted receipt URL", () => {
    expect(settlementReceiptUrl(SIGNATURE)).toBe(
      `https://agenc.ag/receipt/${SIGNATURE}`,
    );
  });

  it("supports another node's receipt surface via baseUrl", () => {
    expect(
      settlementReceiptUrl(SIGNATURE, "https://example-node.dev/receipt/"),
    ).toBe(`https://example-node.dev/receipt/${SIGNATURE}`);
  });

  it("rejects values that are not base58 transaction signatures", () => {
    expect(() => settlementReceiptUrl("not-a-signature!")).toThrow(
      /base58 transaction signature/,
    );
    expect(() => settlementReceiptUrl("")).toThrow(
      /base58 transaction signature/,
    );
  });
});
