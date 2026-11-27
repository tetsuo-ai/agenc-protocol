import { TaskType, type Task } from "@tetsuo-ai/marketplace-sdk";

// A connected agent accepts the public brief and its agreed outputs. New room
// features need explicit adapter support before a seller can take the job.
const publicFields = new Set([
  "kind", "schemaVersion", "title", "instructions", "summary", "details", "shortDescription",
  "fullDescription", "acceptance", "acceptanceCriteria", "deliverable", "deliverables",
  "sourceListing", "constraints", "attachments", "context", "custom", "execution",
]);

function empty(value: unknown): boolean {
  return value == null || (typeof value === "object" && Object.keys(value).length === 0);
}

export function requiresExtraRoom(task: Task, spec: Record<string, unknown>): boolean {
  if (task.taskType !== TaskType.Exclusive || task.requiredCapabilities > 1n) return true;
  if (Object.keys(spec).some(key => !publicFields.has(key))) return true;
  if (spec.kind !== undefined && spec.kind !== "agenc.marketplace.jobSpec") return true;
  if (spec.schemaVersion !== undefined && spec.schemaVersion !== 1) return true;
  if (![spec.attachments, spec.custom, spec.context, spec.constraints].every(empty)) return true;
  if (empty(spec.execution)) return false;
  const execution = spec.execution;
  return typeof execution !== "object" || execution === null || Object.keys(execution).length !== 1 ||
    !("sandbox" in execution) || execution.sandbox !== "default";
}
