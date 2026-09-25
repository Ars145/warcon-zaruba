// The queue of POSTs to organisations' JSON webhooks. queueEvent writes one row per webhook that
// takes an event, in the caller's transaction, from the worker or the web; the worker that owns
// the fleet sends them. A table and a loop of their own, apart from the game actions' outbox, so a
// receiver that is slow or down costs this queue and never a kick or a whisper:
//
//   - each webhook's POSTs go oldest first, one in flight at a time, SLOTS across all webhooks, so
//     however much is queued for one organisation's receiver it holds one slot; a POST that
//     finishes claims the next at once, so a webhook drains as fast as its receiver answers. The
//     one in flight is the webhook's oldest open POST, so nothing behind it is claimed while it is
//     sending, from this process or from one that stopped mid-send and whose lease has not run out;
//   - no answer, a 429 or a 5xx: the POST waits RETRY_S[attempt] and the webhook's others wait
//     behind it, so a receiver that is down costs one attempt per wait, not one per event; any
//     other answer is final. A POST that still has no answer after the last wait (about two
//     days) fails and pauses its webhook: what waited for it is skipped, and nothing more is
//     queued for it until an owner enables it again, so an abandoned receiver stops growing the
//     queue;
//   - the claim steps from one webhook's oldest open POST to the next webhook's, one index entry
//     per webhook with anything open: webhooks with nothing queued cost nothing, however many
//     organisations add them, and a backlog costs one entry per webhook, not one per POST;
//   - at least once: a POST whose worker stopped mid-send goes out again. Receivers dedupe on the
//     event's id ("<event>:<key>", unique per event), which is also the row's unique key.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { jsonWebhookPosts, jsonWebhooks, servers, type JsonWebhookRow } from './db/schema';
import { forLog } from './http';
import { writeAudit } from './audit';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { jsonWebhookPostsDone } from './metrics';
import { covers, type JsonEvent } from './json-webhook-events';
import { noteResult, sendEvent } from './json-webhook-send';

/**
 * Seconds a POST that got no answer, a 429 or a 5xx waits before each next attempt: 1, 5 and 30
 * minutes, then 2, 6, 12 and 24 hours, so a receiver down for a day or two loses nothing. After the
 * last it fails and its webhook is paused.
 */
export const RETRY_S = [60, 300, 1800, 7200, 21600, 43200, 86400];
/** What a webhook paused after its last retry says on the organisation's page. */
const NO_ANSWER = 'Paused: nothing delivered for two days.';
/** POSTs in flight at once, across every webhook. */
const SLOTS = 16;
const TICK_MS = 1000;
/** Well above a send's own bound (the address check and the answer, json-webhook-send.ts). */
const LEASE_S = 60;

/**
 * Queues `e` for every enabled webhook of its organisation that takes it; an event already queued
 * for a webhook is not queued twice. Returns how many were queued.
 */
export async function queueEvent(db: DbOrTx, e: JsonEvent): Promise<number> {
	const hooks = (
		await db
			.select({
				id: jsonWebhooks.id,
				events: jsonWebhooks.events,
				serverIds: jsonWebhooks.serverIds
			})
			.from(jsonWebhooks)
			.where(and(eq(jsonWebhooks.orgId, e.orgId), eq(jsonWebhooks.enabled, true)))
	).filter((h) => covers(h, e.kind, e.serverId));
	if (!hooks.length) return 0;
	const id = `${e.event}:${e.key}`;
	const at = new Date().toISOString();
	// event, id and at lead the body, and no field of the event's can stand in for them
	const body = JSON.stringify(
		Object.assign({ event: e.event, id, at }, e.fields, { event: e.event, id, at })
	);
	const rows = await db
		.insert(jsonWebhookPosts)
		.values(
			hooks.map((h) => ({
				webhookId: h.id,
				serverId: e.serverId,
				kind: e.kind,
				eventId: id,
				body
			}))
		)
		.onConflictDoNothing({ target: [jsonWebhookPosts.webhookId, jsonWebhookPosts.eventId] })
		.returning({ id: jsonWebhookPosts.id });
	return rows.length;
}

