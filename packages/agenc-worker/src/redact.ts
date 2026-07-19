// Secret-safe error formatting for CLI/runtime diagnostics. RPC providers
// commonly place API keys in URL credentials, query strings, or path segments;
// errors from fetch/@solana/kit may echo the complete endpoint.

const NETWORK_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu;
// `]` is intentionally absent: it is structural in an IPv6 URL host.
const TRAILING_PUNCTUATION = /[),.;}]+$/u;
const RECOVERABLE_UNICODE_BOUNDARY = /[\p{P}\p{S}]/u;
const NON_ASCII = /[^\u0000-\u007f]/u;

function redactUrl(raw: string): string {
  let trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  let candidate = trailing === "" ? raw : raw.slice(0, -trailing.length);
  while (true) {
    const last = Array.from(candidate).at(-1);
    if (
      last === undefined ||
      !NON_ASCII.test(last) ||
      !RECOVERABLE_UNICODE_BOUNDARY.test(last)
    ) {
      break;
    }
    candidate = candidate.slice(0, -last.length);
    trailing = `${last}${trailing}`;
  }
  // A prose wrapper such as `[https://user:pass@example.test]` otherwise
  // leaves `]` attached to the authority, causing URL parsing to fail and the
  // credentials to pass through unchanged. Keep a final `]` only when it is
  // the structural close of an IPv6 host with no path/query/fragment.
  if (candidate.endsWith("]")) {
    let structuralIpv6Close = false;
    try {
      const parsed = new URL(candidate);
      structuralIpv6Close =
        parsed.hostname.startsWith("[") && candidate.endsWith(parsed.host);
    } catch {
      // Removing a prose bracket below may make the URL parseable.
    }
    if (!structuralIpv6Close) {
      const withoutBracket = candidate.slice(0, -1);
      try {
        new URL(withoutBracket);
        candidate = withoutBracket;
        trailing = `]${trailing}`;
      } catch {
        // Preserve raw text if neither form is a parseable URL.
      }
    }
  }
  let url: URL;
  while (true) {
    try {
      url = new URL(candidate);
      break;
    } catch {
      // Diagnostics may wrap a URL in Unicode prose punctuation (`…`, `”`,
      // full-width brackets, and so on). The broad URL matcher necessarily
      // captures that suffix. Peel only punctuation/symbol code points, and
      // only while parsing fails, so real parseable URL content is preserved.
      const codePoints = Array.from(candidate);
      const last = codePoints.at(-1);
      if (last === undefined || !RECOVERABLE_UNICODE_BOUNDARY.test(last)) {
        return raw;
      }
      candidate = candidate.slice(0, -last.length);
      trailing = `${last}${trailing}`;
    }
  }

  if (url.username !== "" || url.password !== "") {
    url.username = "REDACTED";
    url.password = "REDACTED";
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    url.pathname = url.pathname
      .split("/")
      .map((segment) => (segment === "" ? "" : "REDACTED"))
      .join("/");
  }
  if (url.search !== "") url.search = "?REDACTED";
  if (url.hash !== "") url.hash = "#REDACTED";
  return `${url.toString()}${trailing}`;
}

/** Remove credentials and path/query tokens from every hierarchical URL. */
export function redactSensitiveText(text: string): string {
  return text.replace(NETWORK_URL, (url) => redactUrl(url));
}

/** Format an unknown thrown value without leaking URL-carried RPC secrets. */
export function formatDiagnosticError(
  error: unknown,
  options: { includeStack?: boolean } = {},
): string {
  const raw =
    error instanceof Error
      ? options.includeStack === true
        ? (error.stack ?? error.message)
        : error.message
      : String(error);
  return redactSensitiveText(raw);
}
