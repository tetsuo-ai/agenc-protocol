# Changelog

All notable changes to `@tetsuo-ai/agenc-wallet` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package follows [Semantic Versioning](https://semver.org/).

## 0.1.0 - unreleased

First version. Not published.

- A local wallet service: an encrypted key vault, one main balance, one
  wallet per agent, and a crash-safe journal of every job.
- The buying side end to end: find, hire (from an allowance or after a
  person's approval), delivery, approve, ask for changes, cancel, rate, and
  automatic refund and tidy-up.
- The earning side: the stock worker loop run for an agent with a
  host-supplied executor.
- Offering a service (`earn.offer`): an earning agent lists one thing it
  does, the wallet publishes the description and has it attested, and the
  worker loop takes the hires. The listing is on the marketplace only while
  someone is there to do the work: it is paused when taking jobs is switched
  off, when the offer is withdrawn, and when the wallet closes.
- Whoever asks for a safety check pays for it. The attestation service signs
  the approval and hands it back; the buyer's wallet (for a job's request) or
  the agent's wallet (for a service it offers) checks that transaction, pays
  the deposit behind the approval's record and the fee, and sends it.
- An agent is made with one call that needs no name, and one number sets what
  it may spend on its own each day (`agents.create`, `agents.setBudget`). A
  host can tie an agent to a place of its own, such as a project.
- A job's request and a service's description are published through the
  marketplace site before anything is committed on-chain, so the safety
  check and every provider can read exactly what the hash says.
- On the free public Solana endpoint the wallet paces its requests and waits
  out a "too many requests"; a hire the network was too busy to take is sent
  again instead of failing, and balances stay on screen when they cannot be
  read.
- A socket server with owner and agent-bound connections, a dependency-free
  client, and four agent tools (`market_find`, `market_hire`,
  `market_status`, `market_review`).
- Every service found says who offers it and what buyers really paid it,
  read from the chain: the agent's age, paid jobs, turn-downs, lost disputes,
  deposit and other services, and ratings and paid jobs weighed by the fee
  each job paid, with the marketplace's own accounts left out. The list ranks
  by that record, and each service gives the marketplace's fee on its price.
  A provider with no stats record has its turn-downs and lost disputes null
  (no record kept), never zero.
- A practice mode: the real marketplace program in-process with play money.
- A service says what it is. The marketplace's list carries names and prices
  only, so the wallet reads each listing's own description from the address
  the listing records, shows it only when it is the text the listing
  committed to, tidies it to plain text (what it is, what to send, what comes
  back, the provider's terms) and remembers it. `market.find` searches all of
  that, and answers one page with the total.
- Posting a request for anyone to take, from the main balance (`wallet.post`,
  owner only, with the quote in `overview.postCost`) or from an agent's own
  money within its budget (`market.post`; above the budget the person
  approves, as with a hire). It is a single-worker task with the buyer's
  review on (`create_task_humanless`), the requester-paid safety check and a
  pinned request; it appears in the jobs list like a hire
  (`kind: "request"`), is cancelled by itself when nobody took it in time,
  and is settled by approving or turning down the delivery. Agents post with
  a fifth tool, `market_post`, which tells the model a request is public.
- A delivery that is turned down commits to a reason anyone can work out
  again (the hash of the task, the delivery, the request and why, instead of
  a fingerprint of the wallet's own clock), and is counted on the provider's
  marketplace record when it has one: the wallet reads the provider's
  `AgentStats` right before building `reject_and_freeze` and passes it only
  when it exists. It never starts one, which would cost the buyer. The job
  says whether the turn-down goes on a record (`turnDownRecorded`).
- Asking for changes is offered only where the note can reach the provider
  (`canAskChanges`): on a network with no message host the job does not
  offer it, to a person or to an agent.
- Files with a delivery. An earning agent's executor leaves files in its
  outbox (`{outbox}`) and lists them at the end of the delivery text; the
  wallet publishes them with the delivery, signed with the agent's key. The
  buyer's wallet reads the list (`job.result.files`) and hands a file over
  checked (`jobs.file`). The executor is also told what a file's address
  starts with (`{files}`) and the least a job pays (`{pay}`). Practice mode
  has a service that sends a picture back.
