// Read-only RPC monitor. It has no signer, key-file argument, or broadcast path.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  accountView,
  AlertOutbox,
  atomicJson,
  Connection,
  discoveryFilters,
  fixedAccounts,
  hash,
  ObservationTracker,
  PublicKey,
  validateSettings,
} from "./watchdog-core.mjs";

export async function captureBaseline(connection, input) {
  const settings = validateSettings(input);
  if ((await connection.getGenesisHash()) !== settings.genesisHash)
    throw new Error("RPC genesis mismatch");
  const fixed = fixedAccounts(settings);
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(
    fixed.map(({ address }) => new PublicKey(address)),
    "confirmed",
  );
  const accounts = fixed.map(({ kind, address }, index) => ({
    kind,
    address,
    slot: context.slot,
    view: accountView(kind, value[index], settings),
  }));
  for (const account of accounts)
    if (account.view.missing) throw new Error(`missing ${account.kind}`);
  if (
    accounts[0].view.programDataAddress !== accounts[1].address ||
    accounts[1].view.upgradeAuthority !== settings.expectedUpgradeAuthority
  )
    throw new Error("program/upgrade authority differs from reviewed settings");
  for (const query of discoveryFilters(settings)) {
    const found = await connection.getProgramAccounts(query.program, {
      commitment: "confirmed",
      withContext: true,
      filters: query.filters,
      minContextSlot: context.slot,
    });
    for (const { pubkey, account } of found.value)
      accounts.push({
        kind: query.kind,
        address: pubkey.toBase58(),
        slot: found.context.slot,
        view: accountView(query.kind, account, settings),
      });
  }
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    settings,
    accounts,
  };
}

export function validateBaseline(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.accounts))
    throw new Error("invalid baseline");
  validateSettings(value.settings);
  if (
    new Set(value.accounts.map((a) => a.address)).size !== value.accounts.length
  )
    throw new Error("duplicate baseline account");
  for (const { kind, address } of fixedAccounts(value.settings)) {
    const pinned = value.accounts.find(
      (a) => a.address === address && a.kind === kind,
    );
    if (
      !pinned ||
      pinned.view.missing ||
      pinned.view.invalid ||
      !/^[a-f0-9]{64}$/.test(pinned.view.dataSha256)
    )
      throw new Error(`baseline must pin valid ${kind}`);
  }
  for (const entry of value.accounts) {
    new PublicKey(entry.address);
    if (!Number.isSafeInteger(entry.slot) || entry.slot < 0)
      throw new Error("invalid baseline slot");
  }
  const fixed = fixedAccounts(value.settings);
  const program = value.accounts.find((entry) => entry.kind === "program");
  const programData = value.accounts.find(
    (entry) => entry.kind === "program-data",
  );
  if (
    program.view.programDataAddress !== fixed[1].address ||
    programData.view.upgradeAuthority !==
      value.settings.expectedUpgradeAuthority
  )
    throw new Error(
      "baseline program linkage/authority contradicts reviewed settings",
    );
  return value;
}

