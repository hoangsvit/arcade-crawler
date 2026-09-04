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
import {
    cleanText,
    extractGameDetails,
    extractHistoricalMonthlyGames,
    extractMonthlyGames,
    extractTierSpots,
    TIER_POINTS_SELECTOR,
    type MonthlyArcadeGame,
} from './arcade-extractors.js';
import {
    MONTHLY_GAMES_ARCHIVE_DIR,
    persistMonthlyGameArchives,
    persistMonthlyGames,
} from './monthly-games-archive.js';

const START_URL = 'https://go.cloudskillsboost.google/arcade';
const SELECTOR_TIMEOUT_MS = 90_000;
const GAME_DETAIL_TIMEOUT_MS = 15_000;
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
    const projectId = process.env.FIREBASE_PROJECT_ID ?? rawServiceAccount?.project_id;

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
    const currentDefaultValue = template.parameters[REMOTE_CONFIG_PARAMETER_KEY]?.defaultValue;
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
            message.includes('ERR_EMPTY_RESPONSE')
            || message.includes('ERR_CONNECTION_RESET')
            || message.includes('ERR_TIMED_OUT')
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
        let historicalGames: MonthlyArcadeGame[] = [];
        let historicalCandidateCount = 0;
        let historicalSkippedCount = 0;

        while (
            Date.now() < timeoutAt
            && (!spotsLeft || (monthlyGames.length === 0 && monthlyCandidateCount === 0))
        ) {
            for (const frame of page.frames()) {
                try {
                    if (!spotsLeft) {
                        const values = await extractTierSpots(frame);
                        if (values.length > 0) {
                            matchingFrameUrl = frame.url();
                            spotsLeft = values;
                        }
                    }

                    if (monthlyGames.length === 0 && monthlyCandidateCount === 0) {
                        const extracted = await extractMonthlyGames(frame);
                        if (extracted.candidateCount > 0) {
                            monthlyCandidateCount += extracted.candidateCount;
                            monthlySkippedCount += extracted.skippedCount;
                            monthlyGames.push(...extracted.games);
                        }
                    }

                    if (historicalGames.length === 0 && historicalCandidateCount === 0) {
                        const historical = await extractHistoricalMonthlyGames(frame);
                        if (historical.candidateCount > 0) {
                            historicalCandidateCount += historical.candidateCount;
                            historicalSkippedCount += historical.skippedCount;
                            historicalGames.push(...historical.games);
                        }
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
        historicalGames = Array.from(
            new Map(historicalGames.map((game) => [
                `${game.month ?? ''}|${game.title}|${game.joinUrl ?? ''}`,
                game,
            ])).values(),
        );

        const milestones = TIERS.map((tier, index) => ({
            ...tier,
            spotsLeft: spotsLeft[index] as number,
        }));

        // Tier data is critical. Persist and publish it before any optional game-detail enrichment.
        await mkdir('data', { recursive: true });
        await writeFile(MILESTONES_FILE, `${JSON.stringify(milestones, null, 2)}\n`, 'utf8');

        const publishedTemplate = SHOULD_PUBLISH_REMOTE_CONFIG
            ? await publishToRemoteConfig(milestones)
            : undefined;

        let monthlyDetailFailedCount = 0;
        const archiveFiles = new Set<string>();

        // Historical cards are append-only source data. Persist them first, then let
        // richer current-month entries update the same archive record where possible.
        for (const file of await persistMonthlyGameArchives(
            historicalGames,
            MONTHLY_GAMES_ARCHIVE_DIR,
        )) {
            archiveFiles.add(file);
        }

        if (monthlyGames.length > 0) {
            const detailPage = await page.context().newPage();
            try {
                for (let index = 0; index < monthlyGames.length; index += 1) {
                    const game = monthlyGames[index];
                    if (!game.joinUrl) {
                        monthlyDetailFailedCount += 1;
                        continue;
                    }

                    try {
                        await detailPage.goto(game.joinUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: GAME_DETAIL_TIMEOUT_MS,
                        });

                        const details = await extractGameDetails(detailPage);
                        monthlyGames[index] = {
                            ...game,
                            title: details.title ?? game.title,
                            deadline: details.deadline ?? game.deadline,
                            description: details.description ?? game.description,
                            spotsRemaining: details.spotsRemaining,
                        };
                    } catch (error) {
                        monthlyDetailFailedCount += 1;
                        log.warning('Arcade game detail enrichment failed; keeping card data.', {
                            joinUrl: game.joinUrl,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            } finally {
                await detailPage.close();
            }

            for (const file of await persistMonthlyGames(
                monthlyGames,
                MONTHLY_GAMES_FILE,
                MONTHLY_GAMES_ARCHIVE_DIR,
            )) {
                archiveFiles.add(file);
            }
        } else {
            log.warning(
                'Monthly Arcade games were not extracted; keeping the previous monthly data file.',
                {
                    candidateCount: monthlyCandidateCount,
                    skippedCount: monthlySkippedCount,
                },
            );
        }

        if (historicalGames.length === 0) {
            log.warning('Historical Arcade game cards were not extracted; existing archives are unchanged.', {
                candidateCount: historicalCandidateCount,
                skippedCount: historicalSkippedCount,
            });
        }

        const monthlyArchiveFiles = [...archiveFiles].sort();

        await pushData({
            url: request.loadedUrl,
            frameUrl: matchingFrameUrl,
            milestones,
            monthlyGames,
            historicalGames,
            monthlyExtraction: {
                found: monthlyGames.length > 0,
                candidateCount: monthlyCandidateCount,
                skippedCount: monthlySkippedCount,
                detailFailedCount: monthlyDetailFailedCount,
            },
            historicalExtraction: {
                found: historicalGames.length > 0,
                candidateCount: historicalCandidateCount,
                skippedCount: historicalSkippedCount,
            },
            files: {
                milestones: MILESTONES_FILE,
                monthlyGames: monthlyGames.length > 0 ? MONTHLY_GAMES_FILE : null,
                monthlyGameArchives: monthlyArchiveFiles,
            },
            remoteConfig: {
                published: SHOULD_PUBLISH_REMOTE_CONFIG,
                changed: publishedTemplate?.changed ?? false,
                projectId: publishedTemplate?.projectId,
                parameterKey: REMOTE_CONFIG_PARAMETER_KEY,
                version: publishedTemplate?.version,
            },
        });

        log.info('Arcade data collected.', {
            url: request.loadedUrl,
            milestoneCount: milestones.length,
            monthlyGameCount: monthlyGames.length,
            historicalGameCount: historicalGames.length,
            monthlyArchiveCount: monthlyArchiveFiles.length,
            monthlyCandidateCount,
            monthlySkippedCount,
            monthlyDetailFailedCount,
            historicalCandidateCount,
            historicalSkippedCount,
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
