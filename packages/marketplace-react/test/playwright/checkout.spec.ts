/**
 * A3 checkout browser e2e (the primary Done-when): the `<CheckoutFlow>` fixture,
 * served as a real SPA and driven in Chromium by Playwright, completes a REAL
 * hire funded -> accepted against the sandbox-up validator. On-chain settlement
 * is asserted from the test process (Task reaches Completed + the worker is
 * paid).
 *
 * The browser does the BUYER half (hire + accept through the headless hooks).
 * The WORKER half (moderate task, set job spec, claim, submit) has no React hook
 * and runs here in Node via the worker harness, signed with the SAME buyer key
 * the browser adopted (global-setup minted it and handed both sides the secret).
 *
 * Bridge: the page publishes `window.__checkout.taskPda` after the hire and
 * blocks on `window.__checkout.workerReady`; this spec runs the worker side,
 * flips that flag, then clicks Accept.
 */
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kit from "@solana/kit";
import {
  getTaskDecoder,
  TaskStatus,
  type Task,
} from "@tetsuo-ai/marketplace-sdk";
import { completeWorkerSide } from "./worker-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = path.join(HERE, ".playwright-sandbox.json");

interface Ctx {
  rpcUrl: string;
  listing: string;
  workerAgent: string;
  seederKeyPath: string;
  moderatorKeyPath: string;
  buyerSecretKeyHex: string;
  workerAuthority: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function decodeTask(
  rpc: ReturnType<typeof kit.createSolanaRpc>,
  pda: string,
): Promise<Task | null> {
  const info = await rpc
    .getAccountInfo(kit.address(pda), { encoding: "base64" })
    .send();
  if (!info.value) return null;
  return getTaskDecoder().decode(
    Uint8Array.from(Buffer.from(info.value.data[0], "base64")),
  ) as Task;
}

test("checkout completes a real hire funded -> accepted in the browser", async ({
  page,
}) => {
  const ctx = JSON.parse(await readFile(CONTEXT_FILE, "utf8")) as Ctx;
  const rpc = kit.createSolanaRpc(ctx.rpcUrl);
  const buyer = await kit.createKeyPairSignerFromBytes(
    hexToBytes(ctx.buyerSecretKeyHex),
  );

  // Surface page errors to make failures legible.
  page.on("pageerror", (e) =>
    console.error("PAGE ERROR:", e.stack ?? e.message),
  );

  await page.goto("/");

  // The fixture boots the buyer wallet from sandbox-config.json.
  await expect(page.getByTestId("checkout-flow")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("buyer-address")).toHaveText(
    String(buyer.address),
    { timeout: 30_000 },
  );

  // ---- BUYER: click Hire ----
  await page.getByTestId("hire-button").click();

  // Phase advances to "worker": the hire landed and the page published taskPda.
  await expect(page.getByTestId("checkout-phase")).toHaveText("worker", {
    timeout: 60_000,
  });
  const taskPda = await page.getByTestId("task-pda").textContent();
  expect(taskPda).toBeTruthy();
  expect(taskPda!.length).toBeGreaterThan(30);

  // The task is Open right after the hire.
  await expect
    .poll(async () => (await decodeTask(rpc, taskPda!))?.status, {
      timeout: 30_000,
    })
    .toBe(TaskStatus.Open);

  // ---- WORKER side (Node): moderate -> job spec -> claim -> submit ----
  await completeWorkerSide({
    kit,
    rpcUrl: ctx.rpcUrl,
    taskPda: taskPda!,
    workerAgentPda: ctx.workerAgent,
    seederKeyPath: ctx.seederKeyPath,
    moderatorKeyPath: ctx.moderatorKeyPath,
    buyerSigner: buyer,
  });

  // The task is now PendingValidation; tell the page the worker is ready.
  await expect
    .poll(async () => (await decodeTask(rpc, taskPda!))?.status, {
      timeout: 30_000,
    })
    .toBe(TaskStatus.PendingValidation);
  await page.evaluate(() => {
    if (window.__checkout) window.__checkout.workerReady = true;
  });

  // The page unblocks onHired and enables the Accept button.
  await expect(page.getByTestId("checkout-phase")).toHaveText("hired", {
    timeout: 30_000,
  });

  const workerBalBefore = (
    await rpc.getBalance(kit.address(ctx.workerAuthority)).send()
  ).value;

  // ---- BUYER: click Accept ----
  await page.getByTestId("accept-button").click();
  await expect(page.getByTestId("review-status")).toHaveText("success", {
    timeout: 30_000,
  });
  const acceptSig = await page.getByTestId("accept-signature").textContent();
  expect(acceptSig!.length).toBeGreaterThan(30);

  // ---- REAL on-chain assertions: Completed + worker paid ----
  await expect
    .poll(async () => (await decodeTask(rpc, taskPda!))?.status, {
      timeout: 30_000,
    })
    .toBe(TaskStatus.Completed);
  const workerBalAfter = (
    await rpc.getBalance(kit.address(ctx.workerAuthority)).send()
  ).value;
  expect(BigInt(workerBalAfter)).toBeGreaterThan(BigInt(workerBalBefore));
});
