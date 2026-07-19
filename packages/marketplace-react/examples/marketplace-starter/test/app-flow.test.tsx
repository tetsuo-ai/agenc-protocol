import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { address, createNoopSigner, type Address, type TransactionSigner } from "@solana/kit";
import {
  findTaskPda,
  values,
  type DecodedProgramAccount,
  type MarketplaceClient,
  type ServiceListing,
} from "@tetsuo-ai/marketplace-sdk";
import type { ReadTransport } from "@tetsuo-ai/marketplace-react";
import { App } from "../src/App.js";
import type {
  HostedModeratedJobSpec,
  MarketplaceBackendAdapter,
} from "../src/backend.js";

const LISTING = address("Stake11111111111111111111111111111111111111") as Address;
const PROVIDER_AGENT = address("So11111111111111111111111111111111111111112") as Address;
const BUYER = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK") as Address;
const WORKER_AGENT = address("4xTpJ4p76bAeggXoYywpCCNKfJspbuRzZ79R7zG6BfQB") as Address;
const WORKER_AUTHORITY = address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA") as Address;
const TREASURY = address("SysvarRent111111111111111111111111111111111") as Address;
const JOB_SPEC_HASH = new Uint8Array(32).fill(7);

interface RecordedCall {
  name: string;
  order: number;
  input: unknown;
}

interface RenderedApp {
  container: HTMLElement;
  root: Root;
  cleanup: () => Promise<void>;
}

function createRecorder() {
  let order = 0;
  const calls: RecordedCall[] = [];
  return {
    calls,
    record(name: string, input: unknown = null): void {
      calls.push({ name, order: ++order, input });
    },
  };
}

function makeListingRow(): DecodedProgramAccount<ServiceListing> {
  return {
    address: LISTING,
    account: {
      providerAgent: PROVIDER_AGENT,
      authority: PROVIDER_AGENT,
      name: values.encodeListingName("Translation service"),
      category: values.encodeListingCategory("translation"),
      tags: values.encodeListingTags(["english-to-french", "docs"]),
      specHash: new Uint8Array(32).fill(3),
      specUri: "agenc://job-spec/sha256/" + "3".repeat(64),
      price: 250_000_000n,
      priceMint: { __option: "None" },
      totalHires: 42n,
      version: 3n,
      state: 0,
    } as unknown as ServiceListing,
  };
}

function makeReadTransport(): ReadTransport {
  const row = makeListingRow();
  return {
    kind: "indexer",
    listActiveListings: async () => [row],
    getListing: async () => ({
      address: row.address,
      account: row.account,
    }),
    listingHires: async () => [],
    agentTrackRecord: async () => ({
      agent: String(PROVIDER_AGENT),
      completions: 1,
      disputesInitiated: 0,
      disputesLost: 0,
      slashHistory: [],
      source: "events",
    }),
  } as ReadTransport;
}

function makeBackend(
  recorder: ReturnType<typeof createRecorder>,
  moderationAttested = true,
): MarketplaceBackendAdapter {
  return {
    async hostAndModerateJobSpec(input) {
      recorder.record("hostAndModerateJobSpec", input);
      return {
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecHashHex: values.bytesToHex(JOB_SPEC_HASH),
        jobSpecUri: `https://market.example/job-specs/${values.bytesToHex(JOB_SPEC_HASH)}.json`,
        moderationAttested,
      } satisfies HostedModeratedJobSpec;
    },
  };
}

function makeClient(
  signer: TransactionSigner,
  recorder: ReturnType<typeof createRecorder>,
): MarketplaceClient {
  function ok(name: string, input: unknown) {
    recorder.record(name, input);
    return Promise.resolve({ signature: `sig-${name}`, logs: [] });
  }
  const method = (name: string) => (input: unknown) => ok(name, input);

  return {
    signer,
    transport: {} as MarketplaceClient["transport"],
    send: (instructions: readonly unknown[]) => ok("send", { instructions }),
    registerAgent: method("registerAgent"),
    createServiceListing: method("createServiceListing"),
    hireFromListing: method("hireFromListing"),
    hireFromListingHumanless: method("hireFromListingHumanless"),
    setTaskJobSpec: method("setTaskJobSpec"),
    claimTaskWithJobSpec: method("claimTaskWithJobSpec"),
    submitTaskResult: method("submitTaskResult"),
    acceptTaskResult: method("acceptTaskResult"),
    rejectTaskResult: method("rejectTaskResult"),
    autoAcceptTaskResult: method("autoAcceptTaskResult"),
    cancelTask: method("cancelTask"),
    closeTask: method("closeTask"),
    rateHire: method("rateHire"),
    postCompletionBond: method("postCompletionBond"),
    initiateDispute: method("initiateDispute"),
    resolveDispute: method("resolveDispute"),
    expireDispute: method("expireDispute"),
    cancelDispute: method("cancelDispute"),
    applyDisputeSlash: method("applyDisputeSlash"),
    applyInitiatorSlash: method("applyInitiatorSlash"),
    resolveRejectFrozen: method("resolveRejectFrozen"),
    expireRejectFrozen: method("expireRejectFrozen"),
    assignDisputeResolver: method("assignDisputeResolver"),
    revokeDisputeResolver: method("revokeDisputeResolver"),
  } as unknown as MarketplaceClient;
}

