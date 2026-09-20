// The `card` status style: the live status message drawn as pictures instead of an embed.
//
// webhook-status.ts owns the mirror — when to edit, which message belongs to which server, the
// backoff and the claim. This module owns only two things it asks for: what to send (instead of
// the embed statusMessage built) and how to send it (multipart, because it carries files).
import type { Env } from '../env';
import type { WebhookRow } from '../db/schema';
import type { LiveView } from '$lib/types';
import { discordCall, type PostResult } from '../webhook-delivery';
import { buildStatusCard, statusCardKey } from './data';
import { banner, renderStatusCard } from './render';
import { statusFiles, statusPayload } from './message';

export { buildStatusCard, statusCardKey, TOP_ROWS } from './data';
export { renderStatusCard, statusHtml, statusVals } from './render';
export { statusPayload, statusFiles, COMPONENTS_V2 } from './message';

/** What one live message needs remembered between passes, keyed by webhook id and server id. */
interface Held {
	key: string;
	pictures: { scores: Uint8Array<ArrayBuffer>; top: Uint8Array<ArrayBuffer> };
}
const held = new Map<string, Held>();

export interface StatusShot {
	payload: Record<string, unknown>;
	key: string;
	files: Array<{ name: string; bytes: Uint8Array<ArrayBuffer>; type: string }>;
	attachments: Array<Record<string, unknown>>;
	cacheKey: string;
}

/**
 * The card for one server, or null when this webhook does not draw cards or there is nothing to
 * draw — the caller then sends the ordinary embed. Re-renders only when the figures moved: a
 * heartbeat edit re-sends the pictures it already has.
 */
export async function statusCardFor(
	hook: WebhookRow,
	serverId: string,
	serverName: string,
	orgName: string,
	live: LiveView | null
): Promise<StatusShot | null> {
	if (hook.statusStyle !== 'card') return null;
	const card = buildStatusCard(serverName, orgName, live);
	if (!card) return null;
	const cacheKey = `${hook.id}:${serverId}`;
	const key = statusCardKey(card);
	const before = held.get(cacheKey);
	const pictures = before && before.key === key ? before.pictures : await renderStatusCard(card);
	held.set(cacheKey, { key, pictures });
	const { files, attachments } = statusFiles(pictures, banner());
	return {
		payload: { ...statusPayload(card), attachments },
		key,
		files,
		attachments,
		cacheKey
	};
}

/**
 * Sends a card, posting when `messageId` is null and editing otherwise. A plain webhook only
 * reads `components` with `with_components=true` on the query, so every call carries it.
 */
export async function sendStatusCard(
	env: Env,
	hook: WebhookRow,
	messageId: string | null,
	shot: StatusShot
): Promise<PostResult> {
	const form = new FormData();
	form.append(
		'payload_json',
		JSON.stringify({ username: env.APP_NAME || 'Warcon', ...shot.payload })
	);
	shot.files.forEach((f, i) =>
		form.append(`files[${i}]`, new Blob([f.bytes], { type: f.type }), f.name)
	);
	const path = messageId
		? `/messages/${encodeURIComponent(messageId)}?with_components=true`
		: '?wait=true&with_components=true';
	return discordCall(env, hook, messageId ? 'PATCH' : 'POST', path, form);
}

/** Test-only, and for a server whose card was taken down. */
export function forgetStatusCard(cacheKey?: string): void {
	if (cacheKey) held.delete(cacheKey);
	else held.clear();
}
