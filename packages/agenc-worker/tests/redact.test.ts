import { describe, expect, it } from "vitest";
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
    expect(diagnostic).toContain("rpc.example");
    expect(diagnostic).toMatch(/\]$/u);
    expect(diagnostic).not.toMatch(/bracket-user|bracket-pass/);

    const ipv6 = redactSensitiveText(
      "request failed [https://ipv6-user:ipv6-pass@[2001:db8::1]]",
    );
    expect(ipv6).toContain("[2001:db8::1]");
    expect(ipv6).toMatch(/\]$/u);
    expect(ipv6).not.toMatch(/ipv6-user|ipv6-pass/);
  });

  it("redacts credentials before Unicode prose punctuation", () => {
    const diagnostic = redactSensitiveText(
      "RPC failed at https://unicode-user:unicode-pass@rpc.example… then retried https://quote-user:quote-pass@rpc.example/path-token”",
    );
    expect(diagnostic).toContain("rpc.example");
    expect(diagnostic).toContain("…");
    expect(diagnostic).toContain("”");
    expect(diagnostic).not.toMatch(
      /unicode-user|unicode-pass|quote-user|quote-pass|path-token/,
    );
  });
});