/** Marks what is waiting for these webhooks as skipped: a paused or removed webhook gets nothing. */
export async function skipQueued(db: DbOrTx, webhookIds: string[], outcome: string): Promise<void> {
	if (!webhookIds.length) return;
	await db
		.update(jsonWebhookPosts)
		.set({ state: 'skipped', outcome, doneAt: new Date() })
		.where(
			and(inArray(jsonWebhookPosts.webhookId, webhookIds), eq(jsonWebhookPosts.state, 'pending'))
		);
}

/** POSTs queued and not yet finished, for the worker's metrics. */
export async function pendingPosts(env: Env): Promise<number> {
	const [row] = await env.db.execute<{ n: string }>(sql`
		SELECT COUNT(*) AS n FROM json_webhook_posts WHERE state IN ('pending', 'sending')`);
	return Number(row?.n ?? 0);
}

// ---- the loop -----------------------------------------------------------------------------------

declare global {
	// Survives Vite HMR re-evaluation in dev so an old loop never keeps running.
	var __warconJsonPosts: ReturnType<typeof setInterval> | undefined;
}
let envRef: Env | null = null;
let ticking = false;
/** a POST finished while a tick was running: claim again as soon as it is done */
let wanted = false;
/** webhooks with a POST in flight from this process */
const busy = new Set<string>();

export function startJsonWebhookPosts(env: Env): void {
	envRef = env;
	stopJsonWebhookPosts();
	globalThis.__warconJsonPosts = setInterval(() => void tick(), TICK_MS);
}

export function stopJsonWebhookPosts(): void {
	if (globalThis.__warconJsonPosts) clearInterval(globalThis.__warconJsonPosts);
	globalThis.__warconJsonPosts = undefined;
}

interface Claimed {
	id: number;
	webhookId: string;
	serverId: string | null;
	kind: string;
	eventId: string;
	body: string;
	attempts: number;
}

/** Claims again now: a slot has come free. */
function wake(): void {
	wanted = true;
	void tick();
}

async function tick(): Promise<void> {
	const env = envRef;
	if (!env || ticking || !isOwner()) return;
	ticking = true;
	wanted = false;
	try {
		const free = SLOTS - busy.size;
		const claimed = await withOwnedTransaction(env, async (tx) => {
			// A POST whose worker stopped mid-send may or may not have arrived: it goes out again,
			// within the attempts a retry would have had.
			await tx.execute(sql`
				UPDATE json_webhook_posts
				   SET state = CASE WHEN attempts > ${RETRY_S.length} THEN 'failed' ELSE 'pending' END,
				       done_at = CASE WHEN attempts > ${RETRY_S.length} THEN now() END,
				       outcome = 'The worker stopped while sending.', lease_until = NULL
				 WHERE state = 'sending' AND lease_until < now()`);
			if (free <= 0) return [];
			const inFlight = busy.size ? sql`AND webhook_id NOT IN ${[...busy]}` : sql``;
			// Each webhook's oldest open POST, found by stepping through json_webhook_posts_next_idx
			// from one webhook to the next (one entry per webhook with anything open). It is claimed
			// when it is pending and due: one sending, or waiting for its retry, holds the webhook's
			// others back. Oldest first, as many as there are free slots.
			return (await tx.execute(sql`
				WITH RECURSIVE heads AS (
				  (SELECT p.webhook_id, p.id, p.state, p.not_before FROM json_webhook_posts p
				    WHERE p.state IN ('pending', 'sending')
				    ORDER BY p.webhook_id, p.id LIMIT 1)
				  UNION ALL
				  SELECT n.webhook_id, n.id, n.state, n.not_before FROM heads h
				   CROSS JOIN LATERAL (SELECT p.webhook_id, p.id, p.state, p.not_before
				                         FROM json_webhook_posts p
				                        WHERE p.state IN ('pending', 'sending') AND p.webhook_id > h.webhook_id
				                        ORDER BY p.webhook_id, p.id LIMIT 1) n
				)
				UPDATE json_webhook_posts q
				   SET state = 'sending', attempts = attempts + 1,
				       lease_until = now() + (${LEASE_S} || ' seconds')::interval
				  FROM (SELECT id FROM heads
				         WHERE state = 'pending' AND not_before <= now() ${inFlight}
				         ORDER BY id LIMIT ${free}) pick
				 WHERE q.id = pick.id AND q.state = 'pending'
				RETURNING q.id, q.webhook_id AS "webhookId", q.server_id AS "serverId", q.kind,
				          q.event_id AS "eventId", q.body, q.attempts`)) as unknown as Claimed[];
		});
		for (const row of claimed) {
			busy.add(row.webhookId);
			void post(env, row).finally(() => {
				busy.delete(row.webhookId);
				wake();
			});
		}
	} catch (err) {
		if (!(err instanceof LostOwnership)) console.error('[warcon] json webhook posts', forLog(err));
	} finally {
		ticking = false;
		if (wanted) void tick();
	}
}

