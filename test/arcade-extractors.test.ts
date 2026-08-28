import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import {
    ARCADE_TIME_ZONE,
    extractGameDetails,
    extractMonthlyGames,
    extractTierSpots,
} from '../src/arcade-extractors.js';

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
    description?: string;
    wide?: boolean;
}) {
    return `
        <div class="${options.wide ? 'dark-back pt-4 py-3 ' : 'col-md-3 mb-3 '}shuffle-item">
            <div class="${options.wide ? 'container' : ''}">
                <h3 class="card-title">${options.title}</h3>
                <a href="https://www.skills.google/games/${options.gameId}">
                    <img class="card-img-top" src="${options.image}">
                </a>
                <p class="pt-2">${options.description ?? `Description for ${options.title}`}</p>
                <p><span>Access code:</span> ${options.code}</p>
                <p>Arcade points: ${options.points ?? 1}</p>
                <a href="https://www.skills.google/games/${options.gameId}?utm_source=googleskills&utm_medium=lp&utm_campaign=future-month&foo=bar">
                    <button>START!</button>
                </a>
            </div>
        </div>
    `;
}

test('monthly extraction does not depend on month or game names and normalizes join URLs', async () => {
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
        assert.deepEqual(
            result.games.map((game) => game.joinUrl),
            [
                'https://www.skills.google/games/8101?utm_source=hoangsvit',
                'https://www.skills.google/games/8102?utm_source=hoangsvit',
                'https://www.skills.google/games/8103?utm_source=hoangsvit',
            ],
        );
        assert.deepEqual(
            result.games.map((game) => game.description),
            [
                'Description for Arcade Nebula September 2026',
                'Description for Cloud Quest: October Edition',
                'Description for A Completely New Arcade Name',
            ],
        );
        assert.ok(result.games.every((game) => game.points === 1));
        assert.ok(result.games.every((game) => game.spotsRemaining === null));
        assert.ok(result.games.every((game) => game.deadlineTimeZone === ARCADE_TIME_ZONE));
    });
});

test('Arcade Re-Trail card copy is extracted as the canonical user-facing metadata', async () => {
    const retrailHtml = `
        <div id="game-shuffle-container">
            <div class="dark-back pt-4 py-3 shuffle-item" style="background-image: url('https://i.ibb.co/SRMTB41/BGimg-form.png');">
                <div class="container">
                    <div class="card scrollBox">
                        <div class="row g-0">
                            <div class="col-lg-6 align-items-center">
                                <div class="card-body">
                                    <a href="https://www.skills.google/games/7426?utm_source=googleskills&utm_medium=lp&utm_campaign=retrail-Aug-arcade26">
                                        <img src="https://services.google.com/fh/files/misc/arcade_retrail_aug2026.png" alt="cert camo" class="card-img-top specialBadge">
                                    </a>
                                </div>
                            </div>
                            <div class="col-lg-6 p-5">
                                <br>
                                <h3 class="card-title">Arcade Re-Trail</h3>
                                <br>
                                <p class="pt-2">Missed out when last month’s Arcade Trail ended early? No worries—we’re dropping a bonus run so you can grab that missed point, sharpen your storage and serverless skills, and keep your streak going!</p>
                                <br>
                                <p class="pt-2"><span style="color:#F5BB11;">Access code:</span> 1q-vaults-39213</p>
                                <p>Arcade points: 1</p>
                                <a href="https://www.skills.google/games/7426?utm_source=googleskills&utm_medium=lp&utm_campaign=retrail-Aug-arcade26">
                                    <button class="btn mt-1 subsBtn">START!</button>
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    await withPage(retrailHtml, async (page) => {
        const result = await extractMonthlyGames(page.mainFrame());

        assert.equal(result.candidateCount, 1);
        assert.equal(result.skippedCount, 0);
        assert.deepEqual(result.games[0], {
            title: 'Arcade Re-Trail',
            imageUrl: 'https://services.google.com/fh/files/misc/arcade_retrail_aug2026.png',
            accessCode: '1q-vaults-39213',
            deadline: null,
            deadlineTimeZone: ARCADE_TIME_ZONE,
            description: 'Missed out when last month’s Arcade Trail ended early? No worries—we’re dropping a bonus run so you can grab that missed point, sharpen your storage and serverless skills, and keep your streak going!',
            points: 1,
            joinUrl: 'https://www.skills.google/games/7426?utm_source=hoangsvit',
            spotsRemaining: null,
        });
    });
});

test('game detail extraction keeps canonical UTC instant for countdowns', async () => {
    const gameDetailHtml = `
        <div id="jump-content">
            <div class="game__title">
                <p class="ql-title-medium">Game</p>
                <h1 class="ql-display-large">Arcade Base Camp August 2026</h1>
            </div>
            <div class="game__details">
                <p class="ql-title-medium">
                    <ql-datetime millisecondssinceepoch="1785756931000"></ql-datetime>
                    —
                    <ql-datetime millisecondssinceepoch="1788197371000"></ql-datetime>
                    <br>
                    25 days remaining
                    <br>
                    1,472 spots remaining
                </p>
                <p>
                    Welcome to Base Camp, where you’ll develop key Google Cloud skills and earn an exclusive credential.
                </p>
            </div>
        </div>
    `;

    await withPage(gameDetailHtml, async (page) => {
        const details = await extractGameDetails(page);

        assert.deepEqual(details, {
            title: 'Arcade Base Camp August 2026',
            spotsRemaining: 1472,
            deadline: '2026-08-31T17:29:31.000Z',
            description: 'Welcome to Base Camp, where you’ll develop key Google Cloud skills and earn an exclusive credential.',
        });

        const formattedDeadline = new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: ARCADE_TIME_ZONE,
        }).format(new Date(details.deadline!));

        assert.equal(formattedDeadline, 'Aug 31, 2026, 10:59 PM');
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

test('missing game detail data does not affect tier extraction', async () => {
    await withPage(`${tierHtml}<div id="jump-content"></div>`, async (page) => {
        const tierSpots = await extractTierSpots(page.mainFrame());
        const details = await extractGameDetails(page);

        assert.deepEqual(tierSpots, [4052, 3413, 2765, 2496]);
        assert.deepEqual(details, {
            title: null,
            spotsRemaining: null,
            deadline: null,
            description: null,
        });
    });
});
