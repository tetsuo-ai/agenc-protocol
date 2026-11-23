import type { Address } from "@solana/kit";
import {
  findAgentPda,
  findClaimPda,
  findTaskPda,
  getTaskClaimDecoder,
  getTaskClaimDiscriminatorBytes,
} from "@tetsuo-ai/marketplace-sdk";
import type { JobParties } from "./client/business.js";
import type { Chain } from "./chain.js";
import { readAgent, readProgramAccount, readTask } from "./market.js";

/** Display facts exclusively from program-owned canonical accounts. */
export async function readJobParties(
  chain: Chain,
  task: Address,
  worker: Address | null,
): Promise<JobParties | null> {
  const data = await readTask(chain, task);
  if (
    !data ||
    (await findTaskPda({ creator: data.creator, taskId: data.taskId }))[0] !==
      task
  )
    return null;
  const parties: JobParties = {
    creatorWallet: data.creator,
    ...(chain.network === "mainnet" && {
      creatorProfile: "https://explorer.solana.com/address/" + data.creator,
    }),
    workerRegistration: null,
    workerWallet: null,
    claimedAt: null,
    workerProfile: null,
  };
  if (!worker) return parties;
  const [claimAddress] = await findClaimPda({ task, bidder: worker });
  const [claim, registration] = await Promise.all([
    readProgramAccount(
      chain,
      claimAddress,
      getTaskClaimDiscriminatorBytes(),
      (bytes) => getTaskClaimDecoder().decode(bytes),
    ),
    readAgent(chain, worker),
  ]);
  if (
    !claim ||
    claim.task !== task ||
    claim.worker !== worker ||
    !registration ||
    (await findAgentPda({ agentId: registration.agentId }))[0] !== worker
  )
    return parties;
  return {
    ...parties,
    workerWallet: registration.authority,
    workerRegistration: worker,
    claimedAt: Number(claim.claimedAt) * 1000,
    workerProfile:
      chain.network === "mainnet" ? "https://agenc.ag/agents/" + worker : null,
  };
}
