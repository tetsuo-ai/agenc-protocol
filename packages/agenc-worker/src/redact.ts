// Secret-safe error formatting for CLI/runtime diagnostics. RPC providers
// commonly place API keys in URL credentials, query strings, or path segments;
// errors from fetch/@solana/kit may echo the complete endpoint.

const MAX_DIAGNOSTIC_URL_CHARS = 8_192;
const UNPARSEABLE_URL_REDACTION = "[REDACTED_URL]";
const WHATWG_SPECIAL_SCHEMES = new Set([
  "file",
  "ftp",
  "http",
  "https",
  "ws",
  "wss",
]);

function isSchemeCharacter(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 45 ||
    code === 46
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function redactUrl(raw: string): string {
  if (raw.length > MAX_DIAGNOSTIC_URL_CHARS) {
    return UNPARSEABLE_URL_REDACTION;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // There is no safe way to distinguish invalid trailing prose from a URL
    // credential/path/query suffix. Returning any peeled suffix could expose a
    // punctuation-only token, so malformed candidates are replaced wholesale.
    return UNPARSEABLE_URL_REDACTION;
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
  return url.toString();
}

/** Remove credentials and path/query tokens from every hierarchical URL. */
export function redactSensitiveText(text: string): string {
  const pieces: string[] = [];
  let copiedUntil = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const separator = text.indexOf(":", searchFrom);
    if (separator === -1) break;

    let schemeStart = separator;
    while (
      schemeStart > copiedUntil &&
      isSchemeCharacter(text.charCodeAt(schemeStart - 1))
    ) {
      schemeStart -= 1;
    }
    // Digits and `+.-` are legal *continuation* characters in a scheme, but
    // never legal as its first character. A diagnostic can therefore place a
    // valid URL immediately after one of them (`1https://...`). Preserve that
    // prefix and redact from the first ASCII letter instead of skipping the
    // credentialed URL altogether.
    while (
      schemeStart < separator &&
      !isAsciiLetter(text.charCodeAt(schemeStart))
    ) {
      schemeStart += 1;
    }
    if (schemeStart === separator) {
      searchFrom = separator + 1;
      continue;
    }

    const scheme = text.slice(schemeStart, separator).toLowerCase();
    const hasAuthorityMarker = text.startsWith("//", separator + 1);
    // WHATWG treats file, FTP, HTTP(S), and WS(S) as special schemes and repairs
    // missing or backslash authority markers (`https:host`, `https:/host`,
    // `https:\\host`). They can therefore be accepted by URL/config parsing
    // and later echoed by a transport even though they contain no literal
    // `://`. Keep arbitrary hierarchical schemes, but also catch every spelling
    // of the fixed special schemes before any diagnostic is emitted.
    if (!hasAuthorityMarker && !WHATWG_SPECIAL_SCHEMES.has(scheme)) {
      searchFrom = separator + 1;
      continue;
    }

    // WHATWG URL parsing accepts or strips spaces, tabs, and line breaks inside
    // credentials, paths, and queries. There is therefore no delimiter after a
    // detected scheme that can safely prove the URL-carried secret has ended.
    // Consume the remaining diagnostic. This intentionally sacrifices prose
    // after the first URL rather than risk returning a credential/token suffix.
    const end = text.length;
    pieces.push(text.slice(copiedUntil, schemeStart));
    pieces.push(redactUrl(text.slice(schemeStart, end)));
    copiedUntil = end;
    searchFrom = end;
  }

  if (pieces.length === 0) return text;
  pieces.push(text.slice(copiedUntil));
  return pieces.join("");
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
