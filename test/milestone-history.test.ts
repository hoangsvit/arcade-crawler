import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { historyMonthFile, persistMilestoneHistory } from '../src/milestone-history.js';

const counts = (first = 3514, second = 1760, third = 1020, fourth = 1511) => [
    { points: 50, slots: 6000, spotsLeft: first },
    { points: 75, slots: 4000, spotsLeft: second },
    { points: 95, slots: 3000, spotsLeft: third },
    { points: 120, slots: 2500, spotsLeft: fourth },
];

async function withTemp(run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'arcade-slots-'));
    try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function feed(file: string) {
    return JSON.parse(await readFile(file, 'utf8'));
}

test('first observation creates a durable archive and a small browser feed', async () => {
    await withTemp(async (root) => {
        const result = await persistMilestoneHistory(counts(), root, new Date('2026-09-23T01:00:00Z'));
        assert.equal(result.changed, true);
        assert.equal(result.snapshotCount, 1);
        assert.equal(result.archiveFile, historyMonthFile(root, '2026-09-23T01:00:00.000Z'));
        assert.deepEqual((await feed(result.latestFile)).snapshots[0].tiers, counts());
        assert.equal((await feed(result.archiveFile!)).snapshots[0].at, '2026-09-23T01:00:00.000Z');
    });
});

test('unchanged runs do not append snapshots or rewrite files', async () => {
    await withTemp(async (root) => {
        const first = await persistMilestoneHistory(counts(), root, new Date('2026-09-23T01:00:00Z'));
        const original = await readFile(first.latestFile, 'utf8');
        const duplicate = await persistMilestoneHistory(counts(), root, new Date('2026-09-23T07:00:00Z'));
        assert.equal(duplicate.changed, false);
        assert.equal(duplicate.archiveFile, null);
        assert.equal(await readFile(first.latestFile, 'utf8'), original);
        assert.equal((await feed(first.archiveFile!)).snapshots.length, 1);
    });
});

test('increases and decreases are preserved as observations, never inferred', async () => {
    await withTemp(async (root) => {
        const first = new Date('2026-09-23T01:00:00Z');
        await persistMilestoneHistory(counts(), root, first);
        const next = await persistMilestoneHistory(counts(3718, 1622, 781, 1397), root,
            new Date('2026-09-23T07:00:00Z'));
        const snapshots = (await feed(next.latestFile)).snapshots;
        assert.equal(snapshots.length, 2);
        assert.deepEqual(snapshots[1].tiers.map((tier: { spotsLeft: number }) => tier.spotsLeft),
            [3718, 1622, 781, 1397]);
        assert.equal((await feed(next.archiveFile!)).snapshots.length, 2);
    });
});

test('cross-month observations keep old permanent archives and one rolling feed', async () => {
    await withTemp(async (root) => {
        await persistMilestoneHistory(counts(), root, new Date('2026-08-20T01:00:00Z'));
        await persistMilestoneHistory(counts(3400), root, new Date('2026-09-01T01:00:00Z'));
        const now = await persistMilestoneHistory(counts(3300), root, new Date('2026-10-03T01:00:00Z'));
        assert.equal((await feed(join(root, '2026', '08.json'))).snapshots.length, 1);
        assert.equal((await feed(join(root, '2026', '09.json'))).snapshots.length, 1);
        assert.equal((await feed(join(root, '2026', '10.json'))).snapshots.length, 1);
        const rolling = (await feed(now.latestFile)).snapshots;
        assert.equal(rolling.length, 2);
        assert.equal(rolling[0].at, '2026-09-01T01:00:00.000Z');
        assert.equal(rolling[1].at, '2026-10-03T01:00:00.000Z');
    });
});

test('invalid or incomplete counts fail closed without writing history', async () => {
    await withTemp(async (root) => {
        await assert.rejects(() => persistMilestoneHistory(counts(9999), root), /Invalid Arcade prize tier/);
        await assert.rejects(() => persistMilestoneHistory(counts().slice(0, 3), root), /exactly four/);
        await assert.rejects(() => persistMilestoneHistory(counts(), root, new Date('bad')), /Invalid observation/);
        await assert.rejects(() => readFile(join(root, 'latest.json')), /ENOENT/);
    });
});

