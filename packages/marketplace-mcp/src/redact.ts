/**
 * Credential-redaction helpers for every diagnostic surface of the MCP server
 * (boot logs, the fatal handler, MCP tool-error results, and process-level crash
 * handlers). Shared so no surface can drift back to printing raw provider URLs.
 *
 * @module redact
 */

/**
 * Strip credentials from a URL before it reaches a diagnostic log. Provider RPC and
 * indexer URLs routinely embed API keys (Helius `?api-key=`, Alchemy `/v2/<key>`,
 * QuickNode `/<token>/`); `URL.origin` keeps only `scheme://host:port`, dropping
 * userinfo, path, query and fragment — where those secrets live. Unparseable input
 * yields a placeholder rather than being echoed raw.
 */
export function redactUrl(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw === "") return "none";
  try {
    return new URL(raw).origin;
  } catch {
    return "<unparseable-url-redacted>";
  }
}

/** The configured secret-bearing values, plus their trimmed forms (config.ts
 * trims env values, so an error may embed either form). */
function* secretCandidates(): Generator<{ needle: string; replacement: string }> {
  for (const raw of [process.env.AGENC_RPC_URL, process.env.AGENC_INDEXER_URL]) {
    if (raw === undefined || raw === "") continue;
    yield { needle: raw, replacement: redactUrl(raw) };
    const trimmed = raw.trim();
    if (trimmed !== raw && trimmed !== "") {
      yield { needle: trimmed, replacement: redactUrl(trimmed) };
    }
  }
  const apiKey = process.env.AGENC_INDEXER_API_KEY;
  if (apiKey !== undefined && apiKey !== "") {
    yield { needle: apiKey, replacement: "<redacted>" };
    const trimmed = apiKey.trim();
    if (trimmed !== apiKey && trimmed !== "") {
      yield { needle: trimmed, replacement: "<redacted>" };
    }
  }
}

/**
 * Scrub configured endpoints/secrets out of arbitrary error text before it reaches
 * any output channel. Provider/client errors (e.g. undici's "Request cannot be
 * constructed from a URL that includes credentials: <full url>", or SDK indexer
 * errors of the form `indexer at ${baseUrl} responded …`) embed the request URL
 * verbatim — including userinfo and query-string API keys — so a raw print would
 * leak them. Exact-match replacement of the configured values is deliberate: a
 * generic URL regex would also mangle harmless diagnostic links.
 */
export function sanitizeDiagnostic(text: string): string {
  let out = text;
  for (const { needle, replacement } of secretCandidates()) {
    out = out.split(needle).join(replacement);
  }
  return out;
}
