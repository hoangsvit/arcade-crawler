# Historical committed slot states (2026)

Exactly **14 Git versions** of `data/arcade_milestones.json` were found between 2026-06-24T08:22:08.000Z and 2026-09-21T16:41:46.000Z. Their stored tier counts were recovered verbatim from their respective commits. They are labelled `source: { kind: "git-commit", sha: "..." }`; their `at` field is the **commit timestamp, not a verified exact crawl time**. Do not infer missing daily/six-hour samples.

- June: 2 historical commit states.
- July: 4 historical commit states.
- August: 5 historical commit states.
- September: 3 historical commit states, plus the genuine crawler observation 2026-09-23T03:39:30.748Z.
- The rolling 31-day feed holds 7 real states (including one previous anchor); the complete committed history remains permanently partitioned into four monthly JSON archives.

Reproduce with `npm run build && node scripts/backfill-milestone-history.mjs` in a full Git checkout. The importer is idempotent and leaves real crawler observations untouched.
