import type { Frame, Page } from 'playwright';

export const TIER_POINTS_SELECTOR = '.tier-points';
export const MONTHLY_CARD_SELECTOR = '.shuffle-item';
export const GAME_TITLE_SELECTOR = '#jump-content .game__title h1';
export const GAME_DETAILS_SELECTOR = '#jump-content .game__details';
export const GAME_DESCRIPTION_SELECTOR = '#jump-content .game__details p:not(.ql-title-medium)';
export const GAME_DATETIME_SELECTOR = '#jump-content .game__details ql-datetime[millisecondssinceepoch]';
export const ARCADE_TIME_ZONE = 'Asia/Kolkata';
export const OFFICIAL_ARCADE_SOURCE_URL = 'https://go.cloudskillsboost.google/arcade';

export type MonthlyArcadeGame = {
    title: string;
    imageUrl: string | null;
    accessCode: string | null;
    deadline: string | null;
    deadlineTimeZone: typeof ARCADE_TIME_ZONE;
    description: string | null;
    points: number | null;
    joinUrl: string | null;
    spotsRemaining: number | null;
    month?: string | null;
    rawTitle?: string | null;
    aliases?: string[];
    group?: string | null;
    source?: string | null;
    sourceUrl?: string | null;
    status?: string | null;
    reconstructed?: boolean;
};

export type ArcadeGameDetails = {
    title: string | null;
    spotsRemaining: number | null;
    deadline: string | null;
    description: string | null;
};

type HistoricalArcadeCard = {
    month: string | null;
    rawTitle: string;
    imageUrl: string | null;
    joinUrl: string | null;
    points: number | null;
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

export function normalizeGameJoinUrl(value: string | null, baseUrl: string): string | null {
    if (!value) return null;

    try {
        const url = new URL(value, baseUrl);
        const gameMatch = url.pathname.match(/^\/games\/(\d+)\/?$/);
        if (!gameMatch || url.hostname !== 'www.skills.google') return null;

        return `https://www.skills.google/games/${gameMatch[1]}?utm_source=hoangsvit`;
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

        const normalizedJoinUrl = normalizeGameJoinUrl(joinUrl, frame.url());
        if (!title || !accessCode || !pointsMatch || !normalizedJoinUrl) {
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
            deadlineTimeZone: ARCADE_TIME_ZONE,
            description: null,
            points: Number(pointsMatch[1]),
            joinUrl: normalizedJoinUrl,
            spotsRemaining: null,
            source: 'arcade_active_card',
            sourceUrl: OFFICIAL_ARCADE_SOURCE_URL,
            status: 'active',
            reconstructed: false,
        });
    }

    return { games, candidateCount, skippedCount };
}

/**
 * Extract the official "Game over" history section. Month comments in that
 * section are treated as the authoritative month boundaries. This lets the
 * crawler reconstruct Jan-Aug data even though the active monthly crawler was
 * introduced later in the year.
 */
