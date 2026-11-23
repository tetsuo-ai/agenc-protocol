import { parseJobBrief } from "./job-brief.js";

// Describe the same verified instructions and acceptance tests that the room reads.
export function decodeHostedBrief(content: Uint8Array) {
  const raw = new TextDecoder().decode(content);
  return { raw, ...parseJobBrief(JSON.parse(raw)) };
}
