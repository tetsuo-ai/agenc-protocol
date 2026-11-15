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
- A socket server with owner and agent-bound connections, a dependency-free
  client, and four agent tools (`market_find`, `market_hire`,
  `market_status`, `market_review`).
- A practice mode: the real marketplace program in-process with play money.
