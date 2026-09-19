// Sends the match result card to the org's webhooks.
//
// Not through the embed queue: that batches up to ten embeds into one JSON message, and this is
// an attachment. Posted straight away instead, the way the status cards are, one request per
// webhook that asked for match results.
import type { Env } from '../env';
import type { WebhookRow } from '../db/schema';
import {
	discordCall,
	enabledWebhooks,
	orgOfServer,
	recordResult,
	type Embed
} from '../webhook-delivery';
import type { MatchResultCard } from './data';

const MATCH_COLOR = 0xff7d00;

/** The caption under the image: everything the picture already says, for search and for phones. */
export function buildMatchEmbed(appName: string, card: MatchResultCard, fileName: string): Embed {
	const scores = card.factions.map((f) => `${f.name} ${f.score}`).join(' · ');
	const lines = [
		`**${card.match.mapName}** · ${card.match.mode}`,
		card.winner ? `Победитель: **${card.winner}**` : 'Победитель не определён',
		scores
	].filter(Boolean);
	return {
		title: `Итоги боя · ${card.serverName}`,
		description: lines.join('\n').slice(0, 2000),
		color: MATCH_COLOR,
		timestamp: card.endedAt,
		image: { url: `attachment://${fileName}` },
		footer: { text: appName }
	};
}

function wants(hook: WebhookRow, serverId: string): boolean {
	if (!((hook.events as string[]) || []).includes('matches')) return false;
	const only = hook.serverIds as string[] | null;
	return !only || !only.length || only.includes(serverId);
}

/**
 * Fans one card out to whoever mirrors match results. Never throws: a webhook that is down must
 * not stop the worker, and the result is already safe in the database either way.
 */
export async function notifyMatchResult(
	env: Env,
	serverId: string,
	card: MatchResultCard,
	png: Uint8Array<ArrayBuffer>
): Promise<number> {
	try {
		const orgId = await orgOfServer(env, serverId);
		if (!orgId) return 0;
		const hooks = (await enabledWebhooks(env, orgId)).filter((h) => wants(h, serverId));
		if (!hooks.length) return 0;

		const fileName = `match-${card.match.mapId || 'result'}-${card.endedAt.slice(0, 19).replace(/[:T]/g, '')}.png`;
		const embed = buildMatchEmbed(env.APP_NAME || 'Warcon', card, fileName);
		let sent = 0;
		for (const hook of hooks) {
			// One FormData per webhook: a body can only be read once.
			const form = new FormData();
			form.append(
				'payload_json',
				JSON.stringify({
					username: env.APP_NAME || 'Warcon',
					allowed_mentions: { parse: [] },
					embeds: [embed]
				})
			);
			form.append('files[0]', new Blob([png], { type: 'image/png' }), fileName);
			const result = await discordCall(env, hook, 'POST', '?wait=true', form);
			await recordResult(env, hook.id, result);
			if (result.ok) sent++;
			else console.warn(`[warcon] match card to webhook ${hook.id}: ${result.error}`);
		}
		return sent;
	} catch (err) {
		console.error('[warcon] match card notify', err);
		return 0;
	}
}