export async function extractHistoricalMonthlyGames(frame: Frame, year = 2026) {
    const extracted = await frame.evaluate((targetYear): {
        cards: HistoricalArcadeCard[];
        candidateCount: number;
    } => {
        const container = document.querySelector('.goContainer');
        if (!container) return { cards: [], candidateCount: 0 };

        const months: Record<string, string> = {
            january: '01',
            february: '02',
            march: '03',
            april: '04',
            may: '05',
            june: '06',
            july: '07',
            august: '08',
            september: '09',
            october: '10',
            november: '11',
            december: '12',
        };
        const cards: HistoricalArcadeCard[] = [];
        let month = `${targetYear}-01`;
        let candidateCount = 0;

        const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
        const monthFromComment = (value: string) => {
            const normalized = value.toLowerCase();
            for (const [name, number] of Object.entries(months)) {
                if (normalized.includes(name.slice(0, 3)) || normalized.includes(name)) {
                    return `${targetYear}-${number}`;
                }
            }
            return null;
        };

        const walk = (node: Node) => {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType === Node.COMMENT_NODE) {
                    const detected = monthFromComment(child.nodeValue ?? '');
                    if (detected) month = detected;
                    continue;
                }

                if (!(child instanceof Element)) continue;

                if (child.classList.contains('col-lg-2')) {
                    const titleNode = child.querySelector('p.pt-5');
                    if (titleNode) {
                        candidateCount += 1;
                        const paragraphs = Array.from(child.querySelectorAll('p')).map((item) => clean(item.textContent));
                        const pointsText = paragraphs.find((text) => /^Arcade\s*points?\s*:/i.test(text)) ?? '';
                        const pointsMatch = pointsText.match(/^Arcade\s*points?\s*:\s*(\d+(?:\.\d+)?)/i);
                        cards.push({
                            month,
                            rawTitle: clean(titleNode.textContent),
                            imageUrl: child.querySelector('img[src]')?.getAttribute('src') ?? null,
                            joinUrl: child.querySelector('a[href*="/games/"]')?.getAttribute('href') ?? null,
                            points: pointsMatch ? Number(pointsMatch[1]) : null,
                        });
                        continue;
                    }
                }

                walk(child);
            }
        };

        walk(container);
        return { cards, candidateCount };
    }, year);

    const games: MonthlyArcadeGame[] = [];
    let skippedCount = 0;

    for (const card of extracted.cards) {
        if (!card.month || !/^\d{4}-\d{2}$/.test(card.month) || card.points === null || !card.rawTitle) {
            skippedCount += 1;
            continue;
        }

        const imageUrl = normalizeUrl(card.imageUrl, frame.url());
        const title = canonicalHistoricalTitle(card.rawTitle, card.month, imageUrl);
        const aliases = historicalAliases(title, card.rawTitle, card.month);

        games.push({
            title,
            rawTitle: card.rawTitle,
            aliases,
            imageUrl,
            accessCode: null,
            deadline: null,
            deadlineTimeZone: ARCADE_TIME_ZONE,
            description: null,
            points: card.points,
            joinUrl: normalizeGameJoinUrl(card.joinUrl, frame.url()),
            spotsRemaining: null,
            month: card.month,
            group: historicalGroup(title),
            source: 'official_google_skills_arcade_page',
            sourceUrl: OFFICIAL_ARCADE_SOURCE_URL,
            status: 'game_over',
            reconstructed: true,
        });
    }

    return {
        games,
        candidateCount: extracted.candidateCount,
        skippedCount,
    };
}

export async function extractGameDetails(page: Page): Promise<ArcadeGameDetails> {
    const titleLocator = page.locator(GAME_TITLE_SELECTOR).first();
    const detailsLocator = page.locator(GAME_DETAILS_SELECTOR).first();
    const descriptionLocator = page.locator(GAME_DESCRIPTION_SELECTOR).first();
    const dateTimeLocators = page.locator(GAME_DATETIME_SELECTOR);

    const title = await titleLocator.count() > 0
        ? cleanText(await titleLocator.textContent())
        : '';
    const detailsText = await detailsLocator.count() > 0
        ? cleanText(await detailsLocator.textContent())
        : '';
    const description = await descriptionLocator.count() > 0
        ? cleanText(await descriptionLocator.textContent())
        : '';
    const spotsMatch = detailsText.match(/([\d,]+)\s+spots?\s+remaining/i);

    let deadline: string | null = null;
    const dateTimeCount = await dateTimeLocators.count();
    if (dateTimeCount >= 2) {
        const rawDeadline = await dateTimeLocators.nth(1).getAttribute('millisecondssinceepoch');
        const deadlineMs = rawDeadline ? Number(rawDeadline) : Number.NaN;
        if (Number.isFinite(deadlineMs)) {
            // Keep the canonical deadline as an absolute UTC instant for countdowns.
            // Consumers must use ARCADE_TIME_ZONE when rendering the calendar date/time.
            deadline = new Date(deadlineMs).toISOString();
        }
    }

    return {
        title: title || null,
        spotsRemaining: spotsMatch ? Number(spotsMatch[1].replace(/,/g, '')) : null,
        deadline,
        description: description || null,
    };
}

