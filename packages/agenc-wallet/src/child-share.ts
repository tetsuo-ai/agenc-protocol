// Copy only the parent's authenticated, already-imported bundle into B's seller-local
// staging area. The supplier gets a fresh commitment and its own confirmed-claim grant.
import {
  address,
  getPublicKeyFromAddress,
  verifySignature,
  signatureBytes,
  type KeyPairSigner,
} from "@solana/kit";
import type { ChildShareBinding } from "./client/child-hire.js";
import { childSharePayload } from "./client/child-hire.js";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import type { ChildHireRequest, ChildRoomGrant } from "./client/child-hire.js";
import { WalletError } from "./errors.js";

type Parties = {
  task: string;
  claim: string;
  worker: string;
  buyer: string;
  authority: string;
  claimedAt: string;
  room: string;
};
type Bundle = {
  files: { name: string; bytes: number; sha256: string; base64: string }[];
  processing?: string;
  version: number;
};
type Stage = { version: 1; required: true; commitment: string };
interface ShareWallet {
  jobExchange?(
    id: string,
    room: string,
    agentId: string,
  ): Promise<{
    live(): Promise<Parties>;
    journal: { read<T>(id: string): T | undefined };
    receiveBundle(packet: unknown, purpose: "inputs", commitment: string): Promise<Bundle>;
  }>;
  stageJobInputs?(
    files: Bundle["files"],
    recipient: string,
    processing: string,
    outputs: { requiredFiles: string[]; allowTextOnly: boolean },
  ): Promise<Stage>;
  approvedJobInputs?(commitment: string): Promise<Stage>;
}
const unavailable = () =>
  new WalletError("NOT_ALLOWED", "The buyer's confirmed private handoff is unavailable for this supplier.");

function shareMessage(binding: ChildShareBinding) {
  return new TextEncoder().encode(
    JSON.stringify([
      "agenc.child-share.v1",
      address(binding.parentTask),
      childSharePayload(address(binding.supplier), binding.request),
    ]),
  );
}

export async function signChildShare(signer: KeyPairSigner, binding: ChildShareBinding) {
  const [signed] = await signer.signMessages([{ content: shareMessage(binding), signatures: {} }]);
  return Buffer.from(signed![signer.address]!).toString("base64");
}

export async function verifyChildShare(buyer: string, binding: ChildShareBinding, proof?: string) {
  if (
    !proof ||
    !/^[A-Za-z0-9+/]{86}==$/.test(proof) ||
    !binding.request.privateCommitment ||
    !(await verifySignature(
      await getPublicKeyFromAddress(address(buyer)),
      signatureBytes(Uint8Array.from(Buffer.from(proof, "base64"))),
      shareMessage(binding),
    ))
  )
    throw new WalletError(
      "NOT_ALLOWED",
      "The original buyer must approve these files for this order and supplier.",
    );
}

export async function stageChildShare(
  wallet: ShareWallet,
  grant: ChildRoomGrant,
  request: ChildHireRequest,
  supplier: string,
  proof: string,
  saved?: string,
) {
  const context = (taskThread as { exchangeContext?: (parties: Parties) => string }).exchangeContext;
  const original = request.privateCommitment;
  if (!context || !original || !wallet.jobExchange || !wallet.stageJobInputs || !wallet.approvedJobInputs)
    throw unavailable();
  const exchange = await wallet.jobExchange(
    "earn_" + grant.sellerAgentId + "_" + grant.parentTask,
    grant.roomId,
    grant.sellerAgentId,
  );
  const parties = await exchange.live();
  if (
    parties.task !== grant.parentTask ||
    parties.claimedAt !== grant.claimedAt ||
    parties.room !== grant.roomId
  )
    throw unavailable();
  await verifyChildShare(parties.buyer, { parentTask: parties.task, supplier, request }, proof);
  const box = exchange.journal.read<{
    inputs: unknown;
    receipt?: {
      commitment: string;
      manifest: string;
      room: string;
      version: number;
    };
  }>("inbox/" + context(parties));
  if (
    !box?.inputs ||
    box.receipt?.commitment !== original ||
    box.receipt.manifest !== original ||
    box.receipt.room !== parties.room
  )
    throw unavailable();
  const bundle = await exchange.receiveBundle(box.inputs, "inputs", original);
  if (bundle.version !== box.receipt.version || !bundle.processing) throw unavailable();
  const requiredFiles = request.outputs.filter((name) => name !== "text");
  const stage = saved
    ? await wallet.approvedJobInputs(saved)
    : await wallet.stageJobInputs(bundle.files, supplier, bundle.processing, {
        requiredFiles,
        allowTextOnly: !requiredFiles.length,
      });
  if (
    stage?.required !== true ||
    stage.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(stage.commitment) ||
    (saved && stage.commitment !== saved)
  )
    throw unavailable();
  return stage.commitment;
}
