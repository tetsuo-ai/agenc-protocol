// The check a wallet key runs before it signs an approval somebody else
// built. Every transaction here is a real one, signed by a real approver key,
// so each refusal below is of something the network itself would have run.
import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  facade,
  findModerationAttestorPda,
  getListingModerationSize,
  getTaskModerationSize,
} from "@tetsuo-ai/marketplace-sdk";
import {
  APPROVAL_FEE_LAMPORTS,
  approvalCost,
  checkApprovalTransaction,
  signApproval,
  type ApprovalTarget,
} from "../src/approval.js";
import { SYSTEM_PROGRAM_ADDRESS, transferInstruction, type Chain } from "../src/chain.js";

const fill = (byte: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const TASK = fill(3);
const LISTING = fill(4);
const THIEF = fill(5);
const HASH = new Uint8Array(32).fill(0xab);
const BLOCKHASH = fill(7) as unknown as Blockhash;
/** The deposit behind one approval record on this pretend chain. */
const DEPOSIT = 2_519_520n;

const VERDICT = {
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32).fill(1),
  scannerHash: new Uint8Array(32).fill(2),
  expiresAt: 0n,
};

const payer = await generateKeyPairSigner();
const approver = await generateKeyPairSigner();
/** The payer as the approver's side sees it: an address, no key. */
const payerSlot = createNoopSigner(payer.address);

const TARGET: ApprovalTarget = { kind: "task", task: TASK, hash: HASH };
const EXPECTED = {
  payer: payer.address,
  moderator: approver.address,
  target: TARGET,
  maxDepositLamports: DEPOSIT,
};

async function taskApproval(
  overrides: {
    moderator?: TransactionSigner;
    task?: Address;
    hash?: Uint8Array;
    status?: number;
    roster?: boolean;
  } = {},
): Promise<Instruction> {
  const moderator = overrides.moderator ?? approver;
  return (await facade.recordTaskModeration({
    moderator,
    task: overrides.task ?? TASK,
    jobSpecHash: overrides.hash ?? HASH,
    status: overrides.status ?? 0,
    ...(overrides.roster
      ? { moderationAttestor: (await findModerationAttestorPda({ attestor: moderator.address }))[0] }
      : {}),
    ...VERDICT,
  })) as Instruction;
}

async function listingApproval(): Promise<Instruction> {
  return (await facade.recordListingModeration({
    moderator: approver,
    listing: LISTING,
    jobSpecHash: HASH,
    status: 0,
    ...VERDICT,
  })) as Instruction;
}

