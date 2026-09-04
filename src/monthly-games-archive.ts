import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MonthlyArcadeGame } from './arcade-extractors.js';

export const MONTHLY_GAMES_ARCHIVE_DIR = 'data/arcade_monthly_games_history';

export function arcadeMonthKey(game: MonthlyArcadeGame): string | null {
    if (game.month && /^\d{4}-\d{2}$/.test(game.month)) return game.month;
    if (!game.deadline) return null;

    const deadline = new Date(game.deadline);
    if (Number.isNaN(deadline.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        timeZone: game.deadlineTimeZone,
    }).formatToParts(deadline);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;

    return year && month ? `${year}-${month}` : null;
}

export function monthlyArchiveFile(archiveDir: string, month: string): string {
    const match = month.match(/^(\d{4})-(\d{2})$/);
    if (!match) throw new Error(`Invalid Arcade month key: ${month}`);

    return join(archiveDir, match[1], `${match[2]}.json`);
}

export function mergeMonthlyGames(
    existing: MonthlyArcadeGame[],
    incoming: MonthlyArcadeGame[],
): MonthlyArcadeGame[] {
    const merged = [...existing];

    for (const game of incoming) {
        const index = merged.findIndex((candidate) => sameGame(candidate, game));
        if (index === -1) {
            merged.push(game);
            continue;
        }

        merged[index] = mergeGame(merged[index], game);
    }

    return merged.sort((left, right) => left.title.localeCompare(right.title));
}

export async function persistMonthlyGames(
    games: MonthlyArcadeGame[],
    latestFile: string,
    archiveDir = MONTHLY_GAMES_ARCHIVE_DIR,
): Promise<string[]> {
    if (games.length === 0) return [];

    await mkdir(dirname(latestFile), { recursive: true });
    await writeJson(latestFile, games);

    return persistMonthlyGameArchives(games, archiveDir);
}

export async function persistMonthlyGameArchives(
    games: MonthlyArcadeGame[],
    archiveDir = MONTHLY_GAMES_ARCHIVE_DIR,
): Promise<string[]> {
    if (games.length === 0) return [];

    const byMonth = new Map<string, MonthlyArcadeGame[]>();

    for (const game of games) {
        const month = arcadeMonthKey(game);
        if (!month) continue;

        const monthGames = byMonth.get(month) ?? [];
        monthGames.push({ ...game, month });
        byMonth.set(month, monthGames);
    }

    const archiveFiles: string[] = [];

    for (const [month, monthGames] of byMonth) {
        const archiveFile = monthlyArchiveFile(archiveDir, month);
        await mkdir(dirname(archiveFile), { recursive: true });
        const existing = await readGames(archiveFile);
        const merged = mergeMonthlyGames(existing, monthGames);
        await writeJson(archiveFile, merged);
        archiveFiles.push(archiveFile);
    }

    return archiveFiles.sort();
}

async function readGames(path: string): Promise<MonthlyArcadeGame[]> {
    try {
        const decoded = JSON.parse(await readFile(path, 'utf8')) as unknown;
        return Array.isArray(decoded)
            ? decoded.filter((game): game is MonthlyArcadeGame => Boolean(game && typeof game === 'object'))
            : [];
    } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
    }
}

async function writeJson(path: string, value: unknown) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sameGame(left: MonthlyArcadeGame, right: MonthlyArcadeGame): boolean {
    const leftId = gameId(left);
    const rightId = gameId(right);
    if (leftId && rightId && leftId === rightId) return true;

    const leftNames = gameNames(left);
    const rightNames = gameNames(right);
    return leftNames.some((name) => rightNames.includes(name));
}

function gameId(game: MonthlyArcadeGame): string | null {
    return game.joinUrl?.match(/\/games\/(\d+)/)?.[1] ?? null;
}

function gameNames(game: MonthlyArcadeGame): string[] {
    return [...new Set([
        normalize(game.title),
        ...(game.aliases ?? []).map(normalize),
        game.rawTitle ? normalize(game.rawTitle) : '',
    ].filter(Boolean))];
}

function mergeGame(existing: MonthlyArcadeGame, incoming: MonthlyArcadeGame): MonthlyArcadeGame {
    const next = { ...existing, ...incoming };

    for (const key of Object.keys(existing) as Array<keyof MonthlyArcadeGame>) {
        const incomingValue = incoming[key];
        if (incomingValue === null || incomingValue === undefined || incomingValue === '') {
            (next as Record<string, unknown>)[key] = existing[key];
        }
    }

    next.aliases = [...new Set([...(existing.aliases ?? []), ...(incoming.aliases ?? [])])];
    next.month = incoming.month ?? existing.month ?? arcadeMonthKey(incoming) ?? arcadeMonthKey(existing);
    next.group = incoming.group ?? existing.group ?? null;
    next.source = incoming.source ?? existing.source ?? null;
    next.sourceUrl = incoming.sourceUrl ?? existing.sourceUrl ?? null;
    next.status = incoming.status ?? existing.status ?? null;
    next.reconstructed = incoming.reconstructed ?? existing.reconstructed ?? false;

    return next;
}

function normalize(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
