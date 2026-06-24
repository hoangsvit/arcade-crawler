import 'dotenv/config';

import { PlaywrightCrawler, sleep } from 'crawlee';
import {
    applicationDefault,
    cert,
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

const TIERS = [
    { points: 50, league: 'Arcade Trooper', slots: 6000 },
    { points: 75, league: 'Arcade Ranger', slots: 4000 },
    { points: 95, league: 'Arcade Champion', slots: 3000 },
    { points: 120, league: 'Arcade Legend', slots: 2500 },
] as const;

function initializeFirebase() {
    if (getApps().length > 0) return;

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

    initializeApp({
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
    initializeFirebase();

    const remoteConfig = getRemoteConfig();
    const template = await remoteConfig.getTemplate();

    template.parameters[REMOTE_CONFIG_PARAMETER_KEY] = {
        defaultValue: {
            value: JSON.stringify(data),
        },
        description: 'Google Cloud Skills Boost Arcade prize tiers',
        valueType: 'JSON',
    };
    template.version = {
        description: `Update ${REMOTE_CONFIG_PARAMETER_KEY} from Arcade crawler`,
    };

    return remoteConfig.publishTemplate(template);
}

const crawler = new PlaywrightCrawler({
    maxRequestRetries: 0,
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: 120,
    preNavigationHooks: [
        async (_context, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
        },
    ],
    async requestHandler({ request, page, log, pushData }) {
        const deadline = Date.now() + SELECTOR_TIMEOUT_MS;
        let matchingFrame = page.mainFrame();
        let tierPoints = matchingFrame.locator(TIER_POINTS_SELECTOR);

        while (Date.now() < deadline) {
            for (const frame of page.frames()) {
                const locator = frame.locator(TIER_POINTS_SELECTOR);

                if ((await locator.count()) > 0) {
                    matchingFrame = frame;
                    tierPoints = locator;
                    break;
                }
            }

            if ((await tierPoints.count()) > 0) break;
            await sleep(1_000);
        }

        const count = await tierPoints.count();

        if (count === 0) {
            const title = await page.title();
            const bodyText = ((await page.locator('body').textContent()) ?? '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 2_000);

            await page.screenshot({
                path: 'storage/arcade-selector-not-found.png',
                fullPage: true,
            });

            throw new Error(
                `Không tìm thấy ${TIER_POINTS_SELECTOR}. ` +
                `URL: ${page.url()}; title: ${title}; body: ${bodyText}`,
            );
        }

        const spotsLeft = await tierPoints.evaluateAll((elements) =>
            elements.map((element) => {
                const text = (element.textContent ?? '').trim();
                const firstNumber = text.match(/\d[\d,]*/)?.[0];

                return firstNumber
                    ? Number(firstNumber.replace(/,/g, ''))
                    : null;
            }),
        );

        if (
            spotsLeft.length !== TIERS.length ||
            spotsLeft.some((value) => value === null)
        ) {
            throw new Error(
                `Dữ liệu tier không hợp lệ: ${JSON.stringify(spotsLeft)}`,
            );
        }

        const data = TIERS.map((tier, index) => ({
            ...tier,
            spotsLeft: spotsLeft[index] as number,
        }));
        const publishedTemplate = SHOULD_PUBLISH_REMOTE_CONFIG
            ? await publishToRemoteConfig(data)
            : undefined;

        await pushData({
            url: request.loadedUrl,
            selector: TIER_POINTS_SELECTOR,
            frameUrl: matchingFrame.url(),
            count: data.length,
            data,
            remoteConfig: {
                published: SHOULD_PUBLISH_REMOTE_CONFIG,
                parameterKey: REMOTE_CONFIG_PARAMETER_KEY,
                version: publishedTemplate?.version?.versionNumber,
            },
        });

        log.info(
            SHOULD_PUBLISH_REMOTE_CONFIG
                ? 'Arcade tiers published to Firebase Remote Config.'
                : 'Arcade tiers collected without publishing Remote Config.',
        {
            url: request.loadedUrl,
            count: data.length,
            data,
            published: SHOULD_PUBLISH_REMOTE_CONFIG,
            parameterKey: REMOTE_CONFIG_PARAMETER_KEY,
            version: publishedTemplate?.version?.versionNumber,
        },
        );
    },
});

await crawler.run([
    {
        url: START_URL,
        uniqueKey: `arcade-tier-points-${Date.now()}`,
    },
]);
