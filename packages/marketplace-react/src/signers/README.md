# Signer adapters — browser wallet → kit `TransactionSigner`

`@tetsuo-ai/marketplace-react/signers` (also re-exported from the package root)
turns a browser wallet into the kit `TransactionSigner` the SDK's
`createMarketplaceClient` consumes. Pass the result as `<AgencProvider config={{
signer }}>`.

> **Why a PARTIAL signer, not a sending signer.** The SDK client signs with
> `signTransactionMessageWithSigners(...)` and submits through its **own**
> transport. `signTransactionMessageWithSigners` deliberately **ignores**
> `TransactionSendingSigner`s. So every adapter here produces a
> `TransactionPartialSigner` — it returns signatures; the SDK client broadcasts.
> If you instead let the wallet send (the
> `useWalletAccountTransactionSendingSigner` "modern path"), you bypass the SDK
> client's retry/confirm/AgencError pipeline — not what the provider wires.

## 1. Wallet Standard (recommended) — `signerFromWalletAccount`

Every modern Solana wallet registers as a Wallet Standard wallet. With
`@solana/react` you hold a `UiWalletAccount`; bridge it directly:

```tsx
import { useWalletAccountTransactionSigner } from "@solana/react";
import { signerFromWalletAccount } from "@tetsuo-ai/marketplace-react/signers";

// Option A — you have the UiWalletAccount and want the package to resolve the
// wallet's solana:signTransaction feature:
const signer = signerFromWalletAccount(account, { chain: "solana:devnet" });

// Option B — you already resolved the feature (e.g. from a hook) and want to
// inject it explicitly:
const signer = signerFromWalletAccount(account, {
  chain: "solana:devnet",
  signTransaction: account.features["solana:signTransaction"].signTransaction,
});

// -> <AgencProvider config={{ signer, rpcUrl }}>
```

`signerFromWalletAccount` sends one variadic `solana:signTransaction` request,
requires one ordered response per input, and recovers **this** account's
signature only after checking that the returned message is byte-identical and
the signature verifies over it. A wallet that rewrites a transaction is
rejected because the SDK submits the original message.

Pass `network` or `chain` explicitly when an account supports more than one
Solana chain. The returned signer carries that chain identity, and
`AgencProvider` rejects a mismatch with its configured network.

`useWalletSigner()` normalizes an application's connection state after it has
resolved one of these signers; the application still owns wallet selection and
connect/disconnect lifecycle.

## 2. Legacy `@solana/wallet-adapter` — `signerFromWalletAdapter`

For apps still holding a raw wallet-adapter `WalletContextState`. **No hard
dependency** on `@solana/wallet-adapter-*` or `@solana/web3.js`: inject the
web3.js `VersionedTransaction` class (the one piece the shim can't reconstruct).
A kit transaction and a web3.js `VersionedTransaction` share the same wire
format, so the bridge is a serialize → adapter-sign → deserialize round-trip.

```tsx
import { VersionedTransaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { signerFromWalletAdapter } from "@tetsuo-ai/marketplace-react/signers";

const wallet = useWallet();
const signer = signerFromWalletAdapter(wallet, { VersionedTransaction });
```

**Prefer migrating to §1**: a wallet-adapter wallet is also a Wallet Standard
wallet, so reading the selected account through `@solana/react` and using
`signerFromWalletAccount` is the more robust long-term path. This shim is a
bridge, not the destination.

## 3. Walletless / embedded wallets — `signerFromEmbeddedWallet`

The "no wallet, no SOL" buyer path (Privy / Dynamic / Web3Auth email/social
login + custodial keys). The marketplace layer only ever sees the vendor-neutral
`EmbeddedWalletProvider` interface, so templates/widget toggle the vendor by
config without an API break:

```ts
interface EmbeddedWalletProvider {
  connect(): Promise<EmbeddedWalletConnection>; // vendor login (browser gesture)
  isConnected(): boolean;
  getConnection(): EmbeddedWalletConnection | null;
  disconnect?(): Promise<void>;
}
interface EmbeddedWalletConnection {
  readonly address: string;
  signTransactions(txs: readonly Transaction[]): Promise<readonly SignatureBytes[]>;
}
```

```ts
import {
  signerFromEmbeddedWallet,
} from "@tetsuo-ai/marketplace-react/signers";

const connection = await provider.connect(); // email login provisions the wallet
const signer = signerFromEmbeddedWallet(connection);
// -> <AgencProvider config={{ signer, rpcUrl }}>
```

### The MOCK vendor (testing) — `createMockEmbeddedWallet`

> **The real vendor adapter is `[HUMAN]`-gated** (Solana tx-signing support,
> email/social login, custody model, pricing, SDK weight — PLAN_2 D-1). It must
> NOT live in this package. Only the interface above is depended on.

A working local-keypair `EmbeddedWalletProvider` so the walletless Done-when
runs against localnet **without** committing to a vendor. It holds a private key
in-process, so it is published ONLY behind the dedicated `./testing` subpath
(never the package root or `./signers`) and warns once if invoked under
`NODE_ENV=production`:

```ts
import { signerFromEmbeddedWallet } from "@tetsuo-ai/marketplace-react/signers";
// The MOCK is TEST-ONLY — import it from the ./testing subpath.
import { createMockEmbeddedWallet } from "@tetsuo-ai/marketplace-react/testing";

const provider = createMockEmbeddedWallet();
const conn = await provider.connect();              // "email login"
svm.airdrop(address(conn.address), lamports(1_000_000_000n)); // fund it
const signer = signerFromEmbeddedWallet(conn);      // drive a real hire
```

See `test/signers/embedded-wallet.e2e.test.ts` for the full
provision → airdrop → hire → settle proof through `startLocalMarketplace()`.

## SSR-safety

Nothing here touches `window`/`document` at module scope. The only browser-bound
step is `provider.connect()` (a user gesture), which is the vendor's concern.
All factory functions are import-safe under Next.js App Router.
