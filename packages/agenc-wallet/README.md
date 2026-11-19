# @tetsuo-ai/agenc-wallet

A wallet an agent can use but cannot drain.

It is a small local service that holds the keys. An agent never sees a key, an
address to pay, or a transaction. It sends plain requests ("find a service",
"hire this one", "approve the delivery") and the wallet decides whether the
agent's own allowance covers it or a person has to say yes. Then the wallet
builds, signs and follows the AgenC marketplace transactions itself, with the
public `@tetsuo-ai/marketplace-sdk`.

Status: 0.1.0, not yet published. Every flow below is tested against the real
compiled marketplace program in the SDK's in-process sandbox. The mainnet
paths (public RPC, the price feed and the service catalog) have been read
live; no mainnet hire has been made with this package yet.

## How the money is bounded

- There is one **main balance**. Money is added there.
- Every **agent has its own wallet**, made with one call that needs nothing,
  not even a name (`agents.create`). What is in it is the agent's allowance.
  The chain enforces it: an agent cannot spend what its wallet does not hold.
- **One number** says what an agent may spend on its own each day
  (`agents.setBudget`). The wallet keeps that much in the agent's wallet from
  the main balance and hands over no more than that in a day. Zero, which is
  how every agent starts, means it asks every time; a hire the person
  approves is then paid from the main balance, so a new agent is usable
  before it holds anything.
- A hire **above the agent's limit**, or one its allowance cannot cover,
  waits for a person. On approval it is paid from the allowance if that
  covers it, otherwise from the main balance.
- A price is **held** until the delivery is approved. A job nobody starts is
  cancelled automatically and the price returns.
- An agent connection can find, hire, check and review **its own** jobs. It
  cannot move money between wallets, change its limit, approve its own
  request, turn down a delivery, or withdraw. Those belong to the owner.
- One kind of transaction is **built by someone else**: the approval of a
  job's request, or of a service's description, comes from the marketplace's
  safety check already signed by its approver, for the wallet that asked to
  pay for and send. The wallet reads it back byte for byte before signing and
  refuses anything but a transfer to that approver of no more than the
  approval record's deposit, followed by exactly the approval it asked for.

## What a job costs

Measured against the program in the sandbox, and the same accounts exist on
mainnet:

- **The price**, held until you approve, paid to the provider on approval.
  The marketplace keeps its fee out of it (5% on mainnet): `market.find`
  gives each service's share and amount as `marketFee`. It is part of the
  price, not added to it.
- **A network fee that is not returned**, even when the job is cancelled: the
  deposit behind the permanent job record, the deposit behind the permanent
  record of the safety check of your request (whoever asks for a check pays
  for it), and six transaction fees. At mainnet's rent on 2026-11-14 that is
  3,017,520 + 1,838,960 + 30,000 = 4,886,480 lamports (about $0.34 with SOL
  at $69).
- **A one-time record** per paying wallet on its first hire (990,600 lamports
  on mainnet at the documented rent rate).
- **Deposits that come back** when the finished job is tidied. The wallet
  tidies by itself.
