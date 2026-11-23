// Both the approval and the settlement record describe the verified bytes sent to the room.
export function decodeHostedBrief(content: Uint8Array) {
  const raw = new TextDecoder().decode(content);
  const spec = JSON.parse(raw);
  const request = [spec.instructions, spec.fullDescription, spec.details, spec.shortDescription, spec.summary]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  const criteria = spec.acceptance ?? spec.acceptanceCriteria;
  return { raw, request, acceptance: Array.isArray(criteria) ? criteria.filter((v): v is string => typeof v === "string") : [] };
}