/**
 * The webhook as it is now, if it still takes this POST: enabled, the kind still ticked, the
 * server still covered and in the webhook's own organisation.
 */
async function takes(env: Env, row: Claimed): Promise<JsonWebhookRow | null> {
	const [hook] = await env.db
		.select()
		.from(jsonWebhooks)
		.where(eq(jsonWebhooks.id, row.webhookId))
		.limit(1);
	if (!hook || !hook.enabled || !covers(hook, row.kind, row.serverId)) return null;
	if (row.serverId === null) return hook;
	const [server] = await env.db
		.select({ orgId: servers.orgId })
		.from(servers)
		.where(eq(servers.id, row.serverId))
		.limit(1);
	return server?.orgId === hook.orgId ? hook : null;
}

async function post(env: Env, row: Claimed): Promise<void> {
	try {
		const hook = await takes(env, row);
		if (!hook) return await finish(env, row, 'skipped', 'The webhook was paused or changed.');
		const { event } = JSON.parse(row.body) as { event: string };
		const result = await sendEvent(env, hook, event, row.eventId, row.body);
		const wait = RETRY_S[row.attempts - 1];
		const again = !result.ok && result.retry && wait !== undefined;
		// still failing after every wait: the receiver is gone, and the webhook is paused
		const abandoned = !result.ok && result.retry && wait === undefined;
		const state = result.ok ? 'delivered' : 'failed';
		const outcome = (result.ok ? `Answered ${result.status}.` : result.error).slice(0, 300);
		// The webhook's last result and the POST move together, and only while this worker owns them.
		await withOwnedTransaction(env, async (tx) => {
			await noteResult(tx, hook.id, result);
			if (abandoned) {
				await tx
					.update(jsonWebhooks)
					.set({ enabled: false, lastError: NO_ANSWER, updatedAt: new Date() })
					.where(eq(jsonWebhooks.id, hook.id));
				await skipQueued(tx, [hook.id], 'The webhook was paused.');
			}
			await tx
				.update(jsonWebhookPosts)
				.set(
					again
						? {
								state: 'pending',
								outcome,
								leaseUntil: null,
								notBefore: sql`now() + (${wait} || ' seconds')::interval`
							}
						: { state, outcome, doneAt: new Date(), leaseUntil: null }
				)
				.where(and(eq(jsonWebhookPosts.id, row.id), eq(jsonWebhookPosts.state, 'sending')));
		});
		if (!again) jsonWebhookPostsDone.inc({ outcome: state });
		if (abandoned)
			await writeAudit(env, null, {
				actorName: 'system',
				orgId: hook.orgId,
				category: 'org',
				action: 'org.jsonhook.pause',
				target: hook.label,
				outcome: 'error',
				message: NO_ANSWER,
				detail: { orgId: hook.orgId, webhookId: hook.id, hint: hook.urlHint }
			}).catch((err) => console.error('[warcon] json webhook pause audit', forLog(err)));
	} catch (err) {
		if (err instanceof LostOwnership) return; // its lease runs out and it goes out again
		console.error('[warcon] json webhook post', forLog(err));
		await finish(env, row, 'failed', 'Could not send.').catch(() => {});
	}
}

async function finish(
	env: Env,
	row: Claimed,
	state: 'skipped' | 'failed',
	outcome: string
): Promise<void> {
	await withOwnedTransaction(env, (tx) =>
		tx
			.update(jsonWebhookPosts)
			.set({ state, outcome, doneAt: new Date(), leaseUntil: null })
			.where(and(eq(jsonWebhookPosts.id, row.id), eq(jsonWebhookPosts.state, 'sending')))
	);
	jsonWebhookPostsDone.inc({ outcome: state });
}
