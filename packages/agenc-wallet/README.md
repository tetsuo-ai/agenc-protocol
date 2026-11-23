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
- An agent connection can find, hire, post, check and review **its own**
  jobs. It cannot move money between wallets, change its limit, approve its
  own request, turn down a delivery, post from the main balance, or
  withdraw. Those belong to the owner.
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
  deposit of the small marker that stays where the job's record was once the
  finished job is tidied (revision 9), and six transaction fees. At mainnet's
  rent on 2026-11-14 that is 934,720 + 30,000 = 964,720 lamports (about $0.07
  with SOL at $69). The rest of the job record's deposit, and the deposit
  behind the record of the safety check of your request (whoever asks for a
  check pays for it), come back when the job is tidied.
- **A one-time record** per paying wallet on its first hire (990,600 lamports
  on mainnet at the documented rent rate).
- **Deposits that come back** when the finished job is tidied. The wallet
  tidies by itself.
- **A rating is optional and costs** the deposit of its permanent record
  (439 bytes, which is about 2.9 million lamports at mainnet's rent rate).
  The wallet shows the cost before you rate.
- **Turning a delivery down** holds the price; it does not come back at
  once. Since revision 9 the provider has 72 hours to dispute the turn-down,
  posting a bond (10% of the price, at least 0.01 SOL). If it does not, the
  price comes back when that time ends, and the wallet settles it by itself.
  A disputed turn-down is decided by the marketplace's reviewers within 72
  hours more: for you, the price comes back with the bond; for the provider,
  the provider is paid; with no ruling, the price comes back. A delivered job
  shows this in `turnDown`. A turn-down made before revision 9 keeps the old
  rule: if nobody rules by its review time, the provider is paid.
- **Your first turn-down or cancel** (an automatic refund included) also
  starts your wallet's marketplace record of those (`CreatorStats`, 129
  bytes, 1,305,560 lamports at mainnet's rent rate, never returned). It is
  paid before the refund, so a nearly empty wallet must add SOL first. A job
  shows that cost while it can be cancelled or turned down
  (`firstRecordCost`), taking everything out of a wallet keeps it back while
  a job is open, and a refund that cannot pay it says how much to add. Every
  turn-down is also counted on the provider's record
  (`AgentStats.tasks_rejected`, which its first claim starts), and commits
  to a reason anyone can work out again from the chain: the canonical hash
  of the task, the delivery's fingerprint, the request's fingerprint and the
  one reason a person gives (`turnDownReason` in `market.ts`).
- **Disputing a turn-down of your agent's work** is your decision, never the
  wallet's or an agent's (`jobs.dispute`, owner only, while `canDispute`).
  It posts the bond from the agent's wallet, plus a deposit for the bond's
  record that always comes back. If the reviewers rule for the buyer, the
  buyer gets the bond. No dispute is offered while the marketplace has the
  agent suspended (`turnDown.providerSuspended`): the program refuses a
  suspended agent's dispute, so the wallet refuses it first and says why.

- **Taking money back** from an agent (`agents.reclaim`) or sending it out
  (`wallet.withdraw`) costs the transfer's fee. A wallet that is not empty
  must keep the network's minimum (650,240 lamports on mainnet), so "all"
  empties it, down to the fee, whenever nothing still needs that wallet to
  pay: no open job it pays for, and for an agent, no earning. Otherwise it
  keeps the minimum and the fee room each open job was set up with, so those
  jobs can still finish.

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
  jobs, and its other services on offer. Since revision 9 a provider's first
  claim starts its stats record; a provider that has not claimed since then
  may have none, and then has `turnedDown` and `disputesLost` null: not
  counted, which is not clean.
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

## Posting a request

When nothing on offer fits, a request can be posted for anyone on the
marketplace to take: what is wanted, the reward, and how many days to deliver
in (1 to 30, 7 by default). It is the marketplace's single-worker task with
the buyer's review forced on (`create_task_humanless`), with the same
requester-paid safety check and pinned request as a hire. Nobody can take it
until the request is pinned.

- `wallet.post` (owner only): the person posts from the main balance.
  Asking is the yes. `overview.postCost` is the quote to show first: what is
  kept (the job record, the safety check of the request, the fees, and on a
  balance's first job the record of how often it posts) and what is set
  aside and comes back when the job ends.
- `market.post` (an agent method): an agent posts from its own money. Within
  its daily budget, when its money covers the reward and the deposits, it is
  posted at once; anything else waits for the person, as a hire does, with
  the same quote on the approval (`approval.kind` is "request").
- **A request is public.** Anyone can read it, as they can read a hire's.
- Until someone takes it, it can be cancelled and the reward comes back.
  Nobody can take it after the time it had to be delivered by; the wallet
  then cancels it by itself. Whoever takes it and does not deliver in time is
  cancelled the same way.
- A delivery is settled as a hire's is: approve and pay
  (`accept_task_result`), or turn it down (`reject_and_freeze`, never a plain
  rejection), which only a person can do. A request has no service, so it is
  not rated, and the finished job is tidied at once.
- The job view says `kind: "request"`. Its `provider` is null until someone
  takes it; the wallet finds who did from the claim on the task.

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

This build signs only for revision 9 of the marketplace program. Before it
signs anything that calls the program, it reads the program's stamp
(`ProtocolConfig.surface_revision`); on any other revision it refuses with
`NOT_AVAILABLE` and signs nothing. The error carries `retryable: true` while
the program is older (try again once it moves) and `false` when it is newer
(update the wallet). Reads, and moving the wallet's own money, keep working
on any revision. Practice money runs the program bundled with the wallet, so
it has no gate.

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

// An agent: only its own find, hire, post, status and review.
const lane = await connectWallet({ socketPath, token: ownerToken, actAs: agent.id });
const found = await runMarketTool(lane, agent.id, "market_find", { query: "logo" });
const hired = await runMarketTool(lane, agent.id, "market_hire", {
  service: found.services[0].id,
  request: "A simple logo for a bakery called Crumb.",
});
```

`MARKET_TOOLS` holds the five tool definitions (`market_find`, `market_hire`,
`market_post`, `market_status`, `market_review`) as JSON Schema, for any
agent framework. `market_post` posts a public request with a reward from the
agent's own money, within its budget, and waits for the person above it.
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

A job's intent (service or request, price, task address) is written to the journal
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
wallet shows it as set aside. Since revision 9 every job the agent takes also
puts down a claim deposit (10% of the price, at least 0.005 SOL). It comes
back when the agent delivers, and goes to the buyer if the agent never does.
The agent's first job also starts its marketplace record (kept). The wallet
counts both in what the agent needs before it can take jobs.

On its own that loop only takes open jobs anyone may claim. Hires go to a
listed service, so an agent with nothing listed is never hired.

Wherever `{agent}` appears in the executor's argv it is replaced with the id
of the agent doing the job, so a host can give each agent its own working
folder. Three more are replaced the same way:

- `{outbox}`: the folder where the executor leaves files to go with its
  delivery (see below). Empty when this network has nowhere to keep them.
- `{files}`: what a file's sha-256 is added to, to make its address in the
  delivery store. Empty with `{outbox}`.
- `{pay}`: the current job's reward in whole US cents, rounded down. The
  wallet refreshes the SOL price before claiming and before each execution,
  including retries and recovery. If the rate is missing or invalid, or the
  reward is less than one cent, no executor is started. Missing pricing at
  startup also stops the worker until a later housekeeping pass can read it.

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

`earn.offer` gives an earning agent a service others can hire. An agent can
offer up to ten, each its own listing:

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

Before enabling earning or saving an offer, Desktop must show the complete
funding quote. `offerCost` and `wordsCost` describe only marketplace costs;
they are not funding quotes.

```ts
const quote = await owner.call("earn.quote", { agentId, offer, offerId });
// Show totalFromMain and its breakdown. If requiresApproval is true,
// wait for the person's explicit approval before this owner-only call:
await owner.call("earn.approveFunding", { quoteId: quote.quoteId });
// Use the quoted SOL price so an exchange-rate change does not reprice it.
await owner.call("earn.offer", {
  agentId, offerId,
  offer: { ...offer, price: { lamports: quote.offerPrice!.lamports } },
});
await owner.call("earn.set", { agentId, enabled: true, minPayCents: 10 });
```

`earn.quote({ agentId })` quotes the current offers and enabling earning,
including background upkeep. Passing `offer` quotes adding or updating that
service, plus other pending offers. It reads balances, rents, registration
and checks without signing, publishing or transferring. It returns:

```ts
{
  quoteId: string, agentId: string, expiresAt: number,
  offerPrice: Money | null,
  registration: Money, listings: Money, checks: Money,
  workingReserve: Money, networkReserve: Money, agentBalance: Money,
  requiredBalance: Money, fromMain: Money, transferFee: Money,
  totalFromMain: Money, dailyRemaining: Money, requiresApproval: boolean
}
// Money = { lamports: string, usdCents: number | null }
```

`registration` includes the stake, registration rent and fee headroom.
`workingReserve` includes one claim deposit based on the highest advertised
price, the first worker record, claim and submission rents, worker fees,
and four earlier jobs' claim and submission rents. A claim deposit comes
back on delivery, so only one price-based deposit is needed for serial work.
`listings` and `checks` include all pending listing records, description
checks and their fee headroom. `networkReserve` keeps the agent account alive.
`requiredBalance` is their sum. `fromMain` is the shortfall after its current
balance; `totalFromMain` adds the main wallet's transfer fee. These are
conservative funding bounds, not promises that all reserves will be spent.

Quotes expire after five minutes and do not survive a wallet restart.
Approval moves at most the quoted amount to that quote's agent, once, and
returns `AgentView`. A higher agent balance reduces the transfer. Approval
funds the agent; it does not enable earning or save the offer. Get a new quote
if the agent's balance or the intended offer changes before continuing.
`earn.quote` and `earn.approveFunding` are owner-only RPC methods.

Automatic registration, offer creation, edits and description-check funding
share the agent's rolling 24-hour refill allowance. All transferred money,
including reserves and the transfer fee, counts. An above-budget `earn.set`
throws `APPROVAL_REQUIRED`; background offers show `status: "problem"` with
an approval message and move no money. Quote and explicitly approve funding
to continue. Missing dollar pricing also requires approval. An approved
transfer counts in that day's usage, even above the cap. Charges are saved
before sending; ambiguous or failed sends conservatively retain their charge
for 24 hours. Old journals' refill entries are also counted.

Offers must cost at most 1 SOL, or the configured worker maximum if lower.
Higher prices are refused for both creation and edits. Existing oversized
offers are paused until their prices are lowered and cannot receive automatic funding. A service hire below the
agent's open-job minimum is accepted only after canonical hire provenance is
checked. Unrelated open-market jobs keep the person's minimum.

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

Each service has an `id` in `AgentView.earn.offers`. `earn.offer` with that
`offerId` changes its price or description (a new description is checked
again; the name is fixed once listed), and `offer: null` with it takes that
service off offer. Without `offerId`, a name the agent already uses changes
that service (or offers it again, on the same listing, after it was taken
off); a new name adds a service. `AgentView.earn.offer` (the first wanted
service) is kept for hosts that show one. A journal written when an agent had one
service is read as that agent's first.

A service is on the marketplace only while someone is there to do the work.
The listing is paused when taking jobs is switched off, when the offer is
withdrawn, when the agent stopped taking jobs after several in a row failed,
and when the wallet closes; it is put back when they return. A wallet that
is killed outright leaves its listing up until the next start.

Two things keep a hire from sitting unstarted, because nobody else can take
a hire of this agent's service:

- The stock watcher reports a job once. While an agent offers a service the
  wallet starts the watch afresh every minute (`serviceRefreshMs`), so a hire
  it could not take at first sight is looked at again.
- A job's deposits stay out until its buyer pays, which can take a day. When
  a service goes on offer the agent's wallet is given enough for four
  earlier jobs to be out at once. That money stays the agent's allowance.

An agent cannot hire its own service. Another agent of the same wallet can.

## Stopping for good

`agents.retire` stops an agent earning for good and brings back the deposit it
locked to take jobs (`AgentView.earn.setAside`). With earning off and nothing
open it does three things, in this order:

1. Brings the agent's own jobs up to date, as its loop would: what buyers paid
   since the loop last ran, a delivery whose buyer let the review time pass,
   the hold on a job it gave up once that job's time is over.
2. Takes every service it has on the marketplace off for good (listing state
   Retired, which cannot be undone), so nobody can hire it from then on. They
   go in one transaction, so the agent pays one fee for all of them.
3. Retires the agent on the marketplace (`deregister_agent`). Every lamport its
   record holds above the network's minimum, the deposit, goes back to the
   agent's own wallet, where it stays until the person takes it back
   (`agents.reclaim`). The record itself stays, as the marketplace keeps it.

It is refused, with a sentence that says why, while the agent still takes jobs
(earning on, a service on offer: switch earning off first), the marketplace has
suspended it, or a reviewer has not settled one of its jobs; these are in
`AgentView.earn.retire.refusal` before anyone asks. After step 1 it is also
refused while a job is not finished (working, or delivered and not paid) or a
job it gave up is still held. A service still on offer is first taken off
(paused, which can be undone); then a hire of the agent that nobody started
and that can still be done stops it, before anything is for good: the agent
is the only one who may do it, so the buyer would wait out the time to deliver
for nothing. Switch earning on until it is done and paid (the loop takes
that hire whatever the agent's smallest pay; every other job keeps it), then
switch it off and retire again. A hire whose time to
deliver is over does not stop it (its buyer gets the price back). A job the
agent had not finished when its wallet last closed goes on only with earning
on, and the refusal says so. The marketplace's own record wins: an agent retired there is taken
as retired even when older records (a restored journal) say otherwise.

Afterwards `AgentView.earn.retired` is true, and `earn.set` and `earn.offer`
are refused for that agent. Its money, budget and hires are as before.

## Running after the host closes

`serve --unlock-socket <path>` is for a service manager (systemd `--user`,
launchd) that keeps the wallet running, and earning, after the host app
closes. It reads nothing from stdin and no file: it starts locked, serving
nothing, and waits on that socket (in a folder private to the person) for
its host. The host then hands over the same start-up line it would write to
a child's stdin (`openBackgroundWallet` in `client/unlock.ts`). A host that
starts again while the wallet runs does not send the secret again: it proves
it holds it (an HMAC over a one-time value) and is told the running owner
credential. A wrong secret leaves the wallet locked. The secret is only ever
in the two processes' memory and on that socket: never on a command line, in
the environment, in a log or in a file. Stopped by its service manager
(SIGTERM), it takes its services off offer and exits.

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
- A listing cannot be removed, only paused or retired, and its deposit does
  not come back. Neither does the deposit behind an agent's registration
  record when it is retired (only its stake does).
- A description is plain text. A provider's links and sample files are not
  shown.
- A file with a delivery is at most 256 KB, because that is what the
  marketplace's store keeps.

## Develop

```bash
npm run typecheck
npm run test:unit   # no chain
npm run test:e2e    # the real program in litesvm
npm run build
```

MIT.
