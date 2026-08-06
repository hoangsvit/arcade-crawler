import 'dotenv/config';

import { PlaywrightCrawler, sleep } from 'crawlee';
import { mkdir, writeFile } from 'node:fs/promises';
import {
    applicationDefault,
    cert,
    getApp,
    getApps,
    initializeApp,
} from 'firebase-admin/app';
import { getRemoteConfig } from 'firebase-admin/remote-config';

const START_URL = 'https://go.cloudskillsboost.google/arcade';
const TIER_POINTS_SELECTOR = '.tier-points';
const SELECTOR_TIMEOUT_MS = 90_000;
const REMOTE_CONFIG_PARAMETER_KEY =
    process.env.FIREBASE_REMOTE_CONFIG_KEY ?? 'arcade_milestones';
const SHOULD_PUBLISH_REMOTE_CONFIG =
    process.env.PUBLISH_REMOTE_CONFIG?.toLowerCase() === 'true';
const MILESTONES_FILE = 'data/arcade_milestones.json';
const MONTHLY_GAMES_FILE = 'data/arcade_monthly_games.json';

const TIERS = [
    { points: 50, league: 'Arcade Trooper', slots: 6000 },
    { points: 75, league: 'Arcade Ranger', slots: 4000 },
    { points: 95, league: 'Arcade Champion', slots: 3000 },
    { points: 120, league: 'Arcade Legend', slots: 2500 },
] as const;

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

function initializeFirebase() {
    if (getApps().length > 0) return getApp();

    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const rawServiceAccount = serviceAccountJson
        ? JSON.parse(serviceAccountJson) as {
            project_id: string;
            client_email: string;
            private_key: string;
        }
        : undefined;
    const projectId =
        process.env.FIREBASE_PROJECT_ID ?? rawServiceAccount?.project_id;

    return initializeApp({
        credential: rawServiceAccount
            ? cert({
                projectId: rawServiceAccount.project_id,
                clientEmail: rawServiceAccount.client_email,
                privateKey: rawServiceAccount.private_key.replace(/\\n/g, '\n'),
            })
            : applicationDefault(),
        ...(projectId ? { projectId } : {}),
    });
}

async function publishToRemoteConfig(data: unknown) {
    const app = initializeFirebase();
    const remoteConfig = getRemoteConfig(app);
    const template = await remoteConfig.getTemplate();
    const nextValue = JSON.stringify(data);
    const currentDefaultValue =
        template.parameters[REMOTE_CONFIG_PARAMETER_KEY]?.defaultValue;
    const currentValue =
        currentDefaultValue && 'value' in currentDefaultValue
            ? currentDefaultValue.value
            : undefined;

    if (currentValue === nextValue) {
        return {
            changed: false,
            projectId: app.options.projectId,
            version: template.version?.versionNumber,
        };
    }

    template.parameters[REMOTE_CONFIG_PARAMETER_KEY] = {
        defaultValue: { value: nextValue },
        description: 'Google Cloud Skills Boost Arcade prize tiers',
        valueType: 'JSON',
    };
    template.version = {
        description: `Update ${REMOTE_CONFIG_PARAMETER_KEY} from Arcade crawler`,
    };

    const publishedTemplate = await remoteConfig.publishTemplate(template);
    return {
        changed: true,
        projectId: app.options.projectId,
        version: publishedTemplate.version?.versionNumber,
    };
}

