// The one thing the observation loop calls: a match closed, say so in Discord.
import type { Env } from '../env';
import type { FactionScore, Player } from '$lib/types';
import { buildMatchCard } from './data';
import { renderMatchCard } from './render';
import { notifyMatchResult } from './notify';

export { buildMatchCard, keepFinalLook, type FinalLook, type MatchResultCard } from './data';
export { renderMatchCard, cardHtml, closeCardBrowser } from './render';
export { notifyMatchResult } from './notify';

/**
 * Builds, draws and sends the card for the match just closed. Called with the scoreboard as it
 * stood before the boundary, since the live one already belongs to the next match.
 *
 * A match with no winner is not reported: a map change ends the open row with everyone on zero,
 * and that artefact is about one match in fifty. Throws are left to the caller's `stage()`.
 */
export async function reportMatch(
	env: Env,
	serverId: string,
	matchId: number,
	look: { players: Player[]; scores: FactionScore[] },
	maxPlayers: number
): Promise<void> {
	const card = await buildMatchCard(env, serverId, matchId, look, maxPlayers);
	if (!card.winner) return;
	const png = await renderMatchCard(card);
	const sent = await notifyMatchResult(env, serverId, card, png);
	if (sent) console.log(`[warcon] match card posted for match ${matchId} to ${sent} webhook(s)`);
}