async function renderStarter({
  backend,
  client,
  signer,
}: {
  backend: MarketplaceBackendAdapter;
  client: MarketplaceClient;
  signer: TransactionSigner;
}): Promise<RenderedApp> {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://starter.example/",
  });
  const previous = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  assert.ok(container);

  const root = createRoot(container);
  await act(async () => {
    root.render(
      <App
        backend={backend}
        initialSigner={signer}
        moderator={PROVIDER_AGENT}
        providerConfigOverrides={{
          client,
          queryTransport: makeReadTransport(),
        }}
      />,
    );
    await settleReact();
  });

  return {
    container,
    root,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
        await settleReact();
      });
      restoreDomGlobals(previous);
      dom.window.close();
    },
  };
}

function installDomGlobals(dom: JSDOM): Map<string, PropertyDescriptor | undefined> {
  const win = dom.window;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    Node: win.Node,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    InputEvent: win.InputEvent ?? win.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return previous;
}

function restoreDomGlobals(
  previous: Map<string, PropertyDescriptor | undefined>,
): void {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
}

async function clickButton(container: HTMLElement, label: string | RegExp): Promise<void> {
  const button = findButton(container, label);
  await act(async () => {
    button.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await settleReact();
  });
}

function findButton(container: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const button = buttons.find((candidate) => {
    const text = normalize(candidate.textContent);
    return typeof label === "string" ? text === label : label.test(text);
  });
  assert.ok(
    button,
    `Expected button ${String(label)}. Available buttons: ${buttons
      .map((candidate) => normalize(candidate.textContent))
      .join(", ")}`,
  );
  return button;
}

async function setInput(container: HTMLElement, labelText: string, value: string): Promise<void> {
  const labels = Array.from(container.querySelectorAll("label"));
  const label = labels.find((candidate) =>
    normalize(candidate.textContent).startsWith(labelText),
  );
  assert.ok(label, `Expected label ${labelText}`);
  const input = label.querySelector("input");
  assert.ok(input, `Expected input inside label ${labelText}`);

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setter, "HTMLInputElement value setter is unavailable");
    setter.call(input, value);
    Simulate.change(input, { target: { value } } as never);
    await settleReact();
  });
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw lastError;
}

