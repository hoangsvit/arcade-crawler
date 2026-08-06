import 'dotenv/config';

import { PlaywrightCrawler, sleep } from 'crawlee';
import { mkdir, writeFile } from 'node:fs/promises';

const START_URL = 'https://go.cloudskillsboost.google/arcade';
const OUTPUT_FILE = 'data/arcade_monthly_games.json';
const SELECTOR_TIMEOUT_MS = 90_000;

type MonthlyArcadeGame = {
    id: string;
    title: string;
    type: string | null;
    imageUrl: string | null;
    accessCode: string | null;
    deadlineText: string | null;
    points: number | null;
    joinUrl: string | null;
    sourceFrameUrl: string;
};

function slugify(value: string): string {
    return value
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

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

function parsePoints(value: string): number | null {
    const match = value.match(/Arcade\s*Point(?:s)?\s*:\s*(\d+)/i);
    return match ? Number(match[1]) : null;
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
    async requestHandler({ request, page, log, pushData }) {
        const deadline = Date.now() + SELECTOR_TIMEOUT_MS;
        let games: MonthlyArcadeGame[] = [];

        while (Date.now() < deadline && games.length === 0) {
            for (const frame of page.frames()) {
                try {
                    const extracted = await frame.locator('body').evaluate((body) => {
                        const clean = (value: string | null | undefined) =>
                            (value ?? '').replace(/\s+/g, ' ').trim();
                        const candidates = Array.from(body.querySelectorAll<HTMLElement>('*'))
                            .filter((element) => {
                                const text = clean(element.textContent);
                                return /Deadline\s*:/i.test(text)
                                    && /Arcade\s*Point(?:s)?\s*:/i.test(text);
                            })
                            .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);

                        const cards: Array<{
                            title: string;
                            type: string | null;
                            imageUrl: string | null;
                            accessCode: string | null;
                            deadlineText: string | null;
                            pointsText: string;
                            joinUrl: string | null;
                        }> = [];
                        const seen = new Set<string>();

                        for (const candidate of candidates) {
                            let card: HTMLElement | null = candidate;
                            while (card?.parentElement) {
                                const text = clean(card.textContent);
                                const hasAction = Array.from(card.querySelectorAll('a, button'))
                                    .some((element) => /Start Learning/i.test(clean(element.textContent)));
                                if (hasAction && text.length < 2_500) break;
                                card = card.parentElement;
                            }
                            if (!card) continue;

                            const text = clean(card.textContent);
                            const heading = card.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
                            const title = clean(heading?.textContent)
                                || clean(Array.from(card.querySelectorAll<HTMLElement>('strong, b'))
                                    .find((element) => {
                                        const value = clean(element.textContent);
                                        return value.length > 8
                                            && !/Deadline|Arcade\s*Point|Start Learning/i.test(value);
                                    })?.textContent);
                            if (!title) continue;

                            const deadlineMatch = text.match(
                                /Deadline\s*:\s*(.*?)(?=Arcade\s*Point|Start Learning|$)/i,
                            );
                            const pointMatch = text.match(/Arcade\s*Point(?:s)?\s*:\s*\d+/i);
                            const codeElement = Array.from(
                                card.querySelectorAll<HTMLElement>('code, pre, input, span, div'),
                            ).find((element) => {
                                const value = clean(
                                    element instanceof HTMLInputElement
                                        ? element.value
                                        : element.textContent,
                                );
                                return /\b[0-9a-z]+-[0-9a-z-]+\b/i.test(value)
                                    && value.length < 100;
                            });
                            const codeText = clean(
                                codeElement instanceof HTMLInputElement
                                    ? codeElement.value
                                    : codeElement?.textContent,
                            );
                            const accessCode = codeText.match(/\b[0-9a-z]+-[0-9a-z-]+\b/i)?.[0]
                                ?? null;
                            const action = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
                                .find((element) => /Start Learning/i.test(clean(element.textContent)));
                            const image = card.querySelector<HTMLImageElement>('img[src]');
                            const typeElement = Array.from(card.querySelectorAll<HTMLElement>('span, div'))
                                .find((element) => /^(Game|Trivia|Special|Level)$/i.test(
                                    clean(element.textContent),
                                ));
                            const key = `${title}|${accessCode ?? ''}|${deadlineMatch?.[1] ?? ''}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            cards.push({
                                title,
                                type: clean(typeElement?.textContent) || null,
                                imageUrl: image?.src ?? null,
                                accessCode,
                                deadlineText: clean(deadlineMatch?.[1]) || null,
                                pointsText: pointMatch?.[0] ?? '',
                                joinUrl: action?.href ?? null,
                            });
                        }

                        return cards;
                    });

                    if (extracted.length > 0) {
                        games.push(...extracted.map((game) => ({
                            id: slugify(game.accessCode || game.title),
                            title: game.title,
                            type: game.type,
                            imageUrl: normalizeUrl(game.imageUrl, frame.url()),
                            accessCode: game.accessCode,
                            deadlineText: game.deadlineText,
                            points: parsePoints(game.pointsText),
                            joinUrl: normalizeUrl(game.joinUrl, frame.url()),
                            sourceFrameUrl: frame.url(),
                        })));
                    }
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
                `${game.title}|${game.accessCode ?? ''}|${game.deadlineText ?? ''}`,
                game,
            ])).values(),
        );

        if (games.length === 0) {
            await mkdir('storage', { recursive: true });
            await page.screenshot({
                path: 'storage/arcade-monthly-cards-not-found.png',
                fullPage: true,
            });
            await writeFile(
                'storage/arcade-monthly-page.html',
                await page.content(),
                'utf8',
            );
            throw new Error(
                `Không tìm thấy card Arcade tháng. URL: ${page.url()}; title: ${await page.title()}`,
            );
        }

        const payload = {
            schemaVersion: 1,
            fetchedAt: new Date().toISOString(),
            sourceUrl: request.loadedUrl ?? request.url,
            games,
        };

        await mkdir('data', { recursive: true });
        await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await pushData(payload);

        log.info('Monthly Arcade catalog collected.', {
            count: games.length,
            outputFile: OUTPUT_FILE,
            games,
        });
    },
});

await crawler.run([
    {
        url: START_URL,
        uniqueKey: `arcade-monthly-games-${Date.now()}`,
    },
]);
