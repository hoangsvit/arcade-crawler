/**
 * One-time, auditable import from original data/arcade_milestones.json Git
 * commits. Run only in a FULL checkout (not a shallow CI checkout):
 *
 *   npm run build
 *   node scripts/backfill-milestone-history.mjs
 *
 * This never estimates missing six-hour snapshots. The Git commit's timestamp
 * is preserved with an explicit git-commit source for every recovered sample.
 */
import { execFileSync } from "node:child_process"
import { backfillMilestoneCommits } from "../dist/milestone-history.js"

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim()
}

const commitLines = git(
  "log", "--format=%H%x09%cI", "--", "data/arcade_milestones.json",
).split("\n").filter(Boolean)
if (commitLines.length === 0) {
  throw new Error("No milestone commits found. Use a full repository checkout.")
}

const history = commitLines.map((line) => {
  const [sha, committedAt] = line.split("\t")
  if (!/^[a-f0-9]{40}$/.test(sha) || !committedAt) {
    throw new Error("Unexpected git log record: " + line)
  }
  const tiers = JSON.parse(git("show", sha + ":data/arcade_milestones.json"))
  return { sha, committedAt, tiers }
})
const result = await backfillMilestoneCommits(history)
console.log(JSON.stringify({
  detectedCommits: history.length,
  imported: result.imported,
  archivesUpdated: result.archiveFiles,
  rollingFeed: result.latestFile,
  note: "Historic timestamps come from Git commits, NOT exact crawl times.",
}, null, 2))
