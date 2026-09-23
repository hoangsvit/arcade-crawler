# Arcade prize-slot history

Regular daily snapshots begin at the **first successful crawler run after
this feature was merged**. We can also recover previous VALUES from Git
commits that actually changed `data/arcade_milestones.json`. Those records
carry `source: { kind: "git-commit", sha: "<full SHA>" }` and `at` is the
Git COMMIT time, not a verified original crawl timestamp. Never infer
uncommitted six-hour observations from neighboring committed values.

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
  points, slots and spotsLeft. An optional `source` object identifies
  recovered Git snapshots; its absence means a genuine crawler observation.
  Consumers must label historical commit-dated data accordingly.
- Snapshot frequency: first successful crawl each UTC day, plus every
  observed count/capacity change, checked by the existing six-hour schedule.
  Multiple unchanged runs in the same UTC day add no snapshot.
- New observations use the actual crawl time. A one-off backfill can
  import prior committed values at their commit timestamps, clearly labeled.
  Git history is NOT used for future daily sampling. Months with no old
  milestone commit and no actual new crawl remain gaps; no dates are invented.

The browser feed is updated for the daily checkpoint or for an actual
change to an observed remaining count or capacity. A jump up or down is a change in the published count, not
evidence of the reason; no claims about new prize supply or allocation.

Latest feed (after first successful run):
https://raw.githubusercontent.com/hoangsvit/arcade-crawler/main/data/arcade_milestones_history/latest.json

## Reproducing the historical backfill

From a full clone (`git fetch --unshallow` if necessary), run:

```bash
npm ci
npm run build
node scripts/backfill-milestone-history.mjs
```

The importer reads only commits that contain `data/arcade_milestones.json`,
checks four tier values and SHA/date format, leaves live observations alone,
and updates permanent monthly archives plus the compact UI feed. Running the
same backfill twice does not create duplicate records. Commit timestamps
are an **approximate historical reference**, not proof of the crawl time.
