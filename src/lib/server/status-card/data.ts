// What the live status card draws, taken from the worker's latest look at one server.
//
// Everything here comes from a single `LiveView`: the status document for the map, the mode and
// the faction scores, the player list for the table. Nothing is read from the database — the card
// describes the present, and the present is what the worker holds.
//
// Two figures the game does not give us on live builds: there is no match clock (`matchSeconds`
// is always null) and no score cap (`scoreCap` likewise), so the card shows neither a timer nor a
// "first to" read from the server — the cap is the game's constant from $lib/match.
import { MAP_DISPLAY } from '$lib/format';
import { scoreCapOf } from '$lib/match';
import { modeLabel } from '../webhook-status-core';
import type { LiveView, Player } from '$lib/types';

/** How many players the table lists. The rest are counted in the footer. */
export const TOP_ROWS = 10;

export interface StatusRow {
	rank: number;
	name: string;
	faction: string | null;
	factionColor: string;
	kills: number;
	deaths: number;
	cash: number;
}

export interface StatusFaction {
	name: string;
	colorHex: string;
	score: number;
	/** of the cap, for the bar; 0-100 */
	pct: number;
	leading: boolean;
}

export interface StatusCard {
	serverName: string;
	orgName: string;
	/** the art folder's spelling, for the footer */
	mapId: string;
	mapName: string;
	mode: string;
	lighting: string;
	zone: string;
	online: number;
	maxPlayers: number;
	/** slots held back from public joins; null until the worker has read the config document */
	reservedSlots: number | null;
	scoreCap: number;
	factions: StatusFaction[];
	rows: StatusRow[];
	/** everyone the server listed, so the footer can say "Топ 10 из 78" */
	playersTotal: number;
	/** '' on builds that do not serve it */
	joinCode: string;
	/** epoch seconds, for Discord's own relative clock; null when the build does not serve it */
	startedAt: number | null;
	/** epoch seconds of the observation this card describes */
	observedAt: number;
}

const NEUTRAL = 'rgba(255,255,255,.3)';

const epoch = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** Sorted by kills, then by cash — the same rule the match card uses, so the two never disagree. */
const ranked = (players: Player[]): Player[] =>
	[...players].sort((a, b) => b.kills - a.kills || b.cash - a.cash);

/**
 * The card for one server, or null when there is nothing to draw: a server the worker has never
 * reached, or one whose status has not arrived. The caller leaves the webhook's ordinary card in
 * place in that case rather than posting an empty picture.
 */
export function buildStatusCard(
	serverName: string,
	orgName: string,
	live: LiveView | null
): StatusCard | null {
	if (!live || !live.ok || !live.status || !live.observedAt) return null;
	const s = live.status;
	const cap = scoreCapOf(s);
	const top = Math.max(...s.scores.map((f) => f.score), 0);
	const colorOf = new Map(s.scores.map((f) => [f.name, f.colorHex]));

	const factions = [...s.scores]
		.sort((a, b) => b.score - a.score)
		.map((f) => ({
			name: f.name,
			colorHex: f.colorHex,
			score: f.score,
			pct: Math.min(100, Math.round((f.score / cap) * 100)),
			// A nought-all board at the start of a match has no leader, and a tie has two.
			leading: top > 0 && f.score === top
		}));

	const rows = ranked(live.players)
		.slice(0, TOP_ROWS)
		.map((p, i) => ({
			rank: i + 1,
			name: p.name,
			faction: p.faction,
			factionColor: (p.faction && colorOf.get(p.faction)) || NEUTRAL,
			kills: p.kills,
			deaths: p.deaths,
			cash: p.cash
		}));

	return {
		serverName,
		orgName,
		mapId: s.map,
		mapName: MAP_DISPLAY[s.map] ?? s.map,
		mode: modeLabel(s.experiences),
		lighting: s.lighting,
		zone: s.alternator,
		online: s.playerCount,
		maxPlayers: s.maxPlayers,
		reservedSlots: live.reservedSlots,
		scoreCap: cap,
		factions,
		rows,
		playersTotal: live.players.length,
		joinCode: live.gameServerId,
		startedAt: live.startedAt ? epoch(live.startedAt) : null,
		observedAt: epoch(live.observedAt)
	};
}

/**
 * What the card actually shows, as one string. Two looks with the same key draw the same picture,
 * so the mirror can skip both the render and the upload.
 */
export function statusCardKey(card: StatusCard): string {
	return [
		card.mapName,
		card.mode,
		card.lighting,
		card.zone,
		card.online,
		card.maxPlayers,
		card.joinCode,
		card.factions.map((f) => `${f.name}:${f.score}`).join(','),
		card.rows.map((r) => `${r.name}:${r.kills}:${r.deaths}:${r.cash}`).join(',')
	].join('|');
}