const crawler = new PlaywrightCrawler({
    maxRequestRetries: 3,
    maxRequestsPerCrawl: 1,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
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
    errorHandler: async ({ request, session, log }, error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (
            message.includes('ERR_EMPTY_RESPONSE') ||
            message.includes('ERR_CONNECTION_RESET') ||
            message.includes('ERR_TIMED_OUT')
        ) {
            session?.retire();
        }

        log.warning('Arcade request failed; Crawlee will retry.', {
            url: request.url,
            retryCount: request.retryCount,
            error: message,
        });
    },
    async requestHandler({ request, page, log, pushData }) {
        const timeoutAt = Date.now() + SELECTOR_TIMEOUT_MS;
        let matchingFrameUrl: string | undefined;
        let spotsLeft: Array<number | null> | undefined;
        let monthlyGames: MonthlyArcadeGame[] = [];

        while (Date.now() < timeoutAt && (!spotsLeft || monthlyGames.length === 0)) {
            for (const frame of page.frames()) {
                try {
                    if (!spotsLeft) {
                        const values = await frame.locator(TIER_POINTS_SELECTOR).evaluateAll((elements) =>
                            elements.map((element) => {
                                const text = (element.textContent ?? '').trim();
                                const firstNumber = text.match(/\d[\d,]*/)?.[0];
                                return firstNumber
                                    ? Number(firstNumber.replace(/,/g, ''))
                                    : null;
                            }),
                        );

                        if (values.length > 0) {
                            matchingFrameUrl = frame.url();
                            spotsLeft = values;
                        }
                    }

                    if (monthlyGames.length === 0) {
                        const extracted = await frame.locator('body').evaluate((body) => {
                            const clean = (value: string | null | undefined) =>
                                (value ?? '').replace(/\s+/g, ' ').trim();
                            const accessCodePattern = /\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)+\b/i;
                            const actions = Array.from(body.querySelectorAll<HTMLElement>('a, button'))
                                .filter((item) => /Start Learning/i.test(clean(item.textContent)));
                            const cards: HTMLElement[] = [];

                            for (const action of actions) {
                                let card: HTMLElement | null = action;
                                while (card && card !== body) {
                                    const text = clean(card.textContent);
                                    if (
                                        /Deadline\s*:/i.test(text)
                                        && /Arcade\s*Point(?:s)?\s*:/i.test(text)
                                        && text.length < 2_500
                                    ) {
                                        cards.push(card);
                                        break;
                                    }
                                    card = card.parentElement;
                                }
                            }

                            return Array.from(new Set(cards)).map((card) => {
                                const text = clean(card.textContent);
                                const heading = card.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
                                const title = clean(heading?.textContent);
                                const codeElement = Array.from(
                                    card.querySelectorAll<HTMLElement>('code, pre, input, [data-code], [class*="code"]'),
                                ).find((element) => {
                                    const value = element instanceof HTMLInputElement
                                        ? element.value
                                        : element.textContent;
                                    return accessCodePattern.test(clean(value));
                                });
                                const codeText = codeElement instanceof HTMLInputElement
                                    ? codeElement.value
                                    : codeElement?.textContent;
                                const accessCode = clean(codeText).match(accessCodePattern)?.[0] ?? null;
                                const deadline = text.match(
                                    /Deadline\s*:\s*(.*?)(?=Arcade\s*Point|Start Learning|$)/i,
                                )?.[1]?.trim() ?? null;
                                const pointsMatch = text.match(
                                    /Arcade\s*Point(?:s)?\s*:\s*(\d+)/i,
                                );
                                const joinUrl = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
                                    .find((item) => /Start Learning/i.test(clean(item.textContent)))?.href ?? null;
                                const imageUrl = card.querySelector<HTMLImageElement>('img[src]')?.src ?? null;

                                return {
                                    title,
                                    imageUrl,
                                    accessCode,
                                    deadline,
                                    points: pointsMatch ? Number(pointsMatch[1]) : null,
                                    joinUrl,
                                };
                            }).filter((game) => game.title);
                        });

                        monthlyGames.push(...extracted.map((game) => ({
                            ...game,
                            imageUrl: normalizeUrl(game.imageUrl, frame.url()),
                            joinUrl: normalizeUrl(game.joinUrl, frame.url()),
                        })));
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (
                        message.includes('Frame was detached') ||
                        message.includes('Execution context was destroyed')
                    ) {
                        continue;
                    }
                    throw error;
                }
            }

            if (!spotsLeft || monthlyGames.length === 0) await sleep(1_000);
        }

        if (!spotsLeft) {
            throw new Error(`Không tìm thấy ${TIER_POINTS_SELECTOR}. URL: ${page.url()}`);
        }
        if (spotsLeft.length !== TIERS.length || spotsLeft.some((value) => value === null)) {
            throw new Error(`Dữ liệu tier không hợp lệ: ${JSON.stringify(spotsLeft)}`);
        }
        if (monthlyGames.length === 0) {
            throw new Error('Không tìm thấy danh sách lab Arcade tháng hiện tại.');
        }

        monthlyGames = Array.from(
            new Map(monthlyGames.map((game) => [
                `${game.title}|${game.accessCode ?? ''}|${game.deadline ?? ''}`,
                game,
            ])).values(),
        );

        const milestones = TIERS.map((tier, index) => ({
            ...tier,
            spotsLeft: spotsLeft[index] as number,
        }));

        await mkdir('data', { recursive: true });
        await Promise.all([
            writeFile(MILESTONES_FILE, `${JSON.stringify(milestones, null, 2)}\n`, 'utf8'),
            writeFile(MONTHLY_GAMES_FILE, `${JSON.stringify(monthlyGames, null, 2)}\n`, 'utf8'),
        ]);

        const publishedTemplate = SHOULD_PUBLISH_REMOTE_CONFIG
            ? await publishToRemoteConfig(milestones)
            : undefined;

        await pushData({
            url: request.loadedUrl,
            frameUrl: matchingFrameUrl,
            milestones,
            monthlyGames,
            files: {
                milestones: MILESTONES_FILE,
                monthlyGames: MONTHLY_GAMES_FILE,
            },
            remoteConfig: {
                published: SHOULD_PUBLISH_REMOTE_CONFIG,
                changed: publishedTemplate?.changed ?? false,
                projectId: publishedTemplate?.projectId,
                parameterKey: REMOTE_CONFIG_PARAMETER_KEY,
                version: publishedTemplate?.version,
            },
        });

        log.info('Arcade data collected from a single page load.', {
            url: request.loadedUrl,
            milestoneCount: milestones.length,
            monthlyGameCount: monthlyGames.length,
            published: SHOULD_PUBLISH_REMOTE_CONFIG,
            changed: publishedTemplate?.changed ?? false,
        });
    },
});

await crawler.run([
    {
        url: START_URL,
        uniqueKey: `arcade-data-${Date.now()}`,
    },
]);
