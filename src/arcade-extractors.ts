import type { Frame, Page } from 'playwright';

export const TIER_POINTS_SELECTOR = '.tier-points';
export const MONTHLY_CARD_SELECTOR = '.shuffle-item';
export const GAME_TITLE_SELECTOR = '#jump-content .game__title h1';
export const GAME_DETAILS_SELECTOR = '#jump-content .game__details';

export type MonthlyArcadeGame = {
    title: string;
    imageUrl: string | null;
    accessCode: string | null;
    deadline: string | null;
    points: number | null;
    joinUrl: string | null;
    spotsRemaining: number | null;
};

export type ArcadeGameDetails = {
    title: string | null;
    spotsRemaining: number | null;
};

export function cleanText(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeUrl(value: string | null, baseUrl: string): string | null {
    if (!value) return null;
    try {
        const url = new URL(value, baseUrl);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

export async function extractTierSpots(frame: Frame): Promise<Array<number | null>> {
    const texts = await frame.locator(TIER_POINTS_SELECTOR).allTextContents();
    return texts.map((text) => {
        const firstNumber = cleanText(text).match(/\d[\d,]*/)?.[0];
        return firstNumber ? Number(firstNumber.replace(/,/g, '')) : null;
    });
}

export async function extractMonthlyGames(frame: Frame) {
    const cards = frame.locator(MONTHLY_CARD_SELECTOR);
    const candidateCount = await cards.count();
    const games: MonthlyArcadeGame[] = [];
    let skippedCount = 0;

    for (let index = 0; index < candidateCount; index += 1) {
        const card = cards.nth(index);
        const text = cleanText(await card.textContent());
        const title = cleanText(await card.locator('.card-title').first().textContent());
        const accessCode = text.match(/Access\s*code\s*:\s*([a-z0-9-]+)/i)?.[1] ?? null;
        const pointsMatch = text.match(/Arcade\s*points?\s*:\s*(\d+)/i);
        const buttons = card.locator('a[href] > button');
        let joinUrl: string | null = null;

        for (let buttonIndex = 0; buttonIndex < await buttons.count(); buttonIndex += 1) {
            const button = buttons.nth(buttonIndex);
            if (/^START!?$/i.test(cleanText(await button.textContent()))) {
                joinUrl = await button.locator('..').getAttribute('href');
                break;
            }
        }

        if (!title || !accessCode || !pointsMatch || !joinUrl) {
            if (title || accessCode || pointsMatch || joinUrl) skippedCount += 1;
            continue;
        }

        const imageUrl = await card.locator('img.card-img-top[src], img[src]').first().getAttribute('src');
        const deadline = text.match(/Deadline\s*:\s*(.*?)(?=Access\s*code|Arcade\s*points?|START!?|$)/i)?.[1]?.trim() ?? null;

        games.push({
            title,
            imageUrl: normalizeUrl(imageUrl, frame.url()),
            accessCode,
            deadline,
            points: Number(pointsMatch[1]),
            joinUrl: normalizeUrl(joinUrl, frame.url()),
            spotsRemaining: null,
        });
    }

    return { games, candidateCount, skippedCount };
}

export async function extractGameDetails(page: Page): Promise<ArcadeGameDetails> {
    const title = cleanText(await page.locator(GAME_TITLE_SELECTOR).first().textContent());
    const detailsText = cleanText(await page.locator(GAME_DETAILS_SELECTOR).first().textContent());
    const spotsMatch = detailsText.match(/([\d,]+)\s+spots?\s+remaining/i);

    return {
        title: title || null,
        spotsRemaining: spotsMatch ? Number(spotsMatch[1].replace(/,/g, '')) : null,
    };
}
