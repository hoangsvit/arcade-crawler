# Arcade prize-slot history

This dataset begins at the **first successful crawler run after this feature is merged**.
Existing milestone JSON and earlier Git commits do not carry trustworthy observation
timestamps; do not fabricate or infer historical snapshots from them.

## Format
- data/arcade_milestones_history/latest.json: version 1 and a snapshots array,
  containing the previous observation immediately before the last 31 days (if
  available) plus each changed observation in the rolling 31-day window.
- data/arcade_milestones_history/YYYY/MM.json: permanent, append-only
  monthly archives, partitioned by UTC observation date.
- Each snapshot has an ISO-8601 UTC at timestamp and four tiers with
  points, slots and spotsLeft.
- Snapshot frequency is *change-driven*, checked by the existing crawler
  scheduled every six hours, not a constant six-hour sampling rate.

The browser feed is updated only for actual changes to an observed remaining
count or capacity. A jump up or down is a change in the published count, not
evidence of the reason; no claims about new prize supply or allocation.

Latest feed (after first successful run):
https://raw.githubusercontent.com/hoangsvit/arcade-crawler/main/data/arcade_milestones_history/latest.json
