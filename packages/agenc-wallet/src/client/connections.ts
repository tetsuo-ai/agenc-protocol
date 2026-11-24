// Owner-issued installation grants. A project label is for attribution. The
// wallet agent selected by the owner is the authority for every ordinary call.
export interface ConnectionScope {
  id: string;
  label: string;
  project: string;
  agentId: string;
  access: "read" | "trade";
  expiresAt: number;
}
export type HandoffPermission = "status" | "artifacts" | "propose";
export interface JobHandoff {
  connectionId: string;
  jobId: string;
  payer: string;
  permissions: HandoffPermission[];
  grantedAt: number;
}
export interface ConnectionAudit {
  at: number;
  installation: string;
  project: string;
  agentId: string;
  operationId?: string;
  action: "handoff" | "revoke" | "propose" | "purchase";
  jobId?: string;
  payer?: string;
  permissions?: HandoffPermission[];
}
export interface ConnectionMethods {
  "connections.invite": {
    params: Pick<ConnectionScope, "label" | "project" | "agentId" | "access">;
    result: {
      socket: string;
      code: string;
      expiresAt: number;
      id: string;
      brokerKey: string;
    };
  };
  "connections.list": {
    params: Record<string, never>;
    result: {
      connections: ConnectionScope[];
      handoffs: JobHandoff[];
      audit: ConnectionAudit[];
    };
  };
  "connections.revoke": {
    params: { id: string };
    result: { revoked: boolean };
  };
  "connections.handoff": {
    params: { id: string; jobId: string; permissions: HandoffPermission[] };
    result: { saved: boolean };
  };
  "connections.info": {
    params: Record<string, never>;
    result: ConnectionScope & { network: string; background: boolean };
  };
  "connections.attach": {
    params: Record<string, never>;
    result: { ticket: string };
  };
  "connections.redeem": { params: { ticket: string }; result: ConnectionScope };
  "agents.self": {
    params: Record<string, never>;
    result: { id: string; address: string };
  };
  "connections.check": { params: { id: string }; result: ConnectionScope };
  "connections.tool": {
    params: {
      name: import("./tools.js").MarketToolName;
      args: Record<string, unknown>;
      operationId?: string;
      lookup?: boolean;
    };
    result: import("./tools.js").MarketToolResult | null;
  };
  "connections.changes": {
    params: { cursor?: number };
    result: { cursor: number; reset: boolean; jobs: string[] };
  };
  "connections.subscribe": {
    params: { jobId: string };
    result: { subscribed: boolean };
  };
  "handoff.status": {
    params: { jobId: string };
    result: {
      jobId: string;
      payer: string;
      title: string;
      status: string;
      task: string | null;
      updatedAt: number;
      parties?: import("./business.js").JobParties;
      actions?: import("./business.js").JobAction[];
      actions_unavailable?: boolean;
    };
  };
  "handoff.delivery": {
    params: { jobId: string };
    result: { result: import("./types.js").JobResult };
  };
  "handoff.file": {
    params: { jobId: string; sha256: string };
    result: {
      file: import("./delivery-files.js").DeliveryFile & { base64: string };
    };
  };
  "handoff.propose": {
    params: {
      jobId: string;
      action: import("./reviews.js").ReviewAction;
      note: string;
    };
    result: { draft: import("./reviews.js").ReviewDraft };
  };
}
