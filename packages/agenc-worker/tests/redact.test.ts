import { describe, expect, it } from "vitest";
import { resolveWorkerConfig } from "../src/config.js";
import { formatDiagnosticError, redactSensitiveText } from "../src/redact.js";

describe("secret-safe diagnostics", () => {
  it("redacts URL credentials plus RPC query and path tokens", () => {
    const diagnostic = redactSensitiveText(
      "RPC failed: https://user:pass@rpc.example/v2/path-token?api-key=query-token",
    );
    expect(diagnostic).toContain("rpc.example");
    expect(diagnostic).toContain("REDACTED");
    expect(diagnostic).not.toMatch(/user|pass|path-token|query-token/);
  });

  it("redacts every URL in an Error stack without dropping useful context", () => {
    const error = new Error(
      "Request cannot be constructed from a URL that includes credentials: https://alice:hunter2@example.com/rpc/project-secret?token=query-secret",
    );
    const diagnostic = formatDiagnosticError(error, { includeStack: true });
    expect(diagnostic).toContain("Error: Request cannot be constructed");
    expect(diagnostic).toContain("example.com");
    expect(diagnostic).not.toMatch(/alice|hunter2|project-secret|query-secret/);
  });

  it("redacts websocket RPC credentials and routing tokens", () => {
    const diagnostic = redactSensitiveText(
      "subscription failed at wss://socket-user:socket-pass@rpc.example/ws/private-channel?token=secret",
    );
    expect(diagnostic).toContain("rpc.example");
    expect(diagnostic).not.toMatch(
      /socket-user|socket-pass|private-channel|secret/,
    );
  });

  it("redacts WHATWG-repaired special-scheme URLs without literal ://", () => {
    for (const url of [
      "https:\\\\rpc.example\\private-token?api-key=query-secret",
      "https:/rpc.example/private-token?api-key=query-secret",
      "https:rpc.example/private-token?api-key=query-secret",
      "wss:\\\\rpc.example\\private-channel?token=socket-secret",
    ] as const) {
      const diagnostic = redactSensitiveText(`failure ${url}`);
      expect(diagnostic).toContain("rpc.example");
      expect(diagnostic).not.toMatch(
        /private-token|query-secret|private-channel|socket-secret/,
      );
    }
  });

  it("redacts every WHATWG special scheme across slash variants and casing", () => {
    for (const scheme of ["HtTp", "hTtPs", "Ws", "wSs", "FtP"] as const) {
      for (const separator of ["://", ":\\\\", ":/", ":"] as const) {
        const url = `${scheme}${separator}user:pass@example.test/private-token?token=query-secret`;
        const diagnostic = redactSensitiveText(`failure ${url}`);
        expect(diagnostic).toContain("example.test");
        expect(diagnostic).not.toMatch(/user|pass|private-token|query-secret/);
      }
    }

    for (const url of [
      "file:C:/private-file.txt",
      "FiLe:/C:/private-file.txt",
      "FILE:\\\\server\\share\\private-file.txt",
    ] as const) {
      const diagnostic = redactSensitiveText(`failure ${url}`);
      expect(diagnostic).toContain("file:");
      expect(diagnostic).not.toContain("private-file");
    }
  });

  it("redacts noncanonical network URLs accepted from worker config", () => {
    const rpcUrl =
      "https:\\\\rpc.example\\private-token?api-key=config-rpc-secret";
    const resultUploader =
      "https:uploader.example/private-result?token=config-upload-secret";
    const config = resolveWorkerConfig({
      rpcUrl,
      resultUploader,
      walletPath: "/tmp/worker.json",
    });
    const diagnostic = formatDiagnosticError(
      new Error(
        `RPC ${config.rpcUrl} failed; uploader ${config.resultUploader} failed`,
      ),
    );
    expect(diagnostic).toContain("rpc.example");
    expect(diagnostic).not.toMatch(
      /private-token|config-rpc-secret|private-result|config-upload-secret/,
    );
  });

  it("handles arbitrary hierarchical schemes and bracketed IPv6 hosts", () => {
    const diagnostic = redactSensitiveText(
      "custom+rpc://ipv6-user:ipv6-pass@[2001:db8::1]:8900/v3/private-token?api-key=query-token",
    );
    expect(diagnostic).toContain("custom+rpc://");
    expect(diagnostic).toContain("[2001:db8::1]:8900");
    expect(diagnostic).not.toMatch(
      /ipv6-user|ipv6-pass|private-token|query-token/,
    );
  });

  it("redacts a credentialed authority before a closing prose bracket", () => {
    const diagnostic = redactSensitiveText(
      "request failed [https://bracket-user:bracket-pass@rpc.example]",
    );
    expect(diagnostic).toContain("REDACTED");
    expect(diagnostic).not.toMatch(/bracket-user|bracket-pass/);

    const ipv6 = redactSensitiveText(
      "request failed [https://ipv6-user:ipv6-pass@[2001:db8::1]]",
    );
    expect(ipv6).toContain("REDACTED");
    expect(ipv6).not.toMatch(/ipv6-user|ipv6-pass/);
  });

  it("redacts credentials before Unicode prose punctuation", () => {
    const diagnostic = redactSensitiveText(
      "RPC failed at https://unicode-user:unicode-pass@rpc.example… then retried https://quote-user:quote-pass@rpc.example/path-token”",
    );
    expect(diagnostic).toContain("RPC failed at");
    expect(diagnostic).toContain("REDACTED");
    expect(diagnostic).not.toMatch(
      /unicode-user|unicode-pass|quote-user|quote-pass|path-token/,
    );
  });

  it("fails closed for malformed and oversized URL-like diagnostics", () => {
    const malformed = redactSensitiveText(
      "RPC failed at https://user:secret@[not-an-ipv6/private-token",
    );
    expect(malformed).toContain("[REDACTED_URL]");
    expect(malformed).not.toMatch(/user|secret|private-token/);

    const oversizedSecret = `https://rpc.example/${"s".repeat(20_000)}`;
    const oversized = redactSensitiveText(`failure: ${oversizedSecret}`);
    expect(oversized).toBe("failure: [REDACTED_URL]");
    expect(oversized).not.toContain("s".repeat(100));

    for (const punctuationSecret of [
      "https://u:p@[bad/!!!!",
      "https://u:p@[bad/💥💥",
    ]) {
      expect(redactSensitiveText(`failure: ${punctuationSecret}`)).toBe(
        "failure: [REDACTED_URL]",
      );
    }
  });

  it("does not mistake non-letter pseudo-schemes for URLs", () => {
    expect(redactSensitiveText("status 1rpc://not-a-url")).toBe(
      "status 1rpc://not-a-url",
    );
  });

  it("redacts valid URL suffixes after invalid scheme-prefix characters", () => {
    for (const [prefix, url] of [
      ["1", "https://number-user:number-pass@rpc.example/private-number"],
      ["-", "wss://dash-user:dash-pass@rpc.example/private-dash"],
      ["+", "custom://plus-user:plus-pass@rpc.example/private-plus"],
    ] as const) {
      const diagnostic = redactSensitiveText(`failure ${prefix}${url}`);
      expect(diagnostic).toContain(`failure ${prefix}`);
      expect(diagnostic).toContain("rpc.example");
      expect(diagnostic).not.toMatch(
        /number-user|number-pass|private-number|dash-user|dash-pass|private-dash|plus-user|plus-pass|private-plus/,
      );
    }
  });

  it("does not expose URL secrets containing quote or angle characters", () => {
    for (const marker of ["'", "`", '"', "<", ">"] as const) {
      const credentialDiagnostic = redactSensitiveText(
        `failure https://user:pa${marker}ss@rpc.example/private-token`,
      );
      expect(credentialDiagnostic).toContain("rpc.example");
      expect(credentialDiagnostic).not.toMatch(/user|private-token|pa/);
      expect(credentialDiagnostic).not.toContain(`${marker}ss@`);

      const pathDiagnostic = redactSensitiveText(
        `failure https://rpc.example/path${marker}secret?token=query-secret`,
      );
      expect(pathDiagnostic).toContain("rpc.example");
      expect(pathDiagnostic).not.toMatch(/path|secret|token/);
    }
  });

  it("does not expose URL secrets containing whitespace characters", () => {
    for (const marker of [" ", "\t", "\r", "\n"] as const) {
      const credentialDiagnostic = redactSensitiveText(
        `failure https://user:pa${marker}ss@rpc.example/private-token`,
      );
      expect(credentialDiagnostic).toContain("rpc.example");
      expect(credentialDiagnostic).not.toMatch(/user|private-token|ss@/);

      const pathDiagnostic = redactSensitiveText(
        `failure https://rpc.example/api-key=sec${marker}ret?token=query-secret`,
      );
      expect(pathDiagnostic).toContain("rpc.example");
      expect(pathDiagnostic).not.toMatch(/api-key|secret|token|query/);
    }
  });

  it("does not preserve punctuation-only path or query secrets", () => {
    for (const secret of ["!!!!", "....", "]]}}", "💥💥", "…””"] as const) {
      const pathDiagnostic = redactSensitiveText(
        `failure https://rpc.example/${secret}`,
      );
      expect(pathDiagnostic).not.toContain(secret);

      const queryDiagnostic = redactSensitiveText(
        `failure https://rpc.example/?token=${secret}`,
      );
      expect(queryDiagnostic).not.toContain(secret);
    }
  });
});
