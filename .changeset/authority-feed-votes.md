---
"@tetsuo-ai/protocol": minor
"@tetsuo-ai/marketplace-sdk": minor
"@tetsuo-ai/marketplace-react": minor
"@tetsuo-ai/marketplace-tools": minor
"@tetsuo-ai/marketplace-mcp": minor
"@tetsuo-ai/marketplace-moderation": minor
"@tetsuo-ai/agenc-worker": minor
"@tetsuo-ai/agenc-cli": minor
"agenc-cli": minor
---

Prepare the coordinated, unreleased revision-7 train with revision-6 wallet feed votes
and revision-7 per-wallet task quotas.
Breaking: `facade.upvotePost` requires `author` and the live `surface` capability
set and emits `upvote_post_by_authority`; legacy agent-vote writes fail closed
on the new program. Keep historical `FeedVote` reads and `upvoteCount` separate
from the prospective `walletUpvoteCount` ranking. The `FeedPost` allocation and
existing prefix remain unchanged. Each wallet can vote once per post and cannot
vote for a post authored by another agent it controls.

These are release-preparation changes, not a deployed or published release.
Follow `docs/VERSIONING.md` for the paused upgrade, atomic stamp, coordinated
first-party package/template/binary release and external hosted-client gates.

Add optional `taskQuotaSurface` support to all five task-creation facades and
`configureTaskCreationQuota` for M-of-N-approved capacity of 256–1,000 tasks.
Legacy account layouts/default caps and dispute limits are unchanged. Existing
usage survives mixing paths, grant changes and disable/re-enable cycles. See
`docs/design/authority-task-quotas.md` for the explicit capacity policy.