function canonicalHistoricalTitle(rawTitle: string, month: string, imageUrl: string | null): string {
    const normalized = normalizeTitle(rawTitle);
    const image = (imageUrl ?? '').toLowerCase();
    const monthLabel = monthName(month);
    const year = month.slice(0, 4);

    if (month === '2026-06' && image.includes('arcade-spe-jun')) return 'Logic Log';
    if (month === '2026-06' && image.includes('arcade-wmp-june')) return 'Work Meets Play: Cloud Canvas';

    const fixed: Record<string, string> = {
        'arcade work life refresh': 'Work Life Refresh',
        'arcade a cloud that cares': 'Work Meets Play: A Cloud That Cares',
        'arcade journey made easy': 'Work Meets Play: Journeys Made Easy',
        'arcade from foundation to wonders': 'From Foundations To Wonders',
        'arcade skills at the pitch': 'Skills At The Pitch',
        'arcade holi istic infrastrectures': 'Holi-istic Infrastructures',
        'arcade matrics in motion': 'Work Meets Play: Metrics in Motion',
        'arcade skills spawn': 'Works Meet Play: Skills Spawn',
        'arcade expressive efficiency': 'Work Meets Play: Expressive Efficiency',
        'arcade skill up summer': 'Skill Up Summer',
    };
    if (fixed[normalized]) return fixed[normalized];

    if (/^arcade base camp(?: [a-z]+)?(?: \d{4})?$/.test(normalized)) {
        return month === '2026-01'
            ? 'Google Skills Arcade Base Camp January 2026'
            : `Arcade Base Camp ${monthLabel} ${year}`;
    }

    if (normalized === 'arcade certification zone') {
        return month === '2026-01'
            ? 'Google Skills Arcade Certification Zone January 2026'
            : `Arcade Certification Zone ${monthLabel} ${year}`;
    }

    const week = normalized.match(/^week (\d+) january 2026$/);
    if (week) return `Google Skills Arcade Trivia January 2026 Week ${week[1]}`;

    const sprint = normalized.match(/^sprint (\d+) ([a-z]+) 2026$/);
    if (sprint) return `Arcade ${monthLabel} ${year} Sprint ${sprint[1]}`;

    return cleanText(rawTitle);
}

function historicalAliases(title: string, rawTitle: string, month: string): string[] {
    const aliases = new Set<string>();
    if (normalizeTitle(title) !== normalizeTitle(rawTitle)) aliases.add(cleanText(rawTitle));

    const monthLabel = monthName(month);
    const year = month.slice(0, 4);
    const normalizedTitle = normalizeTitle(title);

    if (normalizedTitle.includes('base camp')) {
        aliases.add(`Arcade Base Camp ${monthLabel}`);
        aliases.add(`Base Camp ${monthLabel}`);
        aliases.add(`Google Skills Arcade Base Camp ${monthLabel} ${year}`);
    }
    if (normalizedTitle.includes('certification zone')) {
        aliases.add('Arcade Certification Zone');
        aliases.add('Certification Zone');
    }

    return [...aliases];
}

function historicalGroup(title: string): string {
    const normalized = normalizeTitle(title);
    if (normalized.includes('work meets play') || normalized.includes('works meet play')) return 'workMeetsPlay';
    if (normalized.includes('base camp')) return 'baseCampBadges';
    if (normalized.includes('certification zone') || normalized === 'skill up summer') return 'certificationBadges';
    if (
        normalized.includes('arcade simulator')
        || normalized === 'work life refresh'
        || normalized === 'from foundations to wonders'
        || normalized === 'skills at the pitch'
        || normalized === 'holi istic infrastructures'
        || normalized === 'arcade safe spaces'
        || normalized === 'safe spaces'
    ) {
        return 'specialBadges';
    }
    if (normalized.includes('trivia') || normalized.includes('sprint ')) return 'triviaBadges';
    return 'levelBadges';
}

function monthName(month: string): string {
    const index = Number(month.slice(5, 7));
    return [
        '', 'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ][index] ?? month;
}

function normalizeTitle(value: string): string {
    return cleanText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
