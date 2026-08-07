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
const MONTHLY_CARD_SELECTOR = '.shuffle-item';
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

function cleanText(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
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
        let monthlyCandidateCount = 0;
        let monthlySkippedCount = 0;

        while (
            Date.now() < timeoutAt
            && (!spotsLeft || (monthlyGames.length === 0 && monthlyCandidateCount === 0))
        ) {
            for (const frame of page.frames()) {
                try {
                    if (!spotsLeft) {
                        const tierTexts = await frame
                            .locator(TIER_POINTS_SELECTOR)
                            .allTextContents();

                        if (tierTexts.length > 0) {
                            matchingFrameUrl = frame.url();
                            spotsLeft = tierTexts.map((text) => {
                                const firstNumber = cleanText(text).match(/\d[\d,]*/)?.[0];
                                return firstNumber
                                    ? Number(firstNumber.replace(/,/g, ''))
                                    : null;
                            });
                        }
                    }

                    if (monthlyGames.length === 0 && monthlyCandidateCount === 0) {
                        const cards = frame.locator(MONTHLY_CARD_SELECTOR);
                        const candidateCount = await cards.count();

                        if (candidateCount > 0) {
                            const extractedGames: MonthlyArcadeGame[] = [];
                            let skippedCount = 0;

                            for (let index = 0; index < candidateCount; index += 1) {
                                const card = cards.nth(index);
                                const text = cleanText(await card.textContent());
                                const title = cleanText(
                                    await card.locator('.card-title').first().textContent(),
                                );
                                const accessCode = text.match(
                                    /Access\s*code\s*:\s*([a-z0-9-]+)/i,
                                )?.[1] ?? null;
                                const pointsMatch = text.match(
                                    /Arcade\s*points?\s*:\s*(\d+)/i,
                                );

                                const startButtons = card.locator('a[href] > button');
                                const startButtonCount = await startButtons.count();
                                let joinUrl: string | null = null;

                                for (
                                    let buttonIndex = 0;
                                    buttonIndex < startButtonCount;
                                    buttonIndex += 1
                                ) {
                                    const button = startButtons.nth(buttonIndex);
                                    if (/^START!?$/i.test(cleanText(await button.textContent()))) {
                                        joinUrl = await button.locator('..').getAttribute('href');
                                        break;
                                    }
                                }

                                if (!title || !accessCode || !pointsMatch || !joinUrl) {
                                    if (title || accessCode || pointsMatch || joinUrl) {
                                        skippedCount += 1;
                                    }
                                    continue;
                                }

                                const imageUrl = await card
                                    .locator('img.card-img-top[src], img[src]')
                                    .first()
                                    .getAttribute('src');
                                const deadline = text.match(
                                    /Deadline\s*:\s*(.*?)(?=Access\s*code|Arcade\s*points?|START!?|$)/i,
                                )?.[1]?.trim() ?? null;

                                extractedGames.push({
                                    title,
                                    imageUrl: normalizeUrl(imageUrl, frame.url()),
                                    accessCode,
                                    deadline,
                                    points: Number(pointsMatch[1]),
                                    joinUrl: normalizeUrl(joinUrl, frame.url()),
                                });
                            }

                            monthlyCandidateCount += candidateCount;
                            monthlySkippedCount += skippedCount;
                            monthlyGames.push(...extractedGames);
                        }
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

            if (!spotsLeft || (monthlyGames.length === 0 && monthlyCandidateCount === 0)) {
                await sleep(1_000);
            }
        }

        if (!spotsLeft) {
            await mkdir('storage', { recursive: true });
            const title = await page.title();
            const bodyText = cleanText(await page.locator('body').textContent()).slice(0, 2_000);
            await page.screenshot({
                path: 'storage/arcade-selector-not-found.png',
                fullPage: true,
            });

            throw new Error(
                `Không tìm thấy ${TIER_POINTS_SELECTOR}. `
                + `URL: ${page.url()}; title: ${title}; body: ${bodyText}; `
                + 'screenshot: storage/arcade-selector-not-found.png',
            );
        }
        if (spotsLeft.length !== TIERS.length || spotsLeft.some((value) => value === null)) {
            throw new Error(`Dữ liệu tier không hợp lệ: ${JSON.stringify(spotsLeft)}`);
        }

        monthlyGames = Array.from(
            new Map(monthlyGames.map((game) => [
                `${game.title}|${game.accessCode ?? ''}`,
                game,
            ])).values(),
        );

        const milestones = TIERS.map((tier, index) => ({
            ...tier,
            spotsLeft: spotsLeft[index] as number,
        }));

        await mkdir('data', { recursive: true });
        await writeFile(
            MILESTONES_FILE,
            `${JSON.stringify(milestones, null, 2)}\n`,
            'utf8',
        );

        if (monthlyGames.length > 0) {
            await writeFile(
                MONTHLY_GAMES_FILE,
                `${JSON.stringify(monthlyGames, null, 2)}\n`,
                'utf8',
            );
        } else {
            log.warning(
                'Monthly Arcade games were not extracted; keeping the previous monthly data file.',
                {
                    candidateCount: monthlyCandidateCount,
                    skippedCount: monthlySkippedCount,
                },
            );
        }

        const publishedTemplate = SHOULD_PUBLISH_REMOTE_CONFIG
            ? await publishToRemoteConfig(milestones)
            : undefined;

        await pushData({
            url: request.loadedUrl,
            frameUrl: matchingFrameUrl,
            milestones,
            monthlyGames,
            monthlyExtraction: {
                found: monthlyGames.length > 0,
                candidateCount: monthlyCandidateCount,
                skippedCount: monthlySkippedCount,
            },
            files: {
                milestones: MILESTONES_FILE,
                monthlyGames: monthlyGames.length > 0 ? MONTHLY_GAMES_FILE : null,
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
            monthlyCandidateCount,
            monthlySkippedCount,
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