test('corrupt existing feeds and out-of-order observations are not overwritten', async () => {
    await withTemp(async (root) => {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'latest.json'), '{"version":1,"snapshots":"corrupt"}');
        await assert.rejects(() => persistMilestoneHistory(counts(), root), /Unsupported milestone history/);
        await writeFile(join(root, 'latest.json'), '{"version":1,"snapshots":[]}');
        await persistMilestoneHistory(counts(), root, new Date('2026-09-23T07:00:00Z'));
        await assert.rejects(
            () => persistMilestoneHistory(counts(3210), root, new Date('2026-09-23T06:00:00Z')),
            /newer than the last snapshot/,
        );
    });
});

test('first unchanged crawl of each new UTC day is recorded once, including a new month', async () => {
    await withTemp(async (root) => {
        const same = counts();
        const first = await persistMilestoneHistory(same, root, new Date('2026-09-30T21:00:00Z'));
        const second = await persistMilestoneHistory(same, root, new Date('2026-09-30T23:00:00Z'));
        assert.equal(first.changed, true);
        assert.equal(second.changed, false);

        // The first successful crawl of the next UTC day/month is a REAL
        // observation with a REAL timestamp; it must not be labeled midnight.
        const october = await persistMilestoneHistory(same, root, new Date('2026-10-01T05:10:45Z'));
        assert.equal(october.changed, true);
        assert.equal(october.archiveFile, join(root, '2026', '10.json'));
        assert.equal((await feed(join(root, '2026', '09.json'))).snapshots.length, 1);
        const archive = await feed(join(root, '2026', '10.json'));
        assert.equal(archive.snapshots.length, 1);
        assert.equal(archive.snapshots[0].at, '2026-10-01T05:10:45.000Z');
        assert.deepEqual(archive.snapshots[0].tiers, same);

        const extra = await persistMilestoneHistory(same, root, new Date('2026-10-01T11:10:45Z'));
        assert.equal(extra.changed, false);
        assert.equal((await feed(join(root, '2026', '10.json'))).snapshots.length, 1);
        assert.equal((await feed(october.latestFile)).snapshots.length, 2);
    });
});

test('a value change is recorded immediately even after the daily checkpoint', async () => {
    await withTemp(async (root) => {
        await persistMilestoneHistory(counts(), root, new Date('2026-09-23T01:00:00Z'));
        const daily = await persistMilestoneHistory(counts(), root, new Date('2026-09-24T01:00:00Z'));
        assert.equal(daily.changed, true);
        const changed = await persistMilestoneHistory(counts(3718, 1622, 781, 1397), root,
            new Date('2026-09-24T07:00:00Z'));
        assert.equal(changed.changed, true);
        const unchanged = await persistMilestoneHistory(counts(3718, 1622, 781, 1397), root,
            new Date('2026-09-24T13:00:00Z'));
        assert.equal(unchanged.changed, false);
        const archive = await feed(changed.archiveFile!);
        assert.deepEqual(archive.snapshots.map((snapshot: { at: string }) => snapshot.at), [
            '2026-09-23T01:00:00.000Z',
            '2026-09-24T01:00:00.000Z',
            '2026-09-24T07:00:00.000Z',
        ]);
    });
});

test('31-day rolling feed remains bounded while complete daily records remain in monthly archives', async () => {
    await withTemp(async (root) => {
        for (let day = 1; day <= 45; day += 1) {
            await persistMilestoneHistory(counts(), root,
                new Date(Date.UTC(2026, 7, day, 8, 30)));
        }
        const latest = await feed(join(root, 'latest.json'));
        const august = await feed(join(root, '2026', '08.json'));
        const september = await feed(join(root, '2026', '09.json'));
        assert.equal(august.snapshots.length, 31);
        assert.equal(september.snapshots.length, 14);
        // One anchor older than 31 days + the actual snapshots within 31 days.
        assert.equal(latest.snapshots.length, 33);
        assert.equal(latest.snapshots[0].at, '2026-08-13T08:30:00.000Z');
        assert.equal(latest.snapshots[latest.snapshots.length - 1].at,
            '2026-09-14T08:30:00.000Z');
    });
});

test('missing crawler runs do not create fake daily or monthly observations', async () => {
    await withTemp(async (root) => {
        await persistMilestoneHistory(counts(), root, new Date('2026-08-31T11:30:00Z'));
        await persistMilestoneHistory(counts(), root, new Date('2026-10-04T11:30:00Z'));
        await assert.rejects(() => readFile(join(root, '2026', '09.json')), /ENOENT/);
        const october = await feed(join(root, '2026', '10.json'));
        assert.equal(october.snapshots.length, 1);
        const latest = await feed(join(root, 'latest.json'));
        assert.equal(latest.snapshots.length, 2);
    });
});
