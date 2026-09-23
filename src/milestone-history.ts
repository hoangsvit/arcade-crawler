import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type MilestoneCount = {
    points: number;
    slots: number;
    spotsLeft: number;
};

export type MilestoneSnapshot = {
    /** UTC crawl timestamp for new records; Git commit time for legacy imports. */
    at: string;
    tiers: MilestoneCount[];
    /** Legacy snapshots have a verifiable commit but no guaranteed crawl time. */
    source?: { kind: 'git-commit'; sha: string };
};

export type MilestoneHistoryFeed = {
    version: 1;
    snapshots: MilestoneSnapshot[];
};

export const MILESTONE_HISTORY_DIR = 'data/arcade_milestones_history';
export const MILESTONE_HISTORY_LATEST = join(MILESTONE_HISTORY_DIR, 'latest.json');
const EXPECTED_POINTS = [50, 75, 95, 120];
const WINDOW_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTiers(tiers: readonly MilestoneCount[]): MilestoneCount[] {
    if (tiers.length !== EXPECTED_POINTS.length) {
        throw new Error('Expected exactly four Arcade prize tiers.');
    }
    const sorted = tiers.map((tier) => ({
        points: tier.points, slots: tier.slots, spotsLeft: tier.spotsLeft,
    })).sort((a, b) => a.points - b.points);
    for (let index = 0; index < sorted.length; index += 1) {
        const tier = sorted[index];
        if (tier.points !== EXPECTED_POINTS[index] ||
            !Number.isSafeInteger(tier.slots) || tier.slots <= 0 ||
            !Number.isSafeInteger(tier.spotsLeft) ||
            tier.spotsLeft < 0 || tier.spotsLeft > tier.slots) {
            throw new Error('Invalid Arcade prize tier: ' + JSON.stringify(tier));
        }
    }
    return sorted;
}

function validateHistory(input: unknown): MilestoneHistoryFeed {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Invalid milestone history document.');
    }
    const feed = input as Record<string, unknown>;
    if (feed.version !== 1 || !Array.isArray(feed.snapshots)) {
        throw new Error('Unsupported milestone history format.');
    }
    let previousTime = -Infinity;
    const snapshots = feed.snapshots.map((value) => {
        if (!value || typeof value !== 'object') throw new Error('Invalid milestone snapshot.');
        const snapshot = value as Record<string, unknown>;
        if (typeof snapshot.at !== 'string' ||
            Number.isNaN(Date.parse(snapshot.at)) ||
            new Date(snapshot.at).toISOString() !== snapshot.at ||
            Date.parse(snapshot.at) <= previousTime ||
            !Array.isArray(snapshot.tiers)) {
            throw new Error('Invalid or unordered milestone snapshot.');
        }
        previousTime = Date.parse(snapshot.at);
        const source = snapshot.source;
        if (source !== undefined && (
            !source || typeof source !== 'object' || Array.isArray(source) ||
            (source as Record<string, unknown>).kind !== 'git-commit' ||
            typeof (source as Record<string, unknown>).sha !== 'string' ||
            !/^[a-f0-9]{40}$/.test((source as { sha: string }).sha)
        )) {
            throw new Error('Invalid Git commit source in milestone history.');
        }
        return {
            at: snapshot.at,
            tiers: normalizeTiers(snapshot.tiers as MilestoneCount[]),
            ...(source === undefined ? {} : { source: source as { kind: 'git-commit'; sha: string } }),
        };
    });
    return { version: 1, snapshots };
}

async function readHistory(file: string): Promise<MilestoneHistoryFeed> {
    try {
        return validateHistory(JSON.parse(await readFile(file, 'utf8')) as unknown);
    } catch (error) {
        if (error instanceof Error && 'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: 1, snapshots: [] };
        }
        // A corrupted existing history must never be silently overwritten.
        throw error;
    }
}

function sameTiers(left: MilestoneCount[], right: MilestoneCount[]): boolean {
    return left.every((tier, index) =>
        tier.points === right[index].points &&
        tier.slots === right[index].slots &&
        tier.spotsLeft === right[index].spotsLeft);
}

export function historyMonthFile(root: string, at: string): string {
    if (Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) {
        throw new Error('Expected a canonical UTC timestamp.');
    }
    // UTC partitioning is independent of GitHub runner and user time zones.
    return join(root, at.slice(0, 4), at.slice(5, 7) + '.json');
}

function latestWindow(snapshots: MilestoneSnapshot[], observedMs: number): MilestoneSnapshot[] {
    const cutoff = observedMs - WINDOW_DAYS * DAY_MS;
    const inWindow = snapshots.filter((item) => Date.parse(item.at) >= cutoff);
    const anchor = [...snapshots].reverse().find((item) => Date.parse(item.at) < cutoff);
    return anchor ? [anchor, ...inWindow] : inWindow;
}

async function writeHistory(file: string, feed: MilestoneHistoryFeed) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(feed, null, 2) + '\n', 'utf8');
}

/**
 * Record a genuine observation from the first successful crawl on each UTC day
 * and immediately after every material change (count or capacity).
 * Permanent UTC-month archives are NOT built from Git commit history; they
 * contain real crawler timestamps and remain present in unchanged months.
 * The rolling 31-day UI feed retains the latest pre-window anchor.
 * Historical Git commit states may be imported separately only when
 * explicitly marked as commit-dated (never silently called crawl timestamps).
 */
