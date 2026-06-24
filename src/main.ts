import { PlaywrightCrawler, sleep } from 'crawlee';

const START_URL = 'https://go.cloudskillsboost.google/arcade';
const TIER_POINTS_SELECTOR = '.tier-points';
const SELECTOR_TIMEOUT_MS = 90_000;

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

        const data = await tierPoints.evaluateAll((elements) =>
            elements.map((element) => {
                const text = (element.textContent ?? '').trim();
                const firstNumber = text.match(/\d[\d,]*/)?.[0];

                return firstNumber
                    ? Number(firstNumber.replace(/,/g, ''))
                    : null;
            }),
        );

        await pushData({
            url: request.loadedUrl,
            selector: TIER_POINTS_SELECTOR,
            frameUrl: matchingFrame.url(),
            count: data.length,
            data,
        });

        log.info('Tier-points data collected. Crawler is stopping.', {
            url: request.loadedUrl,
            count: data.length,
            data,
        });
    },
});

await crawler.run([
    {
        url: START_URL,
        uniqueKey: `arcade-tier-points-${Date.now()}`,
    },
]);
