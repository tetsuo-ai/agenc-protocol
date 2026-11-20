// The service's own log never carries the person's Solana connection: it
// usually holds an API key, and a service run by the person's service manager
// writes its log straight to the system journal.
import { describe, expect, it } from "vitest";
import { hideFromLog, logSafe } from "../src/log.js";

describe("the service log", () => {
  it("cuts out the person's own Solana connection wherever it appears", () => {
    const url = "https://rpc.example/?api-key=TOPSECRET";
    expect(logSafe(`fetch ${url} failed`)).toBe(`fetch ${url} failed`);
    hideFromLog(url);
    hideFromLog(url);
    hideFromLog("");
    expect(logSafe(`fetch ${url} failed; again ${url}`)).toBe(
      "fetch [solana connection] failed; again [solana connection]",
    );
    expect(logSafe("nothing to hide")).toBe("nothing to hide");
  });
});
