// Every event a JSON webhook can carry: the kinds an owner ticks, and one builder per event that
// sets its body, a fixed field list made here and nowhere else (the README documents each). An
// event is queued where it happens, with queueEvent (json-webhook-queue.ts), from the worker or the
// web. A new event is a kind with its label here (a new kind is a new tick on the webhook form), a
// builder, one queueEvent call, and its body in the README.
import type { JsonWebhookRow } from './db/schema';

export const JSON_WEBHOOK_EVENTS = ['seed_reward'] as const;
export type JsonWebhookEvent = (typeof JSON_WEBHOOK_EVENTS)[number];
export const JSON_WEBHOOK_EVENT_LABELS: Record<JsonWebhookEvent, string> = {
	seed_reward: 'Seeding reward grants'
};

/** One event, as queueEvent takes it. */
export interface JsonEvent {
	/** the tick on the webhook that takes it */
	kind: JsonWebhookEvent;
	/** what the receiver reads as `event`, e.g. "seed_reward.granted" */
	event: string;
	/** what makes this one event, unique within `event`: its id is "<event>:<key>" */
	key: string;
	orgId: string;
	/** the server it happened on; null for an organisation-wide event (an org list edit, say) */
	serverId: string | null;
	/** the event's own fields; `event`, `id` and `at` are added when it is queued */
	fields: Record<string, unknown>;
}

/**
 * Does this webhook take this event? The kind must be ticked. An event on a server must be on one
 * the webhook covers; an organisation-wide event concerns every server, so every webhook that
 * ticks the kind takes it.
 */
export function covers(
	hook: Pick<JsonWebhookRow, 'events' | 'serverIds'>,
	kind: string,
	serverId: string | null
): boolean {
	if (!((hook.events as string[]) || []).includes(kind)) return false;
	if (serverId === null) return true;
	const only = hook.serverIds as string[] | null;
	return !only || !only.length || only.includes(serverId);
}

/**
 * A Seeding reward grant, once the slot is on the list; keyed by the slot's own entry, so the id
 * says nothing about anything else the panel does.
 */
export function seedRewardGranted(g: {
	entryId: string;
	org: { id: string; name: string };
	server: { id: string; name: string };
	player: { steamId: string; name: string };
	scope: 'server' | 'org';
	expiresAt: Date;
	days: number;
	rule: { id: string | null; name: string };
	seedMinutes: number | null;
}): JsonEvent {
	return {
		kind: 'seed_reward',
		event: 'seed_reward.granted',
		key: g.entryId,
		orgId: g.org.id,
		serverId: g.server.id,
		fields: {
			org: g.org,
			server: g.server,
			player: g.player,
			slot: { scope: g.scope, expiresAt: g.expiresAt.toISOString(), days: g.days },
			rule: g.rule,
			seedMinutes: g.seedMinutes
		}
	};
}
