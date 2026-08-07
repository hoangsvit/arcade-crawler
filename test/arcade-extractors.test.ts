import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { extractMonthlyGames, extractTierSpots } from '../src/arcade-extractors.js';

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

const tierHtml = `
    <div class="tier-points">4,052 / 6000 spots left</div>
    <div class="tier-points">3413 / 4000 spots left</div>
    <div class="tier-points">2,765 / 3000 spots left</div>
    <div class="tier-points">2496 / 2500 spots left</div>
`;

function monthlyCard(options: {
    title: string;
    code: string;
    points?: number;
    gameId: number;
    image: string;
    wide?: boolean;
}) {
    return `
        <div class="${options.wide ? 'dark-back pt-4 py-3 ' : 'col-md-3 mb-3 '}shuffle-item">
            <div class="${options.wide ? 'container' : ''}">
                <h3 class="card-title">${options.title}</h3>
                <a href="https://www.skills.google/games/${options.gameId}">
                    <img class="card-img-top" src="${options.image}">
                </a>
                <p><span>Access code:</span> ${options.code}</p>
                <p>Arcade points: ${options.points ?? 1}</p>
                <a href="https://www.skills.google/games/${options.gameId}?utm_campaign=future-month">
                    <button>START!</button>
                </a>
            </div>
        </div>
    `;
}

test('monthly extraction does not depend on month or game names', async () => {
    const futureMonthCards = [
        monthlyCard({
            title: 'Arcade Nebula September 2026',
            code: '1q-nebula-11111',
            gameId: 8101,
            image: 'https://example.test/nebula.png',
        }),
        monthlyCard({
            title: 'Cloud Quest: October Edition',
            code: '1q-cloudquest-22222',
            gameId: 8102,
            image: 'https://example.test/cloudquest.png',
            wide: true,
        }),
        monthlyCard({
            title: 'A Completely New Arcade Name',
            code: '1q-newgame-33333',
            gameId: 8103,
            image: 'https://example.test/newgame.png',
        }),
    ];

    await withPage(`${tierHtml}${futureMonthCards.join('')}`, async (page) => {
        const result = await extractMonthlyGames(page.mainFrame());

        assert.equal(result.candidateCount, 3);
        assert.equal(result.skippedCount, 0);
        assert.deepEqual(
            result.games.map((game) => game.title),
            [
                'Arcade Nebula September 2026',
                'Cloud Quest: October Edition',
                'A Completely New Arcade Name',
            ],
        );
        assert.deepEqual(
            result.games.map((game) => game.accessCode),
            ['1q-nebula-11111', '1q-cloudquest-22222', '1q-newgame-33333'],
        );
        assert.ok(result.games.every((game) => game.points === 1));
        assert.ok(result.games.every((game) => game.joinUrl?.startsWith('https://www.skills.google/games/')));
    });
});

test('tier extraction still succeeds when monthly cards cannot be extracted', async () => {
    const brokenMonthlyCard = `
        <div class="shuffle-item">
            <h3 class="card-title">Future Arcade Game</h3>
            <p>This card intentionally has no access code, points, or START button.</p>
        </div>
    `;

    await withPage(`${tierHtml}${brokenMonthlyCard}`, async (page) => {
        const tierSpots = await extractTierSpots(page.mainFrame());
        const monthly = await extractMonthlyGames(page.mainFrame());

        assert.deepEqual(tierSpots, [4052, 3413, 2765, 2496]);
        assert.equal(monthly.candidateCount, 1);
        assert.equal(monthly.games.length, 0);
        assert.equal(monthly.skippedCount, 1);
    });
});
