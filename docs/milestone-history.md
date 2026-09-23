# Arcade prize-slot history

This dataset begins at the **first successful crawler run after this feature is merged**.
Existing milestone JSON and earlier Git commits do not carry trustworthy observation
timestamps; do not fabricate or infer historical snapshots from them.

## Format
- data/arcade_milestones_history/latest.json: version 1 and a snapshots array,
  containing the previous observation immediately before the last 31 days (if
  available) plus real daily checkpoints and changed observations within the
  rolling 31-day window.
- data/arcade_milestones_history/YYYY/MM.json: permanent, append-only
  monthly archives, partitioned by UTC observation date. A month with a
  successful crawl gets at least one genuine observation even if slot counts
  never changed. Month start means the first successful UTC crawl, not
  a fabricated midnight reading.
- Each snapshot has an ISO-8601 UTC at timestamp and four tiers with
  points, slots and spotsLeft.
- Snapshot frequency: first successful crawl each UTC day, plus every
  observed count/capacity change, checked by the existing six-hour schedule.
  Multiple unchanged runs in the same UTC day add no snapshot.
- The data source is the crawled page and the actual crawl timestamp. Git
  commits merely persist these JSON observations; Git history is not queried
  to reconstruct months. A day/month with no successful crawl has no invented
  observation.

The browser feed is updated for the daily checkpoint or for an actual
change to an observed remaining count or capacity. A jump up or down is a change in the published count, not
evidence of the reason; no claims about new prize supply or allocation.

Latest feed (after first successful run):
https://raw.githubusercontent.com/hoangsvit/arcade-crawler/main/data/arcade_milestones_history/latest.json
