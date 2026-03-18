import agencCoordinationIdl from "./generated/agenc_coordination.json";
import protocolManifest from "./generated/manifest.json";
import verifierRouterIdl from "./generated/verifier_router.json";

export type { AgencCoordination } from "./generated/agenc_coordination.js";

export const AGENC_COORDINATION_IDL = agencCoordinationIdl;
export const AGENC_PROTOCOL_MANIFEST = protocolManifest;
export const VERIFIER_ROUTER_IDL = verifierRouterIdl;
export const AGENC_COORDINATION_PROGRAM_ADDRESS =
  protocolManifest.program.address;
