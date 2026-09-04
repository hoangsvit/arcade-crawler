import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MonthlyArcadeGame } from './arcade-extractors.js';

export const MONTHLY_GAMES_ARCHIVE_DIR = 'data/arcade_monthly_games_history';

export function arcadeMonthKey(game: MonthlyArcadeGame): string | null {
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

export function mergeMonthlyGames(
    existing: MonthlyArcadeGame[],
    incoming: MonthlyArcadeGame[],
): MonthlyArcadeGame[] {
    const games = new Map<string, MonthlyArcadeGame>();

    for (const game of existing) {
        games.set(gameIdentity(game), game);
    }

    for (const game of incoming) {
        games.set(gameIdentity(game), game);
    }

    return [...games.values()].sort((left, right) => left.title.localeCompare(right.title));
}

export async function persistMonthlyGames(
    games: MonthlyArcadeGame[],
    latestFile: string,
    archiveDir = MONTHLY_GAMES_ARCHIVE_DIR,
): Promise<string[]> {
    if (games.length === 0) return [];

    await mkdir(dirname(latestFile), { recursive: true });
    await writeJson(latestFile, games);

    const byMonth = new Map<string, MonthlyArcadeGame[]>();

    for (const game of games) {
        const month = arcadeMonthKey(game);
        if (!month) continue;

        const monthGames = byMonth.get(month) ?? [];
        monthGames.push(game);
        byMonth.set(month, monthGames);
    }

    const archiveFiles: string[] = [];
    await mkdir(archiveDir, { recursive: true });

    for (const [month, monthGames] of byMonth) {
        const archiveFile = join(archiveDir, `${month}.json`);
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

function gameIdentity(game: MonthlyArcadeGame): string {
    const gameId = game.joinUrl?.match(/\/games\/(\d+)/)?.[1];
    if (gameId) return `game:${gameId}`;

    return `title:${normalize(game.title)}|code:${normalize(game.accessCode ?? '')}`;
}

function normalize(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