/** Build a transaction the way an approver would and sign the approver's part. */
async function build(
  instructions: Instruction[],
  options: {
    feePayer?: TransactionSigner;
    version?: 0 | "legacy";
    lookups?: Record<Address, Address[]>;
  } = {},
): Promise<Uint8Array> {
  const feePayer = options.feePayer ?? payerSlot;
  let message = pipe(
    createTransactionMessage({ version: (options.version ?? 0) as 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  if (options.lookups) {
    message = compressTransactionMessageUsingAddressLookupTables(
      message,
      options.lookups as never,
    ) as typeof message;
  }
  const partial = await partiallySignTransactionMessageWithSigners(message);
  return new Uint8Array(getTransactionEncoder().encode(partial));
}

const pay = (lamports: bigint, to: Address = approver.address): Instruction =>
  transferInstruction(payerSlot, to, lamports);

/** The honest transaction: hand over the deposit, record the approval. */
const honest = async (): Promise<Uint8Array> => build([pay(DEPOSIT), await taskApproval()]);

async function refused(
  wire: Uint8Array,
  expected: Parameters<typeof checkApprovalTransaction>[1] = EXPECTED,
): Promise<string> {
  const error = await checkApprovalTransaction(wire, expected).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error, "the transaction was accepted").toMatchObject({
    code: "NETWORK",
    message: expect.stringMatching(/cannot be trusted\. Nothing was paid\.$/),
  });
  return String(((error as Error).cause as Error).message);
}

describe("an approval this wallet will sign", () => {
  it("is the deposit to the approver, then the approval of what was asked for", async () => {
    const checked = await checkApprovalTransaction(await honest(), EXPECTED);
    expect(checked.depositLamports).toBe(DEPOSIT);
    // Signed by the approver already; the payer's place is still empty.
    expect(checked.transaction.signatures[approver.address]).toBeInstanceOf(Uint8Array);
    expect(checked.transaction.signatures[payer.address]).toBeNull();
  });

  it("may ask for less than the deposit, or for nothing when the record exists", async () => {
    const less = await checkApprovalTransaction(
      await build([pay(900_000n), await taskApproval()]),
      EXPECTED,
    );
    expect(less.depositLamports).toBe(900_000n);
    const none = await checkApprovalTransaction(await build([await taskApproval()]), EXPECTED);
    expect(none.depositLamports).toBe(0n);
  });

  it("may come from an approver on the roster as well as from the marketplace itself", async () => {
    const checked = await checkApprovalTransaction(
      await build([pay(DEPOSIT), await taskApproval({ roster: true })]),
      EXPECTED,
    );
    expect(checked.depositLamports).toBe(DEPOSIT);
  });

  it("may be for a service's description", async () => {
    const expected = {
      ...EXPECTED,
      target: { kind: "listing", listing: LISTING, hash: HASH } as ApprovalTarget,
    };
    const wire = await build([pay(DEPOSIT), await listingApproval()]);
    expect((await checkApprovalTransaction(wire, expected)).depositLamports).toBe(DEPOSIT);
    // The same transaction is not an approval of a job.
    expect(await refused(wire)).toMatch(/something else/);
    // And a job's approval is not one of a service.
    expect(await refused(await honest(), expected)).toMatch(/something else/);
  });

  it("gets the payer's signature only after it passed", async () => {
    const chain = { getMinimumBalanceForRentExemption: async () => DEPOSIT } as unknown as Chain;
    const payment = { transaction: await honest(), moderator: approver.address };

    const ready = await signApproval(chain, payer, payment, TARGET);

    expect(ready.depositLamports).toBe(DEPOSIT);
    for (const signer of [payer, approver] as KeyPairSigner[]) {
      const signature = ready.transaction.signatures[signer.address];
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(
        await verifySignature(signer.keyPair.publicKey, signature!, ready.transaction.messageBytes),
      ).toBe(true);
    }

    // One lamport above what the chain says the record costs: not signed.
    const greedy = { transaction: await build([pay(DEPOSIT + 1n), await taskApproval()]), moderator: approver.address };
    await expect(signApproval(chain, payer, greedy, TARGET)).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("costs its deposit and the fee of two signatures", async () => {
    const asked: number[] = [];
    const chain = {
      getMinimumBalanceForRentExemption: async (space: number) => {
        asked.push(space);
        return DEPOSIT;
      },
    } as unknown as Chain;
    expect(APPROVAL_FEE_LAMPORTS).toBe(10_000n);
    expect(await approvalCost(chain, "task")).toBe(DEPOSIT + 10_000n);
    expect(await approvalCost(chain, "listing")).toBe(DEPOSIT + 10_000n);
    expect(asked).toEqual([getTaskModerationSize(), getListingModerationSize()]);
  });
});

describe("an approval this wallet refuses to sign", () => {
  it("takes more than the record's deposit", async () => {
    expect(await refused(await build([pay(DEPOSIT + 1n), await taskApproval()]))).toMatch(
      /above the deposit/,
    );
    expect(await refused(await build([pay(1_000_000_000n), await taskApproval()]))).toMatch(
      /above the deposit/,
    );
  });

  it("pays somebody other than the approver", async () => {
    expect(await refused(await build([pay(DEPOSIT, THIEF), await taskApproval()]))).toMatch(
      /not from the payer to the approver/,
    );
  });

  it("holds a second payment, in any place", async () => {
    const approval = await taskApproval();
    for (const steps of [
      [pay(DEPOSIT), pay(1_000_000_000n, THIEF), approval],
      [pay(DEPOSIT), approval, pay(1_000_000_000n, THIEF)],
      [pay(1_000_000_000n, THIEF), pay(DEPOSIT), approval],
    ]) {
      expect(await refused(await build(steps))).toMatch(/wrong number of steps/);
    }
    // Two steps signed by both, but the approver takes the deposit and
    // records nothing.
    const pocket = transferInstruction(approver, THIEF, 1n);
    expect(await refused(await build([pay(DEPOSIT), pocket]))).toMatch(/not the marketplace's/);
  });

  it("bids up the network fee at the payer's cost", async () => {
    const price = new Uint8Array(9);
    price[0] = 3; // ComputeBudget: SetComputeUnitPrice
    new DataView(price.buffer).setBigUint64(1, 1_000_000_000_000n, true);
    const bid: Instruction = {
      programAddress: address("ComputeBudget111111111111111111111111111111"),
      accounts: [],
      data: price,
    };
    expect(await refused(await build([bid, pay(DEPOSIT), await taskApproval()]))).toMatch(
      /wrong number of steps/,
    );
    expect(await refused(await build([bid, await taskApproval()]))).toMatch(/not a transfer/);
  });

  it("uses the payer's key for anything but a plain transfer", async () => {
    // Twelve bytes like a transfer, but "allocate" on the payer's own account.
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 9, true);
    view.setBigUint64(4, DEPOSIT, true);
    const other: Instruction = {
      programAddress: SYSTEM_PROGRAM_ADDRESS,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payerSlot } as never,
        { address: approver.address, role: AccountRole.WRITABLE },
      ],
      data,
    };
    expect(await refused(await build([other, await taskApproval()]))).toMatch(/not a plain transfer/);

    // "Assign": hand the payer's account to another program.
    const assign = new Uint8Array(36);
    new DataView(assign.buffer).setUint32(0, 1, true);
    expect(
      await refused(await build([{ ...other, data: assign }, await taskApproval()])),
    ).toMatch(/malformed/);
  });

  it("runs the transfer the other way round", async () => {
    const back = transferInstruction(approver, payer.address, DEPOSIT);
    expect(await refused(await build([back, await taskApproval()]))).toMatch(
      /not from the payer to the approver/,
    );
  });

  it("approves something other than what was asked for", async () => {
    expect(await refused(await build([pay(DEPOSIT), await taskApproval({ task: fill(8) })]))).toMatch(
      /something else/,
    );
    expect(
      await refused(
        await build([pay(DEPOSIT), await taskApproval({ hash: new Uint8Array(32).fill(0xcd) })]),
      ),
    ).toMatch(/something else/);
    // A verdict that does not pass the words is worth nothing to the payer.
    for (const status of [1, 2, 3]) {
      expect(await refused(await build([pay(DEPOSIT), await taskApproval({ status })]))).toMatch(
        /does not pass the words/,
      );
    }
  });

  it("calls a different program, or a different instruction of the marketplace's", async () => {
    const approval = await taskApproval();
    expect(
      await refused(await build([pay(DEPOSIT), { ...approval, programAddress: fill(6) }])),
    ).toMatch(/not the marketplace's/);

    const data = Uint8Array.from(approval.data!);
    data[0] = (data[0]! + 1) % 256;
    expect(await refused(await build([pay(DEPOSIT), { ...approval, data }]))).toMatch(
      /not an approval/,
    );
    expect(
      await refused(await build([pay(DEPOSIT), { ...approval, data: data.subarray(0, 40) }])),
    ).toMatch(/malformed/);
  });

  it("brings the payer, or anyone else, into the approval", async () => {
    const approval = await taskApproval();
    const accounts = [...approval.accounts!];
    const withPayer = {
      ...approval,
      accounts: [...accounts, { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payerSlot } as never],
    };
    expect(await refused(await build([pay(DEPOSIT), withPayer]))).toMatch(/something else/);

    // In the one place that is allowed to vary.
    const swapped = [...accounts];
    swapped[4] = { address: payer.address, role: AccountRole.READONLY };
    expect(await refused(await build([pay(DEPOSIT), { ...approval, accounts: swapped }]))).toMatch(
      /something else/,
    );

    const stranger = await generateKeyPairSigner();
    const third = {
      ...approval,
      accounts: [...accounts, { address: stranger.address, role: AccountRole.READONLY_SIGNER, signer: stranger } as never],
    };
    expect(await refused(await build([pay(DEPOSIT), third]))).toMatch(/wrong number of signers/);
  });

  it("is paid for, or signed, by the wrong party", async () => {
    // Somebody else as the fee payer.
    const stranger = await generateKeyPairSigner();
    expect(
      await refused(await build([pay(DEPOSIT), await taskApproval()], { feePayer: stranger })),
    ).toMatch(/wrong number of signers/);
    // The approver pays the fee and the wallet is second.
    expect(
      await refused(await build([pay(DEPOSIT), await taskApproval()], { feePayer: approver })),
    ).toMatch(/somebody else pays/);
    // An approval by an approver other than the one this wallet was told of.
    const other = await generateKeyPairSigner();
    expect(
      await refused(await build([pay(DEPOSIT, other.address), await taskApproval({ moderator: other })])),
    ).toMatch(/somebody else signs/);
    // The approver named itself as the payer.
    expect(
      await refused(await honest(), { ...EXPECTED, payer: approver.address }),
    ).toMatch(/the payer is the approver/);
  });

  it("was not signed by the approver", async () => {
    const unsigned = await build([
      pay(DEPOSIT),
      await taskApproval({ moderator: createNoopSigner(approver.address) }),
    ]);
    expect(await refused(unsigned)).toMatch(/has not signed/);
  });

  it("hides accounts in a lookup table", async () => {
    const approval = await taskApproval();
    const hidden = await build([pay(DEPOSIT), approval], {
      lookups: { [fill(9)]: [TASK, approval.accounts![0]!.address] },
    });
    expect(await refused(hidden)).toMatch(/lookup tables/);
  });

  it("is in the old format, has bytes after its end, or is not a transaction", async () => {
    expect(
      await refused(await build([pay(DEPOSIT), await taskApproval()], { version: "legacy" })),
    ).toMatch(/version 0/);

    const wire = await honest();
    const longer = new Uint8Array(wire.length + 2);
    longer.set(wire);
    longer.set([0, 0], wire.length);
    expect(await refused(longer)).toMatch(/more than was read/);

    expect(await refused(new Uint8Array())).toMatch(/size/);
    expect(await refused(new Uint8Array(1233))).toMatch(/size/);
    expect(await refused(Uint8Array.from({ length: 200 }, (_, index) => index))).toMatch(
      /does not decode|version 0|more than was read|signers/,
    );
    expect(await refused(wire.subarray(0, wire.length - 9))).toMatch(
      /does not decode|more than was read|malformed|something else|steps/,
    );
  });
});
