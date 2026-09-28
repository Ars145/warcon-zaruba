// The Two-team mode rule's pure part: one faction is closed, and everyone on it is moved to
// whichever of the other two has fewer players, so a three-faction server plays as two big teams.
// The game has no two-team setting of its own; its overpopulation lock (see the rule's note) sends
// joiners to the closed, empty faction, and this rule places them from there. No database, no game
// server; triggers.ts runs the step on each fresh player list and writes the moves to the outbox.
import { ApiError, str } from './http';

/** How long a move is waited on before it is asked for again (the player is still on the closed faction). */
export const TWO_TEAMS_RETRY_MS = 30_000;
/** A placed player is told once; the note is forgotten after this long away, so a return next day is told again. */
export const TWO_TEAMS_FORGET_MS = 2 * 3600_000;
/** How stale a placed player's "last seen" may get before the state is written again. */
const SEEN_REFRESH_MS = 5 * 60_000;

export interface TwoTeamsConfig {
	/** the faction nobody plays on; its players are moved off it */
	closedFaction: string;
	/** what players are told the open factions are called, by faction ('' keeps the faction name) */
	names: Record<string, string>;
	/** whispered once a moved player lands, with {team}; '' sends nothing */
	message: string;
}

export function validateTwoTeams(c: Record<string, unknown>): TwoTeamsConfig {
	const closedFaction = str(c.closedFaction, 100);
	if (!closedFaction) throw new ApiError(400, 'Pick the faction to close.');
	const names: Record<string, string> = {};
	if (c.names && typeof c.names === 'object')
		for (const [k, v] of Object.entries(c.names as Record<string, unknown>).slice(0, 8)) {
			const faction = str(k, 100);
			const name = str(v, 40);
			if (faction && name && faction !== closedFaction) names[faction] = name;
		}
	return { closedFaction, names, message: str(c.message, 200) };
}

export interface TwoTeamsState {
	/** moves asked for and not yet seen landed: SteamID -> target faction and when */
	moving: Record<string, { to: string; at: number }>;
	/** moved players already told where they went: SteamID -> last seen on the server */
	told: Record<string, number>;
}

export interface TwoTeamsStep {
	state: TwoTeamsState;
	/** players to move now, and where */
	moves: { steamId: string; name: string; from: string; to: string }[];
	/** moved players now on their side and not told yet */
	whispers: { steamId: string; name: string; faction: string }[];
	/** false when the state is unchanged, so nothing needs writing */
	changed: boolean;
}

/**
 * One fresh player list. `open` is the two factions players are placed on (the match's factions
 * minus the closed one). Players already being moved count toward their target, so a burst at a
 * match start splits evenly; a move not seen landed after TWO_TEAMS_RETRY_MS is asked for again.
 */
export function twoTeamsStep(
	cfg: TwoTeamsConfig,
	previous: TwoTeamsState | null,
	players: { steamId: string; name: string; faction: string | null }[],
	open: string[],
	now: number,
	random: () => number = Math.random
): TwoTeamsStep {
	const moving = { ...(previous?.moving ?? {}) };
	const told = { ...(previous?.told ?? {}) };
	let changed = false;
	const moves: TwoTeamsStep['moves'] = [];
	const whispers: TwoTeamsStep['whispers'] = [];
	const counts = new Map(open.map((f) => [f, 0]));
	for (const p of players)
		if (p.faction && counts.has(p.faction)) counts.set(p.faction, counts.get(p.faction)! + 1);

	const on = new Set<string>();
	for (const p of players) {
		on.add(p.steamId);
		if (p.faction && counts.has(p.faction) && moving[p.steamId]) {
			// Landed (or placed by hand meanwhile): the move is done; tell them once.
			delete moving[p.steamId];
			changed = true;
			if (cfg.message && told[p.steamId] === undefined)
				whispers.push({ steamId: p.steamId, name: p.name, faction: p.faction });
			told[p.steamId] = now;
		} else if (told[p.steamId] !== undefined && now - told[p.steamId] >= SEEN_REFRESH_MS) {
			told[p.steamId] = now;
			changed = true;
		}
	}
	for (const [id, seen] of Object.entries(told))
		if (!on.has(id) && now - seen > TWO_TEAMS_FORGET_MS) {
			delete told[id];
			changed = true;
		}
	for (const [id, m] of Object.entries(moving))
		if (now - m.at >= TWO_TEAMS_RETRY_MS) {
			delete moving[id];
			changed = true;
		}

	if (open.length < 2) return { state: { moving, told }, moves, whispers, changed };
	// Moves still in flight count toward their side before anyone new is placed.
	for (const p of players)
		if (p.faction === cfg.closedFaction && moving[p.steamId] && counts.has(moving[p.steamId].to))
			counts.set(moving[p.steamId].to, counts.get(moving[p.steamId].to)! + 1);
	for (const p of players) {
		if (p.faction !== cfg.closedFaction || moving[p.steamId]) continue;
		const low = Math.min(...counts.values());
		const ties = open.filter((f) => counts.get(f) === low);
		const to = ties[Math.min(ties.length - 1, Math.floor(random() * ties.length))];
		counts.set(to, low + 1);
		moving[p.steamId] = { to, at: now };
		moves.push({ steamId: p.steamId, name: p.name, from: cfg.closedFaction, to });
		changed = true;
	}
	return { state: { moving, told }, moves, whispers, changed };
}

/** What players are told a faction is called. */
export const teamName = (cfg: TwoTeamsConfig, faction: string): string =>
	cfg.names[faction] || faction;
