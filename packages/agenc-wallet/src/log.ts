// The wallet service's own log (stderr). A host that runs the service as its
// child filters that log itself; a service run by the person's service
// manager writes straight to the system journal, so what must never appear
// there is cut out here, before a line is written.

const hidden: string[] = [];

/** Never write `text` (the person's own Solana connection, which can hold an API key). */
export function hideFromLog(text: string): void {
  if (text.length > 0 && !hidden.includes(text)) hidden.push(text);
}

/** A log line with everything hidden replaced. */
export function logSafe(line: string): string {
  let safe = line;
  for (const text of hidden) safe = safe.split(text).join("[solana connection]");
  return safe;
}