export async function persistMilestoneHistory(
    tiers: readonly MilestoneCount[],
    root = MILESTONE_HISTORY_DIR,
    observedAt: Date = new Date(),
): Promise<{ changed: boolean; latestFile: string; archiveFile: string | null; snapshotCount: number }> {
    const observedMs = observedAt.getTime();
    if (!Number.isFinite(observedMs)) throw new Error('Invalid observation date.');
    const at = observedAt.toISOString();
    const normalized = normalizeTiers(tiers);
    const latestFile = join(root, 'latest.json');
    const latest = await readHistory(latestFile);
    const previous = latest.snapshots[latest.snapshots.length - 1];
    // Check timestamps before deduplication: an out-of-order retry should
    // never silently conceal an invalid or stale observation.
    if (previous && Date.parse(previous.at) >= observedMs) {
        throw new Error('Milestone history observation must be newer than the last snapshot.');
    }
    const countChanged = !previous || !sameTiers(previous.tiers, normalized);
    const newUtcDay = !previous || previous.at.slice(0, 10) !== at.slice(0, 10);
    // Successful crawls without a change are sampled once per UTC day, so
    // months with stable counts have real observations, not invented changes.
    if (!countChanged && !newUtcDay) {
        return { changed: false, latestFile, archiveFile: null, snapshotCount: latest.snapshots.length };
    }

    const nextSnapshot: MilestoneSnapshot = { at, tiers: normalized };
    const archiveFile = historyMonthFile(root, at);
    const archive = await readHistory(archiveFile);
    const lastArchive = archive.snapshots[archive.snapshots.length - 1];
    if (lastArchive && Date.parse(lastArchive.at) >= observedMs) {
        throw new Error('Milestone archive already has a newer observation.');
    }
    // Archive is persisted first: failed runs never replace prior history.
    await writeHistory(archiveFile, {
        version: 1, snapshots: [...archive.snapshots, nextSnapshot],
    });
    const snapshots = latestWindow([...latest.snapshots, nextSnapshot], observedMs);
    await writeHistory(latestFile, { version: 1, snapshots });
    return { changed: true, latestFile, archiveFile, snapshotCount: snapshots.length };
}

export type LegacyMilestoneCommit = {
    sha: string;
    committedAt: string;
    tiers: readonly MilestoneCount[];
};

/**
 * One-off recovery of verifiable old milestone JSON from Git history.
 *
 * Git commit time is a best-known recorded time, NOT the exact original
 * crawl time. Imported snapshots are annotated and kept distinct from real
 * crawler observations. Existing live snapshots/archives are never replaced.
 * The operation is idempotent: reimporting the same SHA changes no file.
 */
export async function backfillMilestoneCommits(
    commits: readonly LegacyMilestoneCommit[],
    root = MILESTONE_HISTORY_DIR,
): Promise<{ imported: number; archiveFiles: string[]; latestFile: string }> {
    const latestFile = join(root, 'latest.json');
    const latest = await readHistory(latestFile);
    const firstActual = latest.snapshots.find((snapshot) => snapshot.source === undefined);
    const earliestLiveTime = firstActual ? Date.parse(firstActual.at) : Infinity;

    const normalized = commits.map((entry): MilestoneSnapshot => {
        if (!/^[a-f0-9]{40}$/.test(entry.sha) ||
            !Number.isFinite(Date.parse(entry.committedAt))) {
            throw new Error('Invalid legacy commit SHA or timestamp.');
        }
        return {
            at: new Date(entry.committedAt).toISOString(),
            tiers: normalizeTiers(entry.tiers),
            source: { kind: 'git-commit', sha: entry.sha },
        };
    }).filter((entry) => Date.parse(entry.at) < earliestLiveTime)
      .sort((left, right) => left.at.localeCompare(right.at));

    if (new Set(normalized.map((item) => item.source?.sha)).size !== normalized.length ||
        normalized.some((item, index) => index > 0 && item.at === normalized[index - 1].at)) {
        throw new Error('Duplicate Git commits or ambiguous commit timestamps.');
    }

    const grouped = new Map<string, MilestoneSnapshot[]>();
    for (const item of normalized) {
        const archiveFile = historyMonthFile(root, item.at);
        grouped.set(archiveFile, [...(grouped.get(archiveFile) ?? []), item]);
    }

    const imports: MilestoneSnapshot[] = [];
    const archiveFiles: string[] = [];
    for (const [archiveFile, candidates] of grouped) {
        const archive = await readHistory(archiveFile);
        const existingShas = new Set(archive.snapshots
            .filter((item) => item.source?.kind === 'git-commit')
            .map((item) => item.source?.sha));
        const additional = candidates.filter((item) => !existingShas.has(item.source?.sha));
        if (additional.length === 0) continue;
        const merged = [...archive.snapshots, ...additional]
            .sort((left, right) => left.at.localeCompare(right.at));
        if (merged.some((item, index) => index > 0 && item.at === merged[index - 1].at)) {
            throw new Error('A legacy commit overlaps an existing observation timestamp.');
        }
        imports.push(...additional);
        // Preserve live observations and previously imported commits.
        await writeHistory(archiveFile, { version: 1, snapshots: merged });
        archiveFiles.push(archiveFile);
    }

    if (imports.length > 0) {
        const byTime = new Map<string, MilestoneSnapshot>();
        for (const snapshot of [...latest.snapshots, ...imports]) {
            if (byTime.has(snapshot.at)) {
                const existing = byTime.get(snapshot.at);
                if (JSON.stringify(existing) !== JSON.stringify(snapshot)) {
                    throw new Error('Conflicting milestone snapshots at the same time.');
                }
                continue;
            }
            byTime.set(snapshot.at, snapshot);
        }
        const sorted = [...byTime.values()].sort((a, b) => a.at.localeCompare(b.at));
        const lastAt = sorted[sorted.length - 1]?.at;
        if (lastAt) {
            await writeHistory(latestFile, {
                version: 1, snapshots: latestWindow(sorted, Date.parse(lastAt)),
            });
        }
    }
    return { imported: imports.length, archiveFiles, latestFile };
}
