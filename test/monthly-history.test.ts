import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import {
    ARCADE_TIME_ZONE,
    extractHistoricalMonthlyGames,
    type MonthlyArcadeGame,
} from '../src/arcade-extractors.js';
import {
    arcadeMonthKey,
    monthlyArchiveFile,
    persistMonthlyGameArchives,
} from '../src/monthly-games-archive.js';

async function withPage(html: string, run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(html);
        await run(page);
    } finally {
        await browser.close();
    }
}

function game(overrides: Partial<MonthlyArcadeGame>): MonthlyArcadeGame {
    return {
        title: 'Example Arcade Game',
        imageUrl: null,
        accessCode: null,
        deadline: null,
        deadlineTimeZone: ARCADE_TIME_ZONE,
        description: null,
        points: 1,
        joinUrl: null,
        spotsRemaining: null,
        ...overrides,
    };
}

test('historical extractor reconstructs month boundaries and canonical titles', async () => {
    const html = `
        <div class="container goContainer">
            <div class="row">
                <div class="col-lg-2">
                    <img src="https://example.test/arcade-bc-26.png">
                    <p class="pt-5">Arcade Base Camp January</p>
                    <p>Arcade points: 1</p>
                </div>
                <!-- feb game over -->
                <div class="col-lg-2">
                    <img src="https://example.test/feb-special.png">
                    <p class="pt-5">Arcade From Foundation to Wonders</p>
                    <p>Arcade points: 3</p>
                </div>
                <!-- june games -->
                <div class="col-lg-2">
                    <img src="https://example.test/arcade-spe-jun.png">
                    <p class="pt-5">Arcade Skill Up Summer</p>
                    <p>Arcade points: 1</p>
                </div>
            </div>
        </div>
    `;

    await withPage(html, async (page) => {
        const result = await extractHistoricalMonthlyGames(page.mainFrame(), 2026);

        assert.equal(result.candidateCount, 3);
        assert.equal(result.skippedCount, 0);
        assert.deepEqual(
            result.games.map((item) => [item.month, item.title, item.points, item.group]),
            [
                ['2026-01', 'Google Skills Arcade Base Camp January 2026', 1, 'baseCampBadges'],
                ['2026-02', 'From Foundations To Wonders', 3, 'specialBadges'],
                ['2026-06', 'Logic Log', 1, 'levelBadges'],
            ],
        );
        assert.ok(result.games.every((item) => item.reconstructed === true));
        assert.ok(result.games.every((item) => item.source === 'official_google_skills_arcade_page'));
    });
});

test('archive month prefers explicit historical month when deadline is unavailable', () => {
    assert.equal(arcadeMonthKey(game({ month: '2026-03' })), '2026-03');
});

test('archive files are grouped under their year folder', () => {
    assert.equal(
        monthlyArchiveFile('data/arcade_monthly_games_history', '2026-09'),
        join('data/arcade_monthly_games_history', '2026', '09.json'),
    );
});

test('backfilled archives preserve multiple historical months', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arcade-history-'));

    try {
        const files = await persistMonthlyGameArchives([
            game({
                title: 'Level 1: January 2026',
                month: '2026-01',
                source: 'official_google_skills_arcade_page',
                reconstructed: true,
            }),
            game({
                title: 'Arcade Adventure: August 2026',
                month: '2026-08',
                source: 'official_google_skills_arcade_page',
                reconstructed: true,
            }),
        ], root);

        assert.deepEqual(files, [
            join(root, '2026', '01.json'),
            join(root, '2026', '08.json'),
        ]);

        const january = JSON.parse(await readFile(join(root, '2026', '01.json'), 'utf8')) as MonthlyArcadeGame[];
        const august = JSON.parse(await readFile(join(root, '2026', '08.json'), 'utf8')) as MonthlyArcadeGame[];

        assert.equal(january[0]?.title, 'Level 1: January 2026');
        assert.equal(january[0]?.month, '2026-01');
        assert.equal(august[0]?.title, 'Arcade Adventure: August 2026');
        assert.equal(august[0]?.month, '2026-08');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
