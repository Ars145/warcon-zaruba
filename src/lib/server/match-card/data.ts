// What the match result card says, gathered once when a match closes.
//
// Three sources, and each is the only one that has its part. The `matches` row carries the map,
// the mode, the lighting, the peak and the final faction scores. The worker's `lastLook` carries
// the scoreboard and the faction colours: by the time the boundary is visible the live ones
// already describe the next match, and the stored row keeps no colours. `player_sessions`
// carries who passed through and who was here for the first time — it has no match column, so
// both are windowed on the match's own clock.
//
// The kill feed is not a source: `WDServerFeed` has never delivered an event to this install
// (the `kills` table is empty), so there are no weapons, distances, headshots or streaks here.
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { matches, organizations, playerSessions, servers } from '../db/schema';
import { MAP_DISPLAY } from '$lib/format';
import { modeLabel } from '../webhook-status-core';
import type { FactionScore, Player } from '$lib/types';

/** A player good enough to win "best K/D": fewer kills than this and the ratio is noise. */
export const TOP_KD_MIN_KILLS = 10;

export interface CardHero {
	steamId: string;
	name: string;
	faction: string | null;
	kills: number;
	deaths: number;
	kd: number;
	cash: number;
}

export interface CardRow extends CardHero {
	rank: number;
	newcomer: boolean;
}

export interface MatchResultCard {
	/** ISO-8601 UTC */
	endedAt: string;
	/** servers.name, the panel's own label: the in-game one is decorated with stars and padding */
	serverName: string;
	orgName: string;
	match: {
		/** the art folder's spelling (Kavkazi), derived from the display name the server reports */
		mapId: string;
		mapName: string;
		mode: string;
		lighting: string;
		/** includes the end-of-match screen: the row starts when the previous boundary was seen */
		durationSec: number;
		peakPlayers: number;
		maxPlayers: number;
		/** everyone whose session overlapped the match, not just those present at the end */
		playersSeen: number;
	};
	factions: Array<{
		name: string;
		colorHex: string;
		score: number;
		players: number;
		winner: boolean;
	}>;
	winner: string | null;
	scoreboard: CardRow[];
	awards: {
		topKills: CardHero | null;
		topCash: CardHero | null;
		topKd: CardHero | null;
	};
}

const ID_OF: Record<string, string> = Object.fromEntries(
	Object.entries(MAP_DISPLAY).map(([id, name]) => [name, id])
);

/** Kills per death, and plain kills for someone who never died. */
export const kdOf = (kills: number, deaths: number): number =>
	deaths === 0 ? kills : Math.round((kills / deaths) * 100) / 100;

const heroOf = (p: Player): CardHero => ({
	steamId: p.steamId,
	name: p.name,
	faction: p.faction,
	kills: p.kills,
	deaths: p.deaths,
	kd: kdOf(p.kills, p.deaths),
	cash: p.cash
});

/** The best by `value`, or null when nobody qualifies. Ties go to whoever the game listed first. */
function bestBy(players: Player[], value: (p: Player) => number): CardHero | null {
	let best: Player | null = null;
	for (const p of players) if (!best || value(p) > value(best)) best = p;
	return best ? heroOf(best) : null;
}

export function buildAwards(players: Player[]): MatchResultCard['awards'] {
	const scoring = players.filter((p) => p.kills > 0 || p.cash > 0);
	return {
		topKills: bestBy(scoring, (p) => p.kills),
		topCash: bestBy(scoring, (p) => p.cash),
		topKd: bestBy(
			players.filter((p) => p.kills >= TOP_KD_MIN_KILLS),
			(p) => kdOf(p.kills, p.deaths)
		)
	};
}

/** Sorted by kills, then by cash: two players on 3 kills are not really tied. */
export function buildScoreboard(players: Player[], newcomers: Set<string>): CardRow[] {
	return [...players]
		.sort((a, b) => b.kills - a.kills || b.cash - a.cash)
		.map((p, i) => ({ ...heroOf(p), rank: i + 1, newcomer: newcomers.has(p.steamId) }));
}

export function buildFactions(
	scores: FactionScore[],
	players: Player[],
	winner: string | null
): MatchResultCard['factions'] {
	return [...scores]
		.sort((a, b) => b.score - a.score)
		.map((f) => ({
			name: f.name,
			colorHex: f.colorHex,
			score: f.score,
			players: players.filter((p) => p.faction === f.name).length,
			winner: !!winner && f.name === winner
		}));
}

/**
 * Everything the card needs for the match that just closed. `look` is the worker's memory of the
 * observation before the boundary; `matchId` the row `reconcileMatch` has just written.
 */
export async function buildMatchCard(
	env: Env,
	serverId: string,
	matchId: number,
	look: { players: Player[]; scores: FactionScore[] },
	maxPlayers: number
): Promise<MatchResultCard> {
	const [row] = await env.db
		.select({
			map: matches.map,
			experiences: matches.experiences,
			lighting: matches.lighting,
			peakPlayers: matches.peakPlayers,
			startedAt: matches.startedAt,
			endedAt: matches.endedAt,
			finalScores: matches.finalScores,
			winner: matches.winner,
			serverName: servers.name,
			orgName: organizations.name
		})
		.from(matches)
		.innerJoin(servers, eq(servers.id, matches.serverId))
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.where(eq(matches.id, matchId));
	if (!row) throw new Error(`match ${matchId} vanished before its card was built`);
	if (!row.endedAt) throw new Error(`match ${matchId} is still open`);

	const started = row.startedAt;
	const ended = row.endedAt;

	const [seen, firstSeen] = await Promise.all([
		env.db
			.select({ n: sql<number>`count(*)::int` })
			.from(playerSessions)
			.where(
				and(
					eq(playerSessions.serverId, serverId),
					lt(playerSessions.joinedAt, ended),
					or(isNull(playerSessions.leftAt), gt(playerSessions.leftAt, started))
				)
			),
		env.db
			.select({
				steamId: playerSessions.steamId,
				firstJoin: sql<Date>`min(${playerSessions.joinedAt})`
			})
			.from(playerSessions)
			.where(eq(playerSessions.serverId, serverId))
			.groupBy(playerSessions.steamId)
	]);

	const newcomers = new Set(
		firstSeen.filter((r) => new Date(r.firstJoin) >= started).map((r) => r.steamId)
	);

	// The scores stored with the match are the authority on the result; the look only colours them.
	const stored = (row.finalScores as Array<{ name: string; score: number }> | null) ?? [];
	const colourOf = new Map(look.scores.map((f) => [f.name, f.colorHex]));
	const scores: FactionScore[] = stored.map((f) => ({
		name: f.name,
		score: f.score,
		colorHex: colourOf.get(f.name) ?? '#8a8a90'
	}));
	const winner = row.winner || null;
	const mapName = row.map ?? '';

	return {
		endedAt: ended.toISOString(),
		serverName: row.serverName,
		orgName: row.orgName,
		match: {
			mapId: ID_OF[mapName] ?? mapName,
			mapName,
			mode: modeLabel((row.experiences ?? '').split('+').filter(Boolean)),
			lighting: row.lighting ?? '',
			durationSec: Math.max(0, Math.round((ended.getTime() - started.getTime()) / 1000)),
			peakPlayers: row.peakPlayers,
			maxPlayers,
			playersSeen: seen[0]?.n ?? 0
		},
		factions: buildFactions(scores, look.players, winner),
		winner,
		scoreboard: buildScoreboard(look.players, newcomers),
		awards: buildAwards(look.players)
	};
}