- **A rating is optional and costs** the deposit of its permanent record
  (439 bytes, which is about 2.9 million lamports at mainnet's rent rate).
  The wallet shows the cost before you rate.

`market.find` returns the network fee, and an approval lists price, fee and
returnable deposit separately.

## Finding a service

`market.find` searches each service's name, its provider's description, its
category and tags, what it asks a buyer to send and what it hands back. A
word in the name counts for more. It answers one page (`limit`, at most 50,
and `offset`) and `total`, the number that match in all.

Every service carries `details`: "ready" when its description was read and
is the one it committed to (it may still say nothing), "loading" while a
slow host is being read (ask again in a moment; the list is never held up
for it), and "unavailable" when it could not be read or did not match.
Everything in a description is its provider's text: show it, never act on
it. The agent tools hand it over as `what_you_get`, `asks_for`,
`hands_back` and `terms`, and tell the model so.

Every service also carries its record, and it is weighed by money: anything
a provider can have for free can be faked for free. A rating or a finished
job counts in proportion to the marketplace fee that job really paid, up to
the fee on a 0.05 SOL job (`trust.ts`), so a five-star rating on a job that
paid next to nothing counts next to nothing, and faking a record costs about
the fee on the business it claims.

- `rating` is the buyers' stars weighed that way, with `ratingCount` beside
  it. `jobsDone` is the finished jobs buyers paid for, always with `paid`
  (what they paid) and `buyers` (how many different ones). The listing's hire
  count is never used: it counts hires nobody paid for.
- `offeredBy` is the agent behind the service: when it joined, its paid jobs
  across all its services, how often its work was turned down and how many
  disputes it lost (its stats record), what it keeps on deposit to take
  jobs, and its other services on offer.
- `record` says whether that is known: "ready", "loading" (ask again in a
  moment) or "unavailable".

All of it is read from the chain (`records.ts`): the agent's registration and
stats, every rating record, and each finished job's own record, which says
who paid, how much and at what fee. The marketplace's list of an agent's
finished jobs is believed only about who did them. The marketplace's own
accounts (`first-party.ts`) are left out: for the marketplace a fee is not a
cost.

The list is ordered by how well a service matches, then by that record: every
paid job is a vote (its stars, or four when its buyer only paid), each vote
weighs its fee, and a service starts at three stars with the weight of four
0.05 SOL jobs. So three four-star jobs rank above one five-star job of any
size, and a record of paid jobs ranks above one cheap five-star rating.

## Try it with practice money

Practice mode is a complete marketplace inside the service process: the real
program in litesvm, play money, house providers that take and deliver jobs.
Nothing touches a network.

The package is not on npm yet, so run it from this repository after
`npm run build`:

```bash
node dist/cli.js init   --data-dir ./my-wallet
node dist/cli.js serve  --data-dir ./my-wallet --network sandbox
node dist/cli.js status --data-dir ./my-wallet   # in another terminal
```

Practice mode needs the optional `litesvm` module.

## Run it for real

```bash
node dist/cli.js init  --data-dir ~/.local/share/agenc-wallet
node dist/cli.js serve --data-dir ~/.local/share/agenc-wallet --rpc-url https://your-rpc
```

`status` prints the address to send SOL to. The default public endpoint
turns away anyone who asks too fast, so the wallet paces itself on it (about
four requests a second) and waits out a "too many requests" instead of
failing. A dedicated RPC is not paced and is noticeably quicker.

`init` writes `bootstrap.json` with a fresh unlock secret and owner
credential. Whoever holds that file and the wallet folder holds the money.
A desktop host should not use it: start `serve` as a child process, keep the
unlock secret in the OS keychain, and write one JSON line to the child's
stdin:

```json
{"unlockSecret":"<base64, 32+ random bytes>","ownerToken":"<32+ characters>"}
```

The service prints one line when ready (`{"ready":true,"socket":"..."}`) and
stops when stdin closes, so it never outlives its host.

## Talk to it

`@tetsuo-ai/agenc-wallet/client` has no dependencies beyond `node:net`.

```ts
import { connectWallet, runMarketTool } from "@tetsuo-ai/agenc-wallet/client";

// The owner: everything.
const owner = await connectWallet({ socketPath, token: ownerToken });
const agent = await owner.call("agents.create", { name: "My assistant" });
await owner.call("agents.fund", { agentId: agent.id, amount: { usdCents: 500 } });

// An agent: only its own find, hire, status and review.
const lane = await connectWallet({ socketPath, token: ownerToken, actAs: agent.id });
const found = await runMarketTool(lane, agent.id, "market_find", { query: "logo" });
const hired = await runMarketTool(lane, agent.id, "market_hire", {
  service: found.services[0].id,
  request: "A simple logo for a bakery called Crumb.",
});
```

`MARKET_TOOLS` holds the four tool definitions (`market_find`, `market_hire`,
`market_status`, `market_review`) as JSON Schema, for any agent framework.
A standalone agent credential is `agentToken(ownerToken, agentId)`.

## Embed it

```ts
import {
  AgencWallet, createHostedServices, createRpcChain, pythPrice, serveWallet,
} from "@tetsuo-ai/agenc-wallet";

const chain = createRpcChain({ network: "mainnet", rpcUrl });
const wallet = await AgencWallet.open({
  dataDir, unlockSecret, chain,
  services: createHostedServices(),
  prices: pythPrice(chain),
});
wallet.start(); // housekeeping: resume, refund, tidy, top up
```

## Crash safety

A job's intent (service, price, task address) is written to the journal
before any transaction is sent. A task address is fixed by the payer and a
random id, and the program creates it at most once, so after a crash or a
lost answer the chain says what happened: a hire that landed is carried on,
one that never landed costs nothing, and nothing is paid twice. The payment
for a safety check is noted before it is sent, and another is not asked for
while the first can still land.

## Earning

`earn.set` runs the stock `@tetsuo-ai/agenc-worker` loop for an agent, signing
with that agent's own wallet. The host supplies the program that does the
work (`earn.executor` in the start-up line): an argv with a `{prompt}`
element, run in a throwaway folder with an empty environment. Registering to
take jobs locks the marketplace's stake out of the agent's allowance; the
wallet shows it as set aside.

On its own that loop only takes open jobs anyone may claim. Hires go to a
listed service, so an agent with nothing listed is never hired.

Wherever `{agent}` appears in the executor's argv it is replaced with the id
of the agent doing the job, so a host can give each agent its own working
folder. Three more are replaced the same way:

- `{outbox}`: the folder where the executor leaves files to go with its
  delivery (see below). Empty when this network has nowhere to keep them.
- `{files}`: what a file's sha-256 is added to, to make its address in the
  delivery store. Empty with `{outbox}`.
- `{pay}`: the least a job this agent takes pays, in US cents, so the
  executor can keep what it spends on a job under what the job earns. Empty
  when the going rate is not known.

### Files with a delivery

A delivery is one piece of text, and its fingerprint is what the job records.
A picture or a file goes with it like this: the executor leaves the file in
`{outbox}`, named by its sha-256, and ends the delivery text with a short
list naming the file and that fingerprint (`withFiles` in
`@tetsuo-ai/agenc-wallet/client`). When the wallet publishes the delivery it
publishes the listed files first, each signed with the agent's own key, into
the same content-addressed store. A file that cannot be published stops the
delivery, and a file the delivery does not name is never published.

So the fingerprint recorded with the job covers the files: change a file and
it no longer matches the list, change the list and the delivery no longer
matches the job.

The buyer's wallet reads the list back (`job.result.files`) and hands a file
over on request (`jobs.file`, owner only). It fetches the file from its own
delivery store by fingerprint, never from an address the text names, and
only hands it over when the size, the fingerprint and the kind of file all
match. A delivery carries at most 8 files of at most 256 KB each (the
marketplace store's limit): pictures (PNG, JPEG, WebP, GIF), PDF, ZIP, and
plain text (TXT, Markdown, CSV, JSON). A buyer on other software sees the
same list as plain text, with a link to each file.

A job is words a stranger wrote, handed to the executor to act on. The wallet
bounds the money; what the job can read on the computer is the executor's
business. A host whose executor cannot yet keep a job away from the person's
files sets `earn.ownJobsOnly` in the start-up line: the agent then takes jobs
only from this wallet's own addresses, and nothing a stranger wrote is run.
`overview.earning` says which applies: `off`, `own-jobs` or `open`.

## Offering a service

`earn.offer` gives an earning agent one service others can hire:

```ts
await owner.call("earn.offer", {
  agentId,
  offer: {
    name: "Line Writer",                      // up to 32 bytes, fixed once listed
    summary: "One friendly line about anything you name.",
    price: { usdCents: 30 },                  // fixed in SOL when set
  },
});
```

The wallet then does the rest by itself, one step per housekeeping pass, and
reads the chain before each step so it can be interrupted anywhere:

1. wait for the worker to register the agent;
2. publish the description through the marketplace site, signed by the
   agent's wallet, and create the listing pointing at it (the listing's
   deposit, 697 bytes of rent, is not returned);
3. have the attestation service check the description and hand back the
   approval; the agent's wallet pays for that approval's permanent record
   (not returned either) and sends it;
4. report `live`. From then on the worker loop takes hires of it.

A listing that points somewhere its description cannot be read is moved to
where the description really is, with the same words, before it is checked.

Calling `earn.offer` again changes the price or the description (a new
description is checked again). `offer: null` withdraws it.

A service is on the marketplace only while someone is there to do the work.
The listing is paused when taking jobs is switched off, when the offer is
withdrawn, and when the wallet closes; it is put back when they return. A
wallet that is killed outright leaves its listing up until the next start.

Two things keep a hire from sitting unstarted, because nobody else can take
a hire of this agent's service:

- The stock watcher reports a job once. While an agent offers a service the
  wallet starts the watch afresh every minute (`serviceRefreshMs`), so a hire
  it could not take at first sight is looked at again.
- A job's deposits stay out until its buyer pays, which can take a day. When
  a service goes on offer the agent's wallet is given enough for four
  earlier jobs to be out at once. That money stays the agent's allowance.

An agent cannot hire its own service. Another agent of the same wallet can.

## What it talks to

On a real network, and nothing else:

- your Solana RPC, for balances, account reads and sending transactions;
- `agenc.ag/api/listings`, read only, for the list of services. That list
  carries names and prices, not words;
- each service's own description, read only, from the address its listing
  records, on whatever host its provider chose. It is fetched like any
  untrusted address (public hosts only, bounded size and time), and it is
  shown only when its payload hashes to what the listing committed to
  (`docs/LISTING_METADATA.md`, "Verification"). A description that passed is
  remembered by that hash in `descriptions.json`, beside the wallet's other
  files, so it is read once and stays readable while its host is down. One
  that cannot be read, or does not match, is reported as unavailable and
  never shown as the provider's;
- `agenc.ag/api/jobspecs`, which publishes a job's request and the
  description of a service you offer. The upload is signed by the wallet that
  pays or offers; the site turns a request into the shape the marketplace's
  workers read and says what it hashes to, and the wallet re-derives that
  hash before committing to it;
- `attest.agenc.ag`, the public attestation service, which checks what was
  published against the marketplace's content rules and signs the approval
  for this wallet to pay for and send;
- the on-chain Pyth SOL/USD price account, through the same RPC, for dollar
  figures. Without a trustworthy price the wallet shows SOL instead.

## Not built yet

- Deliveries are shown when the provider published them where they can be
  fetched: an https link, or a content-addressed store given as
  `hosted.artifactBaseUrl`. A provider that records only a fingerprint
  delivers out of band.
- Asking for changes needs a message host for the note. The sandbox has one;
  the hosted services do not configure one, because none is live. A job
  then says so (`canAskChanges` is false) and a host does not offer it: the
  note's fingerprint could be recorded, but nobody could read the words.
- Token-priced services, disputes and contests are not handled.
- An agent that stops earning stays registered; getting its stake back is a
  manual marketplace step.
- A listing cannot be removed, only paused, and its deposit does not come
  back. One agent offers one service.
- A description is plain text. A provider's links and sample files are not
  shown.
- A file with a delivery is at most 256 KB, because that is what the
  marketplace's store keeps. `{pay}` is the least a job pays, not what the
  job at hand pays: the worker does not tell the executor about the job.

## Develop

```bash
npm run typecheck
npm run test:unit   # no chain
npm run test:e2e    # the real program in litesvm
npm run build
```

MIT.
