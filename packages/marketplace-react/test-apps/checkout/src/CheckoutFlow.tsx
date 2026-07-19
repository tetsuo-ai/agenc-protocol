/**
 * `<CheckoutFlow>` — the buyer half of the A3 checkout Done-when, driven ENTIRELY
 * through the public headless hooks (`useHire` + `useSubmissionReview`). It is
 * the money path that the prebuilt `<HireCheckoutModal>` wraps; this fixture
 * proves the hooks complete a REAL hire funded -> accepted against the live
 * sandbox validator, in a real browser (Playwright) and under jsdom (fallback).
 *
 * The worker half (moderate task, set job spec, claim, submit) has no React hook
 * — a real worker agent does it off the storefront — so the test harness runs it
 * in Node between the buyer's "Hire" and "Accept" clicks (see
 * test/playwright/worker-harness.mjs). This component exposes the minted task PDA
 * and a "ready to accept" gate so the harness can step in deterministically.
 *
 * State machine (each surfaced via data-testid for the test to assert on):
 *   idle -> hiring -> hired(taskPda) -> [harness: worker submits] ->
 *   accepting -> accepted(signature)
 */
import { useCallback, useState } from "react";
import { useHire, useSubmissionReview } from "@tetsuo-ai/marketplace-react/hooks";
import type { Address } from "@tetsuo-ai/marketplace-react";

/** Everything the buyer flow needs that the SDK cannot derive on its own. */
export interface CheckoutConfig {
  /** The listing to hire from. */
  listing: string;
  /** The listing's pinned spec hash (hex, 64 chars) — derives the moderation PDA. */
  listingSpecHashHex: string;
  /** Expected price (lamports) — guards against listing drift. */
  expectedPriceLamports: string;
  /** Expected listing version — guards against listing drift. */
  expectedVersion: string;
  /** Review window (seconds). */
  reviewWindowSecs: string;
  /** The worker agent PDA that will fulfil the task (for the accept settle). */
  workerAgent: string;
  /** The worker's authority wallet (receives the escrow on accept). */
  workerAuthority: string;
  /** The protocol treasury (from ProtocolConfig.treasury) — accept needs it. */
  treasury: string;
  /**
   * P1.2: the moderator whose LISTING attestation the hire gate consumes —
   * on the sandbox this is the moderation authority; in production it comes
   * from the attestation service response (or its `GET /v1/info`).
   */
  moderator: string;
}

/** Hex string -> Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Random 32-byte task id (browser/Node-safe). */
function randomId32(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export interface CheckoutFlowProps {
  config: CheckoutConfig;
  /**
   * Called with the minted task PDA right after a successful hire, so the test
   * harness can run the worker side before the buyer accepts. Must resolve once
   * the task is in PendingValidation (worker submitted).
   */
  onHired?: (taskPda: string) => Promise<void> | void;
}

export function CheckoutFlow({ config, onHired }: CheckoutFlowProps) {
  const hire = useHire();
  const [taskPda, setTaskPda] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [phase, setPhase] = useState<"idle" | "hiring" | "worker" | "hired">(
    "idle",
  );

  const review = useSubmissionReview((taskPda ?? "") as Address);

  const onHire = useCallback(async () => {
    setPhase("hiring");
    const result = await hire.hire({
      humanless: true,
      listing: config.listing as Address,
      providerAgent: config.workerAgent as Address,
      taskId: randomId32(),
      expectedPrice: BigInt(config.expectedPriceLamports),
      expectedVersion: BigInt(config.expectedVersion),
      reviewWindowSecs: BigInt(config.reviewWindowSecs),
      listingSpecHash: hexToBytes(config.listingSpecHashHex),
      moderator: config.moderator as Address,
    } as Parameters<typeof hire.hire>[0]);
    setTaskPda(String(result.taskPda));
    setPhase("worker");
    // Hand off to the harness to run the worker side -> PendingValidation.
    if (onHired) await onHired(String(result.taskPda));
    setWorkerReady(true);
    setPhase("hired");
  }, [hire, config, onHired]);

  const onAccept = useCallback(async () => {
    await review.accept({
      worker: config.workerAgent as Address,
      treasury: config.treasury as Address,
      workerAuthority: config.workerAuthority as Address,
    } as Parameters<typeof review.accept>[0]);
  }, [review, config]);

  return (
    <div data-testid="checkout-flow">
      <p data-testid="checkout-phase">{phase}</p>
      <p data-testid="hire-status">{hire.status}</p>
      {hire.error ? (
        <p data-testid="hire-error">{hire.error.message}</p>
      ) : null}

      <button data-testid="hire-button" onClick={onHire} disabled={hire.isPending || taskPda !== null}>
        Hire ({config.expectedPriceLamports} lamports)
      </button>

      {taskPda ? (
        <p data-testid="task-pda">{taskPda}</p>
      ) : null}

      <button
        data-testid="accept-button"
        onClick={onAccept}
        disabled={!workerReady || review.status === "pending"}
      >
        Accept result
      </button>
      <p data-testid="review-status">{review.status}</p>
      {review.signature ? (
        <p data-testid="accept-signature">{review.signature}</p>
      ) : null}
      {review.error ? (
        <p data-testid="review-error">{review.error.message}</p>
      ) : null}
    </div>
  );
}