export async function watch({
  connection,
  baseline,
  stateDirectory,
  outbox,
  signal,
  pollingOnly = false,
}) {
  validateBaseline(baseline);
  const settings = baseline.settings;
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const baselineSha256 = hash(JSON.stringify(baseline));
  const emit = (event) =>
    outbox.enqueue({
      network: settings.genesisHash,
      programId: settings.programId,
      baselineSha256,
      ...event,
    });
  // Fail startup on a wrong endpoint; never monitor a different cluster silently.
  if ((await connection.getGenesisHash()) !== settings.genesisHash) {
    emit({ type: "rpc-genesis-mismatch" });
    await outbox.deliver();
    throw new Error("RPC genesis mismatch");
  }
  const tracker = new ObservationTracker(baseline, emit);
  const removers = [];
  let fatal = null;
  let lastPollAt = 0,
    lastDiscoveryAt = 0,
    lastWsAt = Date.now();
  let lastAdvancingSlotAt = Date.now(),
    highestSlot = 0;
  let failureState = "starting";
  const observe = (kind, address, account, slot, source) => {
    try {
      tracker.observe(kind, address, account, slot, source);
    } catch (error) {
      fatal = error;
    }
  };
  const subscribed = new Set();
  function subscribeAccount(kind, address) {
    if (pollingOnly || subscribed.has(address)) return;
    subscribed.add(address);
    const id = connection.onAccountChange(
      new PublicKey(address),
      (account, context) => {
        lastWsAt = Date.now();
        observe(
          kind,
          address,
          account.lamports === 0 && account.data.length === 0 ? null : account,
          context.slot,
          "websocket",
        );
      },
      "confirmed",
    );
    removers.push(() => connection.removeAccountChangeListener(id));
  }
  for (const entry of baseline.accounts)
    subscribeAccount(entry.kind, entry.address);
  if (!pollingOnly) {
    const slotId = connection.onSlotChange(() => {
      lastWsAt = Date.now();
    });
    removers.push(() => connection.removeSlotChangeListener(slotId));
    for (const query of discoveryFilters(settings)) {
      const id = connection.onProgramAccountChange(
        query.program,
        ({ accountId, accountInfo }, context) => {
          lastWsAt = Date.now();
          const address = accountId.toBase58();
          observe(query.kind, address, accountInfo, context.slot, "websocket");
          subscribeAccount(query.kind, address);
        },
        { commitment: "confirmed", filters: query.filters },
      );
      removers.push(() => connection.removeProgramAccountChangeListener(id));
    }
  }
  let nextPoll = 0,
    nextDiscovery = 0;
  let pollError = null;
  const deliveryController = new AbortController();
  const deliverySignal = AbortSignal.any([signal, deliveryController.signal]);
  const delivery = (async () => {
    // A slow pager must not block polling, subscriptions or health updates.
    while (!deliverySignal.aborted) {
      await outbox.deliver({ signal: deliverySignal });
      await delay(200, undefined, { signal: deliverySignal }).catch((error) => {
        if (error.name !== "AbortError") throw error;
      });
    }
  })().catch((error) => {
    fatal = error;
  });
  try {
    while (!signal.aborted) {
      if (fatal) throw fatal;
      const now = Date.now();
      if (now >= nextPoll) {
        nextPoll = now + settings.pollIntervalMs;
        try {
          if ((await connection.getGenesisHash()) !== settings.genesisHash)
            throw new Error("GenesisMismatch");
          const entries = [...tracker.latest.values()];
          for (let index = 0; index < entries.length; index += 100) {
            const batch = entries.slice(index, index + 100);
            const response = await connection.getMultipleAccountsInfoAndContext(
              batch.map((e) => new PublicKey(e.address)),
              { commitment: "confirmed" },
            );
            if (response.context.slot > highestSlot) {
              highestSlot = response.context.slot;
              lastAdvancingSlotAt = Date.now();
            }
            batch.forEach((entry, i) =>
              observe(
                entry.kind,
                entry.address,
                response.value[i],
                response.context.slot,
                "poll",
              ),
            );
          }
          lastPollAt = Date.now();
          if (now >= nextDiscovery) {
            nextDiscovery = now + settings.discoveryIntervalMs;
            for (const query of discoveryFilters(settings)) {
              const found = await connection.getProgramAccounts(query.program, {
                commitment: "confirmed",
                withContext: true,
                filters: query.filters,
              });
              for (const { pubkey, account } of found.value) {
                const address = pubkey.toBase58();
                observe(
                  query.kind,
                  address,
                  account,
                  found.context.slot,
                  "poll",
                );
                subscribeAccount(query.kind, address);
              }
            }
            lastDiscoveryAt = Date.now();
          }
          pollError = null;
        } catch (failure) {
          pollError = failure?.name ?? "RpcError";
        }
      }
      if (fatal) throw fatal;
      const checkedAt = Date.now();
      const degraded =
        pollError ??
        (outbox.lastDeliveryError
          ? "pager-delivery-failed"
          : checkedAt - lastPollAt > settings.staleAfterMs
            ? "rpc-poll-stale"
            : checkedAt - lastDiscoveryAt >
                settings.discoveryIntervalMs + settings.staleAfterMs
              ? "discovery-stale"
              : checkedAt - lastAdvancingSlotAt > settings.staleAfterMs
                ? "rpc-slot-stale"
                : !pollingOnly && checkedAt - lastWsAt > settings.staleAfterMs
                  ? "subscription-stale"
                  : null);
      const state = degraded ?? "healthy";
      if (state !== failureState) {
        emit({
          type: state === "healthy" ? "monitor-healthy" : "monitor-degraded",
          reason: state,
          // A new occurrence must not deduplicate an earlier recovered outage.
          occurredAt: new Date().toISOString(),
        });
        failureState = state;
      }
      atomicJson(join(stateDirectory, "health.json"), {
        schemaVersion: 1,
        checkedAt: new Date().toISOString(),
        state,
        pollingOnly,
        highestSlot,
        lastPollAt,
        lastDiscoveryAt,
        lastWsAt,
        pendingAlerts: outbox.pending().length,
        baselineSha256,
      });
      await delay(200, undefined, { signal }).catch((e) => {
        if (e.name !== "AbortError") throw e;
      });
    }
  } finally {
    deliveryController.abort();
    await Promise.allSettled(removers.map((remove) => remove()));
    // The outbox remains on disk on shutdown; never wait for a remote pager.
    await delivery;
    atomicJson(join(stateDirectory, "health.json"), {
      state: "stopped",
      checkedAt: new Date().toISOString(),
      baselineSha256,
    });
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      ![
        "--settings",
        "--out",
        "--baseline",
        "--state-dir",
        "--polling-only",
      ].includes(argv[i]) ||
      !argv[i + 1]
    )
      throw new Error(
        "usage: upgrade-watchdog.mjs capture --settings FILE --out FILE | watch --baseline FILE --state-dir DIR [--polling-only true]",
      );
    if (Object.hasOwn(options, argv[i])) throw new Error("duplicate option");
    options[argv[i]] = argv[i + 1];
  }
  const endpoint = process.env.AGENC_WATCHDOG_RPC_URL;
  if (!endpoint) throw new Error("AGENC_WATCHDOG_RPC_URL is required");
  const connection = new Connection(endpoint, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
  });
  if (command === "capture" && options["--settings"] && options["--out"]) {
    const baseline = await captureBaseline(
      connection,
      JSON.parse(readFileSync(options["--settings"], "utf8")),
    );
    writeFileSync(options["--out"], JSON.stringify(baseline, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      `Candidate baseline captured; review it before installation. SHA-256 ${hash(JSON.stringify(baseline))}`,
    );
    return;
  }
  if (command !== "watch" || !options["--baseline"] || !options["--state-dir"])
    throw new Error("watch requires --baseline and --state-dir");
  if (
    options["--polling-only"] !== undefined &&
    options["--polling-only"] !== "true"
  )
    throw new Error("--polling-only accepts only true");
  const stateDirectory = resolve(options["--state-dir"]);
  const outbox = new AlertOutbox(
    join(stateDirectory, "outbox"),
    process.env.AGENC_WATCHDOG_WEBHOOK_URL,
    process.env.AGENC_WATCHDOG_WEBHOOK_TOKEN,
  );
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await watch({
    connection,
    baseline: JSON.parse(readFileSync(options["--baseline"], "utf8")),
    stateDirectory,
    outbox,
    signal: controller.signal,
    pollingOnly: options["--polling-only"] === "true",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      `Upgrade watchdog stopped: ${error.name}. Check baseline, RPC, and local health/outbox files.`,
    );
    process.exitCode = 1;
  });
