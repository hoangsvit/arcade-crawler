import 'dotenv/config';

import { PlaywrightCrawler, sleep } from 'crawlee';
import { mkdir, writeFile } from 'node:fs/promises';

const START_URL = 'https://go.cloudskillsboost.google/arcade';
const OUTPUT_FILE = 'data/arcade_monthly_games.json';
const SELECTOR_TIMEOUT_MS = 90_000;

type MonthlyArcadeGame = {
    title: string;
    imageUrl: string | null;
    accessCode: string | null;
    deadline: string | null;
    points: number | null;
    joinUrl: string | null;
};

function normalizeUrl(value: string | null, baseUrl: string): string | null {
    if (!value) return null;

    try {
        const url = new URL(value, baseUrl);
        return url.protocol === 'http:' || url.protocol === 'https:'
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}

const crawler = new PlaywrightCrawler({
    maxRequestRetries: 3,
    maxRequestsPerCrawl: 1,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 150,
    useSessionPool: true,
    persistCookiesPerSession: false,
    preNavigationHooks: [
        async ({ request, session }, gotoOptions) => {
            if (request.retryCount > 0) {
                session?.retire();
                await sleep(request.retryCount * 3_000);
            }

            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60_000;
        },
    ],
    async requestHandler({ page, log }) {
        const timeoutAt = Date.now() + SELECTOR_TIMEOUT_MS;
        let games: MonthlyArcadeGame[] = [];

        while (Date.now() < timeoutAt && games.length === 0) {
            for (const frame of page.frames()) {
                try {
                    const extracted = await frame.locator('body').evaluate((body) => {
                        const clean = (value: string | null | undefined) =>
                            (value ?? '').replace(/\s+/g, ' ').trim();
                        const cards = Array.from(body.querySelectorAll<HTMLElement>('*'))
                            .filter((element) => {
                                const text = clean(element.textContent);
                                const hasStartButton = Array.from(element.querySelectorAll('a, button'))
                                    .some((item) => /Start Learning/i.test(clean(item.textContent)));
                                return hasStartButton
                                    && /Deadline\s*:/i.test(text)
                                    && /Arcade\s*Point(?:s)?\s*:/i.test(text)
                                    && text.length < 2_500;
                            })
                            .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);

                        return cards.map((card) => {
                            const text = clean(card.textContent);
                            const heading = card.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
                            const title = clean(heading?.textContent);
                            const accessCode = text.match(/\b[0-9a-z]+-[0-9a-z-]+\b/i)?.[0] ?? null;
                            const deadline = text.match(
                                /Deadline\s*:\s*(.*?)(?=Arcade\s*Point|Start Learning|$)/i,
                            )?.[1]?.trim() ?? null;
                            const points = Number(
                                text.match(/Arcade\s*Point(?:s)?\s*:\s*(\d+)/i)?.[1] ?? '',
                            );
                            const joinUrl = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
                                .find((item) => /Start Learning/i.test(clean(item.textContent)))?.href ?? null;
                            const imageUrl = card.querySelector<HTMLImageElement>('img[src]')?.src ?? null;

                            return {
                                title,
                                imageUrl,
                                accessCode,
                                deadline,
                                points: Number.isFinite(points) ? points : null,
                                joinUrl,
                            };
                        }).filter((game) => game.title);
                    });

                    games.push(...extracted.map((game) => ({
                        ...game,
                        imageUrl: normalizeUrl(game.imageUrl, frame.url()),
                        joinUrl: normalizeUrl(game.joinUrl, frame.url()),
                    })));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (
                        message.includes('Frame was detached')
                        || message.includes('Execution context was destroyed')
                    ) {
                        continue;
                    }
                    throw error;
                }
            }

            if (games.length === 0) await sleep(1_000);
        }

        games = Array.from(
            new Map(games.map((game) => [
                `${game.title}|${game.accessCode ?? ''}|${game.deadline ?? ''}`,
                game,
            ])).values(),
        );

        if (games.length === 0) {
            throw new Error('Không tìm thấy danh sách lab Arcade tháng hiện tại.');
        }

        await mkdir('data', { recursive: true });
        await writeFile(OUTPUT_FILE, `${JSON.stringify(games, null, 2)}\n`, 'utf8');

        log.info('Monthly Arcade games collected.', {
            count: games.length,
            outputFile: OUTPUT_FILE,
        });
    },
});

await crawler.run([{ url: START_URL }]);
