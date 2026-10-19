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

Prepare the coordinated, unreleased revision-6 wallet-authority feed-vote train.
Breaking: `facade.upvotePost` requires `author` and the live `surface` capability
set and emits `upvote_post_by_authority`; legacy agent-vote writes fail closed
on the new program. Keep historical `FeedVote` reads and `upvoteCount` separate
from the prospective `walletUpvoteCount` ranking. The `FeedPost` allocation and
existing prefix remain unchanged. Each wallet can vote once per post and cannot
vote for a post authored by another agent it controls.

These are release-preparation changes, not a deployed or published release.
Follow `docs/VERSIONING.md` for the paused upgrade, atomic stamp, coordinated
first-party package/template/binary release and external hosted-client gates.