async function settleReact(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function call(
  calls: RecordedCall[],
  name: string,
): RecordedCall {
  const found = calls.find((entry) => entry.name === name);
  assert.ok(found, `Expected recorded call ${name}`);
  return found;
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

test("starter UI drives the public humanless marketplace lifecycle with injected package seams", async () => {
  const signer = createNoopSigner(BUYER);
  const recorder = createRecorder();
  const client = makeClient(signer, recorder);
  const backend = makeBackend(recorder);
  const rendered = await renderStarter({ backend, client, signer });

  try {
    await waitFor(() => {
      assert.match(rendered.container.textContent ?? "", /Translation service/);
    });

    await clickButton(rendered.container, "Hire");
    await clickButton(rendered.container, "Hire with humanless checkout");
    await waitFor(() => {
      call(recorder.calls, "hireFromListingHumanless");
    });

    const hireInput = call(recorder.calls, "hireFromListingHumanless").input as {
      creator: TransactionSigner;
      taskId: Uint8Array;
      listing: Address;
    };
    assert.equal(hireInput.creator, signer);
    assert.equal(hireInput.listing, LISTING);
    const [expectedTaskPda] = await findTaskPda({
      creator: signer.address,
      taskId: hireInput.taskId,
    });

    await waitFor(() => {
      findButton(rendered.container, "Host, moderate, and activate");
    });
    await clickButton(rendered.container, "Host, moderate, and activate");
    await waitFor(() => {
      call(recorder.calls, "setTaskJobSpec");
    });
    const hosted = call(recorder.calls, "hostAndModerateJobSpec");
    const activation = call(recorder.calls, "setTaskJobSpec");
    assert.ok(hosted.order < activation.order);
    assert.equal(
      String((hosted.input as { taskPda: Address }).taskPda),
      String(expectedTaskPda),
    );
    assert.deepEqual(
      (activation.input as { jobSpecHash: Uint8Array }).jobSpecHash,
      JOB_SPEC_HASH,
    );
    assert.equal(
      (activation.input as { jobSpecUri: string }).jobSpecUri,
      `https://market.example/job-specs/${values.bytesToHex(JOB_SPEC_HASH)}.json`,
    );
    assert.equal(
      String((activation.input as { task: Address }).task),
      String(expectedTaskPda),
    );

    await clickButton(rendered.container, "work");
    await waitFor(() => {
      assert.match(rendered.container.textContent ?? "", /Result proof hash/);
    });
    await setInput(rendered.container, "Worker agent PDA", String(WORKER_AGENT));
    await waitFor(() => {
      assert.equal(findButton(rendered.container, "Claim").disabled, false);
    });
    await clickButton(rendered.container, "Claim");
    await waitFor(() => {
      call(recorder.calls, "claimTaskWithJobSpec");
    });
    await clickButton(rendered.container, "Submit result");
    await waitFor(() => {
      call(recorder.calls, "submitTaskResult");
    });

    await clickButton(rendered.container, "review");
    await waitFor(() => {
      assert.match(rendered.container.textContent ?? "", /Protocol treasury/);
    });
    await setInput(rendered.container, "Worker agent PDA", String(WORKER_AGENT));
    await setInput(rendered.container, "Worker wallet", String(WORKER_AUTHORITY));
    await setInput(rendered.container, "Protocol treasury", String(TREASURY));
    await clickButton(rendered.container, "Accept and release escrow");
    await waitFor(() => {
      call(recorder.calls, "acceptTaskResult");
    });
    await clickButton(rendered.container, "Rate service");
    await waitFor(() => {
      call(recorder.calls, "rateHire");
    });
    await clickButton(rendered.container, "Close capacity");
    await waitFor(() => {
      call(recorder.calls, "closeTask");
    });

    for (const name of [
      "claimTaskWithJobSpec",
      "submitTaskResult",
      "acceptTaskResult",
      "rateHire",
      "closeTask",
    ]) {
      assert.equal(
        String((call(recorder.calls, name).input as { task: Address }).task),
        String(expectedTaskPda),
      );
    }
    assert.equal(
      String((call(recorder.calls, "closeTask").input as { listing: Address }).listing),
      String(LISTING),
    );

    const lifecycleNames = recorder.calls.map((entry) => entry.name);
    assert.deepEqual(lifecycleNames, [
      "hireFromListingHumanless",
      "hostAndModerateJobSpec",
      "setTaskJobSpec",
      "claimTaskWithJobSpec",
      "submitTaskResult",
      "acceptTaskResult",
      "rateHire",
      "closeTask",
    ]);
  } finally {
    await rendered.cleanup();
  }
});

test("starter activation fails closed when the backend does not attest moderation", async () => {
  const signer = createNoopSigner(BUYER);
  const recorder = createRecorder();
  const client = makeClient(signer, recorder);
  const backend = makeBackend(recorder, false);
  const rendered = await renderStarter({ backend, client, signer });

  try {
    await waitFor(() => {
      assert.match(rendered.container.textContent ?? "", /Translation service/);
    });

    await clickButton(rendered.container, "Hire");
    await clickButton(rendered.container, "Hire with humanless checkout");
    await waitFor(() => {
      call(recorder.calls, "hireFromListingHumanless");
    });
    await waitFor(() => {
      findButton(rendered.container, "Host, moderate, and activate");
    });
    await clickButton(rendered.container, "Host, moderate, and activate");
    await waitFor(() => {
      assert.match(
        rendered.container.textContent ?? "",
        /did not attest moderation/,
      );
    });

    assert.equal(
      recorder.calls.some((entry) => entry.name === "setTaskJobSpec"),
      false,
    );
  } finally {
    await rendered.cleanup();
  }
});
