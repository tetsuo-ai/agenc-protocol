import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  AgencProvider,
  ListingGrid,
  PoweredByAgenC,
  ReviewPanel,
  type AgencProviderConfig,
} from "@tetsuo-ai/marketplace-react";
import {
  useHire,
  useListings,
  useRateHire,
  useSubmissionReview,
  useTaskActivation,
  useTaskLifecycle,
  useTaskWork,
  type ListingRow,
} from "@tetsuo-ai/marketplace-react/hooks";
import {
  findClaimPda,
  findCreatorCompletionBondPda,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { useMemo, useState } from "react";
import {
  createHttpBackendAdapter,
  type HostedModeratedJobSpec,
  type MarketplaceBackendAdapter,
  type StarterJobSpec,
} from "./backend.js";
import { starterConfig } from "./config.js";
import { resolveBrowserWalletSigner } from "./wallet.js";

type Step = "browse" | "activate" | "work" | "review";

export interface AppProps {
  backend?: MarketplaceBackendAdapter;
  initialSigner?: TransactionSigner | null;
  moderator?: Address;
  providerConfigOverrides?: Partial<AgencProviderConfig>;
}

export function App({
  backend: backendOverride,
  initialSigner = null,
  moderator: moderatorOverride,
  providerConfigOverrides,
}: AppProps = {}) {
  const [signer, setSigner] = useState<TransactionSigner | null>(
    () => initialSigner,
  );
  const [walletError, setWalletError] = useState<string | null>(null);
  const backend = useMemo(
    () => backendOverride ?? createHttpBackendAdapter(starterConfig.backendUrl),
    [backendOverride],
  );
  const moderator =
    moderatorOverride ??
    (starterConfig.moderator ? address(starterConfig.moderator) : null);
  const providerConfig = useMemo<AgencProviderConfig>(
    () => ({
      network: starterConfig.network,
      ...(starterConfig.rpcUrl ? { rpcUrl: starterConfig.rpcUrl } : {}),
      ...(starterConfig.rpcSubscriptionsUrl
        ? { rpcSubscriptionsUrl: starterConfig.rpcSubscriptionsUrl }
        : {}),
      ...(starterConfig.indexerUrl
        ? { indexer: { baseUrl: starterConfig.indexerUrl } }
        : {}),
      ...(starterConfig.referrer ? { referrer: starterConfig.referrer } : {}),
      ...(signer ? { signer } : {}),
      ...(providerConfigOverrides ?? {}),
    }),
    [providerConfigOverrides, signer],
  );

  async function connectWallet() {
    setWalletError(null);
    try {
      const resolved = await resolveBrowserWalletSigner(starterConfig.network);
      if (!resolved) {
        setWalletError(
          "No wallet adapter is wired. Set window.agencWallet from your Wallet Standard integration.",
        );
        return;
      }
      setSigner(resolved);
    } catch (cause) {
      setWalletError(toError(cause).message);
    }
  }

  return (
    <AgencProvider config={providerConfig}>
      <main className="shell">
        <header className="hero">
          <div>
            <p className="eyebrow">AgenC marketplace starter</p>
            <h1>Launch an agent marketplace with the public SDK.</h1>
            <p>
              Browse listings, hire through the humanless checkout path,
              activate the task with a moderated job spec, then claim, submit,
              review, rate, and close from public React hooks.
            </p>
          </div>
          <div className="wallet">
            <button type="button" onClick={() => void connectWallet()}>
              {signer
                ? `Connected ${shortAddress(signer.address)}`
                : "Connect wallet"}
            </button>
            {walletError ? <p className="error">{walletError}</p> : null}
          </div>
        </header>
        <MarketplaceFlow
          backend={backend}
          moderator={moderator}
          signer={signer}
        />
        <footer>
          <PoweredByAgenC />
        </footer>
      </main>
    </AgencProvider>
  );
}

function MarketplaceFlow({
  backend,
  moderator,
  signer,
}: {
  backend: MarketplaceBackendAdapter;
  moderator: Address | null;
  signer: TransactionSigner | null;
}) {
  const [selected, setSelected] = useState<ListingRow | null>(null);
  const [taskPda, setTaskPda] = useState<Address | null>(null);
  const [step, setStep] = useState<Step>("browse");
  const listings = useListings(undefined, { pageSize: 12 });

  return (
    <section className="grid">
      <div className="panel wide">
        <div className="panel-heading">
          <h2>Live services</h2>
          <button type="button" onClick={listings.refetch}>
            Refresh
          </button>
        </div>
        <ListingGrid
          listings={listings.listings}
          isLoading={listings.isLoading}
          error={listings.error}
          hasMore={listings.hasMore}
          onLoadMore={listings.fetchMore}
          onRetry={listings.refetch}
          onHire={(listing) => {
            setSelected(listing as ListingRow);
            setTaskPda(null);
            setStep("browse");
          }}
        />
      </div>

      <div className="panel">
        <h2>Selected flow</h2>
        {!selected ? (
          <p>Select a service to start.</p>
        ) : (
          <HireStep
            listing={selected}
            moderator={moderator}
            signer={signer}
            onHired={(task) => {
              setTaskPda(task);
              setStep("activate");
            }}
          />
        )}
        {taskPda ? (
          <TaskControls
            taskPda={taskPda}
            listing={selected}
            signer={signer}
            backend={backend}
            moderator={moderator}
            step={step}
            setStep={setStep}
          />
        ) : null}
      </div>
    </section>
  );
}

function HireStep({
  listing,
  moderator,
  signer,
  onHired,
}: {
  listing: ListingRow;
  moderator: Address | null;
  signer: TransactionSigner | null;
  onHired: (taskPda: Address) => void;
}) {
  const hire = useHire();
  const [localError, setLocalError] = useState<Error | null>(null);

  async function runHire() {
    setLocalError(null);
    try {
      if (!signer) throw new Error("Connect a wallet before hiring.");
      if (!moderator) {
        throw new Error(
          "Set VITE_AGENC_MODERATOR to the listing attestor's wallet.",
        );
      }
      const result = await hire.hire({
        humanless: true,
        listing: listing.address,
        providerAgent: listing.account.providerAgent,
        creator: signer,
        taskId: values.randomId32(),
        expectedPrice: listing.account.price,
        expectedVersion: listing.account.version,
        listingSpecHash: listing.account.specHash,
        reviewWindowSecs: 86_400n,
        moderator,
      });
      onHired(result.taskPda);
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  return (
    <div className="stack">
      <p>
        Hiring funds escrow and creates the task. Activation must pin a
        moderated job spec before discovery and claim attempts; transaction-time
        gates still decide each claim.
      </p>
      <button
        type="button"
        disabled={!signer || hire.isPending}
        onClick={() => void runHire()}
      >
        {hire.isPending ? "Hiring..." : "Hire with humanless checkout"}
      </button>
      <StatusLine
        status={hire.status}
        error={localError ?? hire.error}
        signature={hire.signature}
      />
    </div>
  );
}

function TaskControls({
  taskPda,
  listing,
  signer,
  backend,
  moderator,
  step,
  setStep,
}: {
  taskPda: Address;
  listing: ListingRow | null;
  signer: TransactionSigner | null;
  backend: MarketplaceBackendAdapter;
  moderator: Address | null;
  step: Step;
  setStep: (step: Step) => void;
}) {
  const [hostedJobSpec, setHostedJobSpec] =
    useState<HostedModeratedJobSpec | null>(null);

  return (
    <div className="stack">
      <nav className="tabs" aria-label="Task workflow">
        {(["activate", "work", "review"] as const).map((next) => (
          <button
            key={next}
            type="button"
            className={step === next ? "active" : undefined}
            onClick={() => setStep(next)}
          >
            {next}
          </button>
        ))}
      </nav>
      {step === "activate" ? (
        <ActivationStep
          taskPda={taskPda}
          backend={backend}
          moderator={moderator}
          hosted={hostedJobSpec}
          onHosted={setHostedJobSpec}
        />
      ) : null}
      {step === "work" ? (
        <WorkerStep
          taskPda={taskPda}
          signer={signer}
          jobSpecHash={hostedJobSpec?.jobSpecHash ?? null}
        />
      ) : null}
      {step === "review" && listing ? (
        <ReviewStep taskPda={taskPda} listing={listing} signer={signer} />
      ) : null}
    </div>
  );
}

function ActivationStep({
  taskPda,
  backend,
  moderator,
  hosted,
  onHosted,
}: {
  taskPda: Address;
  backend: MarketplaceBackendAdapter;
  moderator: Address | null;
  hosted: HostedModeratedJobSpec | null;
  onHosted: (jobSpec: HostedModeratedJobSpec) => void;
}) {
  const activation = useTaskActivation(taskPda);
  const lifecycle = useTaskLifecycle(taskPda);
  const [localError, setLocalError] = useState<Error | null>(null);
  const [spec, setSpec] = useState<StarterJobSpec>({
    title: "Complete the hired service",
    deliverables: ["A result artifact URI"],
    acceptanceCriteria: ["The result matches the listing scope"],
  });

  async function hostAndActivate() {
    setLocalError(null);
    try {
      const next = await backend.hostAndModerateJobSpec({ taskPda, spec });
      if (!next.moderationAttested) {
        throw new Error(
          "Backend hosted the spec but did not attest moderation.",
        );
      }
      if (!moderator) {
        throw new Error(
          "Set VITE_AGENC_MODERATOR to the task attestor's wallet.",
        );
      }
      await activation.activate({
        jobSpecHash: next.jobSpecHash,
        jobSpecUri: next.jobSpecUri,
        moderator,
      });
      onHosted(next);
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  async function cancel() {
    setLocalError(null);
    try {
      await lifecycle.cancel();
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  return (
    <div className="stack">
      <label>
        Job spec title
        <input
          value={spec.title}
          onChange={(event) => setSpec({ ...spec, title: event.target.value })}
        />
      </label>
      <button
        type="button"
        disabled={activation.isPending}
        onClick={() => void hostAndActivate()}
      >
        {activation.isPending
          ? "Activating..."
          : "Host, moderate, and activate"}
      </button>
      <button
        type="button"
        disabled={lifecycle.isPending}
        onClick={() => void cancel()}
      >
        Cancel and refund before claim
      </button>
      {hosted ? <p>Pinned job spec: {hosted.jobSpecHashHex}</p> : null}
      <StatusLine
        status={activation.status}
        error={localError ?? activation.error ?? lifecycle.error}
        signature={activation.signature ?? lifecycle.signature}
      />
    </div>
  );
}

function WorkerStep({
  taskPda,
  signer,
  jobSpecHash,
}: {
  taskPda: Address;
  signer: TransactionSigner | null;
  jobSpecHash: Uint8Array | null;
}) {
  const work = useTaskWork(taskPda);
  const [workerAgent, setWorkerAgent] = useState("");
  const [proofHashHex, setProofHashHex] = useState("11".repeat(32));
  const [localError, setLocalError] = useState<Error | null>(null);

  async function claim() {
    setLocalError(null);
    try {
      if (!signer)
        throw new Error("Connect the worker wallet before claiming.");
      if (!jobSpecHash)
        throw new Error("Activate and pin the job spec before claiming.");
      await work.claim({
        worker: address(workerAgent),
        authority: signer,
        jobSpecHash,
      });
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  async function submit() {
    setLocalError(null);
    try {
      if (!signer)
        throw new Error("Connect the worker wallet before submitting.");
      await work.submit({
        worker: address(workerAgent),
        authority: signer,
        proofHash: values.hexToBytes(proofHashHex),
        resultData: null,
      });
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  return (
    <div className="stack">
      <label>
        Worker agent PDA
        <input
          value={workerAgent}
          onChange={(event) => setWorkerAgent(event.target.value)}
        />
      </label>
      <label>
        Result proof hash
        <input
          value={proofHashHex}
          onChange={(event) => setProofHashHex(event.target.value)}
        />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={!signer || !workerAgent || !jobSpecHash}
          onClick={() => void claim()}
        >
          Claim
        </button>
        <button
          type="button"
          disabled={!signer || !workerAgent}
          onClick={() => void submit()}
        >
          Submit result
        </button>
      </div>
      <StatusLine
        status={work.status}
        error={localError ?? work.error}
        signature={work.signature}
      />
    </div>
  );
}

function ReviewStep({
  taskPda,
  listing,
  signer,
}: {
  taskPda: Address;
  listing: ListingRow;
  signer: TransactionSigner | null;
}) {
  const review = useSubmissionReview(taskPda);
  const lifecycle = useTaskLifecycle(taskPda);
  const rating = useRateHire(taskPda);
  const [workerAgent, setWorkerAgent] = useState("");
  const [workerAuthority, setWorkerAuthority] = useState("");
  const [treasury, setTreasury] = useState("");
  const [localError, setLocalError] = useState<Error | null>(null);

  async function accept() {
    setLocalError(null);
    try {
      if (!signer)
        throw new Error("Connect the buyer wallet before accepting.");
      await review.accept({
        worker: address(workerAgent),
        workerAuthority: address(workerAuthority),
        treasury: address(treasury),
        creator: signer,
      });
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  async function reject() {
    setLocalError(null);
    try {
      if (!signer)
        throw new Error("Connect the buyer wallet before rejecting.");
      const worker = address(workerAgent);
      const [claim] = await findClaimPda({
        task: taskPda,
        bidder: worker,
      });
      await review.reject({
        worker,
        workerAuthority: address(workerAuthority),
        claim,
        rejectionHash: await values.descriptionHash("Needs revision"),
        creator: signer,
      });
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  async function close() {
    setLocalError(null);
    try {
      if (!signer) throw new Error("Connect the buyer wallet before closing.");
      const [creatorCompletionBond] = await findCreatorCompletionBondPda({
        task: taskPda,
        creator: signer.address,
      });
      await lifecycle.close({
        listing: listing.address,
        creatorCompletionBond,
        authority: signer,
      });
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  async function rate() {
    setLocalError(null);
    try {
      await rating.rate({
        listing: listing.address,
        score: 5,
        reviewHash: null,
        reviewUri: "",
      });
    } catch (cause) {
      setLocalError(toError(cause));
    }
  }

  return (
    <div className="stack">
      <ReviewPanel
        hasSubmission
        status={review.status}
        error={localError ?? review.error}
        onAccept={() => void accept()}
        onReject={() => void reject()}
      />
      <label>
        Worker agent PDA
        <input
          value={workerAgent}
          onChange={(event) => setWorkerAgent(event.target.value)}
        />
      </label>
      <label>
        Worker wallet
        <input
          value={workerAuthority}
          onChange={(event) => setWorkerAuthority(event.target.value)}
        />
      </label>
      <label>
        Protocol treasury
        <input
          value={treasury}
          onChange={(event) => setTreasury(event.target.value)}
        />
      </label>
      <div className="row">
        <button type="button" disabled={!signer} onClick={() => void close()}>
          Close capacity
        </button>
        <button type="button" disabled={!signer} onClick={() => void rate()}>
          Rate service
        </button>
      </div>
      <StatusLine
        status={review.status}
        error={localError ?? review.error ?? lifecycle.error ?? rating.error}
        signature={review.signature ?? lifecycle.signature ?? rating.signature}
      />
    </div>
  );
}

function StatusLine({
  status,
  error,
  signature,
}: {
  status: string;
  error: Error | null;
  signature: string | null;
}) {
  if (error) return <p className="error">{error.message}</p>;
  if (signature)
    return <p className="success">Confirmed: {shortAddress(signature)}</p>;
  return <p className="muted">Status: {status}</p>;
}

function shortAddress(value: string): string {
  return value.length > 12
    ? `${value.slice(0, 6)}...${value.slice(-6)}`
    : value;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
