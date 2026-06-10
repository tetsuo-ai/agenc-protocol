#!/usr/bin/env node
/**
 * check-ssr.mjs — the A1 SSR Done-when proof for the Next.js fixture.
 *
 * Two assertions:
 *   1. `next build` succeeds (the App Router compiles the provider + hook +
 *      component with no build error). Run separately by the caller, OR here
 *      with --build.
 *   2. The PRODUCTION server renders the page and the SERVER HTML contains the
 *      fully-rendered component SHELL — the `<h1>`, the provider tree, and the
 *      grid element in its SSR (loading) state — with NO React error overlay
 *      and NO error boundary. This proves the provider + hook + component
 *      server-render without touching `window`/`document` and without throwing.
 *
 * Note on the "populated" grid: `useListings` is a TanStack Query hook, so its
 * data resolves on the first CLIENT tick after hydration, not during the single
 * synchronous server pass. The server therefore ships the grid's loading state
 * (this is correct — server and first client render MATCH, so there is no
 * hydration mismatch). The POPULATED grid (cards present) is asserted
 * post-hydration by the jsdom render test (test/ssr-render.test.tsx) and the
 * Playwright browser test — this HTTP check proves only the SSR-safe shell.
 *
 * Usage:
 *   node scripts/check-ssr.mjs [--build] [--port 3100]
 *     --build   run `next build` first (otherwise assumes .next exists)
 *     --port    port for `next start` (default 3100)
 */
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");

function parseArgs(argv) {
  const args = { build: false, port: 3100 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--build") args.build = true;
    else if (argv[i] === "--port") {
      args.port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: APP_DIR, stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.text();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not serve ${url} within ${timeoutMs}ms`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.build) {
    console.log("check-ssr: next build ...");
    await run("npx", ["next", "build"]);
  }

  console.log(`check-ssr: starting production server on :${args.port} ...`);
  const server = spawn("npx", ["next", "start", "-p", String(args.port)], {
    cwd: APP_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
  });

  let html;
  try {
    html = await waitForHttp(`http://127.0.0.1:${args.port}/`);
  } finally {
    server.kill("SIGTERM");
  }

  // ---- SSR shell assertions on the server HTML (real <ListingGrid> markers) ----
  const failures = [];
  if (!html.includes("<h1>AgenC marketplace listings</h1>")) {
    failures.push("server HTML missing the page <h1> (page did not SSR)");
  }
  // The REAL <ListingGrid> root carries the agenc-listing-grid class.
  if (!html.includes("agenc-listing-grid")) {
    failures.push(
      "server HTML missing the agenc-listing-grid root (provider/hook/component did not SSR)",
    );
  }
  // On the first synchronous server pass useListings has not resolved, so the
  // grid renders its loading StateMessage (agenc-state--loading). Its presence
  // proves the provider + useListings + ListingGrid ran on the server without
  // throwing.
  if (!html.includes("agenc-state--loading")) {
    failures.push(
      "server HTML grid is not in the expected SSR loading state (agenc-state--loading)",
    );
  }
  // No error state — the tree did not throw during SSR.
  if (html.includes("agenc-state--error")) {
    failures.push("server HTML rendered the grid error state (SSR threw)");
  }
  if (/application error|__next_error__/.test(html)) {
    failures.push("server HTML contains a Next.js error overlay");
  }

  // ---- MONEY surface SSR assertions (finding #6) ----
  // The MoneyModal island server-renders the actual shipped money components:
  // HireButton (CTA + closed modal) + an OPEN HireCheckoutModal. Proving the
  // funded checkout SSRs without throwing is the load-bearing addition here.
  if (!html.includes('data-agenc-money-shell="ready"')) {
    failures.push(
      "server HTML missing the money surface (HireButton/HireCheckoutModal did not SSR)",
    );
  }
  // The OPEN HireCheckoutModal renders the accessible dialog + its checkout body.
  if (!html.includes('role="dialog"')) {
    failures.push(
      "server HTML missing the open money dialog (HireCheckoutModal open did not SSR)",
    );
  }
  if (!html.includes("agenc-checkout")) {
    failures.push(
      "server HTML missing the checkout body (agenc-checkout) — money modal did not SSR",
    );
  }
  // The confirm-and-fund affordance must be present in the server HTML.
  if (!html.includes("Confirm and fund escrow")) {
    failures.push(
      "server HTML missing the 'Confirm and fund escrow' button (money modal did not SSR)",
    );
  }

  if (failures.length > 0) {
    console.error("\ncheck-ssr: FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    "\ncheck-ssr: PASS — page + provider + real <ListingGrid> + the money surface " +
      "(<HireButton> + an OPEN <HireCheckoutModal>) server-rendered (SSR-safe, no error boundary).",
  );
}

main().catch((error) => {
  console.error(`\ncheck-ssr: ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
