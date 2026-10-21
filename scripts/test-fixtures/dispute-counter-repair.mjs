// Disposable historical-state fixture. No pre-existing signer material is read.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadDisputeCounterRepairRecord } from "../mainnet-upgrade.mjs";
import { PROGRAM_ID } from "../preflight-dispute-scan.mjs";
const require = createRequire(
  new URL("../../tests-integration/package.json", import.meta.url),
);
export const anchor = require("@coral-xyz/anchor");
export const web3 = require("@solana/web3.js");
const { PublicKey, Keypair } = web3;
export const idl = JSON.parse(
  readFileSync(
    new URL(
      "../../artifacts/anchor/idl/agenc_coordination.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const coder = new anchor.BorshCoder(idl);
const types = new Map(idl.types.map((type) => [type.name, type.type]));
const bn = (n) => new anchor.BN(n);
export function defaultValue(type) {
  if (typeof type === "string") {
    if (["u64", "i64", "u128", "i128"].includes(type)) return bn(0);
    if (type === "pubkey") return PublicKey.default;
    if (type === "bool") return false;
    if (type === "string") return "";
    return 0;
  }
  if (type.array)
    return Array.from({ length: type.array[1] }, () =>
      defaultValue(type.array[0]),
    );
  if (type.option) return null;
  if (type.defined) {
    const def = types.get(type.defined.name);
    if (def.kind === "enum") return { [def.variants[0].name]: {} };
    return Object.fromEntries(
      def.fields.map((field) => [field.name, defaultValue(field.type)]),
    );
  }
  throw new Error(`unsupported fixture type ${JSON.stringify(type)}`);
}
export function accountValue(name, overrides = {}) {
  return {
    ...Object.fromEntries(
      types
        .get(name)
        .fields.map((field) => [field.name, defaultValue(field.type)]),
    ),
    ...overrides,
  };
}
const sizes = {
  ProtocolConfig: 351,
  AgentRegistration: 566,
  Task: 466,
  TaskEscrow: 58,
  TaskClaim: 203,
  Dispute: 590,
};
export async function encodeAccount(name, value) {
  const encoded = await coder.accounts.encode(name, value);
  const data = Buffer.alloc(sizes[name] ?? encoded.length);
  encoded.copy(data);
  return data;
}
export const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) =>
      typeof s === "string"
        ? Buffer.from(s)
        : s instanceof PublicKey
          ? s.toBuffer()
          : s,
    ),
    PROGRAM_ID,
  );
export async function historicalFixture() {
  const authority = Keypair.generate();
  const cosigner = Keypair.generate();
  const thirdOwner = Keypair.generate().publicKey;
  const workerWallet = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const agentId = Buffer.alloc(32, 91);
  const [agent, agentBump] = pda("agent", agentId);
  const [protocol, protocolBump] = pda("protocol");
  const config = accountValue("ProtocolConfig", {
    authority: authority.publicKey,
    treasury,
    bump: protocolBump,
    protocol_paused: true,
    protocol_version: 1,
    min_supported_version: 1,
    surface_revision: 5,
    multisig_threshold: 2,
    multisig_owners_len: 3,
    multisig_owners: [authority.publicKey, cosigner.publicKey, thirdOwner],
    dispute_threshold: 50,
    slash_percentage: 10,
  });
  const agentValue = accountValue("AgentRegistration", {
    agent_id: [...agentId],
    authority: workerWallet,
    status: { Active: {} },
    registered_at: bn(1),
    reputation: 7500,
    active_tasks: 2,
    stake: bn(10_000_000),
    active_dispute_votes: 2,
    disputes_as_defendant: 2,
    bump: agentBump,
  });
  const healthyAgentData = await encodeAccount("AgentRegistration", agentValue);
  // Byte-equivalent reproduction of one lost increment in each liability.
  const deficientAgentData = Buffer.from(healthyAgentData);
  deficientAgentData[160] = 1;
  deficientAgentData[177] = 1;
  const accounts = [
    {
      pubkey: protocol,
      data: await encodeAccount("ProtocolConfig", config),
      lamports: 10_000_000,
    },
    { pubkey: agent, data: deficientAgentData, lamports: 30_000_000 },
  ];
  const record = structuredClone(loadDisputeCounterRepairRecord());
  record.initiatorAgent = agent.toBase58();
  const tasks = [];
  const disputes = [];
  for (let i = 0; i < 2; i++) {
    const taskId = Buffer.alloc(32, 100 + i);
    const disputeId = Buffer.alloc(32, 110 + i);
    const [task, taskBump] = pda("task", creator, taskId);
    const [dispute, disputeBump] = pda("dispute", disputeId);
    const [claim, claimBump] = pda("claim", task, agent);
    const [escrow, escrowBump] = pda("escrow", task);
    const taskValue = accountValue("Task", {
      task_id: [...taskId],
      creator,
      reward_amount: bn(1_000_000),
      max_workers: 1,
      current_workers: 1,
      status: { Disputed: {} },
      task_type: { Exclusive: {} },
      created_at: bn(1),
      deadline: bn(10),
      escrow,
      bump: taskBump,
    });
    const disputeValue = accountValue("Dispute", {
      dispute_id: [...disputeId],
      task,
      initiator: agent,
      initiator_authority: workerWallet,
      defendant: agent,
      status: { Active: {} },
      total_voters: 255,
      created_at: bn(1),
      voting_deadline: bn(2),
      expires_at: bn(3),
      bump: disputeBump,
      initiated_by_creator: false,
      worker_stake_at_dispute: bn(10_000_000),
    });
    const claimValue = accountValue("TaskClaim", {
      task,
      worker: agent,
      claimed_at: bn(1),
      expires_at: bn(2),
      bump: claimBump,
    });
    const escrowValue = accountValue("TaskEscrow", {
      task,
      amount: bn(1_000_000),
      bump: escrowBump,
    });
    for (const [pubkey, name, value, lamports] of [
      [task, "Task", taskValue, 10_000_000],
      [dispute, "Dispute", disputeValue, 10_000_000],
      [claim, "TaskClaim", claimValue, 10_000_000],
      [escrow, "TaskEscrow", escrowValue, 2_000_000],
    ])
      accounts.push({
        pubkey,
        data: await encodeAccount(name, value),
        lamports,
      });
    tasks.push({ pubkey: task, value: taskValue });
    disputes.push({ pubkey: dispute, value: disputeValue });
    const item = i === 0 ? record.incident : record.siblingDisputes[0];
    item.dispute = dispute.toBase58();
    item.task = task.toBase58();
    if (i === 0) item.claim = claim.toBase58();
  }
  return {
    authority,
    cosigner,
    workerWallet,
    creator,
    treasury,
    agent,
    config,
    accounts,
    record,
    tasks,
    disputes,
    healthyAgentData,
    deficientAgentData,
  };
}
