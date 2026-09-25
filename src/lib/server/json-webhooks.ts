// An organisation's JSON webhooks: list, add, edit, remove and test, for its owners (the routes
// check). The address and the signing secret are credentials: stored encrypted, the address shown
// as its host, the secret shown once when it is made. What they carry is json-webhook-events.ts,
// how it is queued json-webhook-queue.ts, how it is sent json-webhook-send.ts.
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId, str } from './http';
import { encryptSecret } from './crypto';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { jsonWebhooks, organizations, type JsonWebhookRow } from './db/schema';
import { assertReachableTarget } from './hostpolicy';
import { mayUsePrivateHosts } from './servers';
import { parseServerScope } from './server-scope';
import { JSON_WEBHOOK_EVENTS, type JsonWebhookEvent } from './json-webhook-events';
import { skipQueued } from './json-webhook-queue';
import {
	newSigningSecret,
	noteResult,
	parseEndpointUrl,
	sendEvent,
	type SendResult
} from './json-webhook-send';
import type { JsonWebhookView } from '$lib/types';

export { JSON_WEBHOOK_EVENT_LABELS } from './json-webhook-events';

/** How many an organisation keeps: each grant is one POST per webhook, so this bounds the fan-out. */
export const MAX_JSON_WEBHOOKS = 10;

const shape = (w: JsonWebhookRow): JsonWebhookView => ({
	id: w.id,
	label: w.label,
	urlHint: w.urlHint,
	events: (w.events as string[]) || [],
	serverIds: (w.serverIds as string[] | null) ?? null,
	enabled: w.enabled,
	lastSentAt: w.lastSentAt ? w.lastSentAt.toISOString() : null,
	lastStatus: w.lastStatus,
	lastError: w.lastError,
	createdAt: w.createdAt ? w.createdAt.toISOString() : null
});

function parseEvents(raw: unknown): JsonWebhookEvent[] {
	const list = Array.isArray(raw) ? raw : [];
	const events = JSON_WEBHOOK_EVENTS.filter((e) => list.includes(e));
	if (!events.length) throw new ApiError(400, 'Pick at least one kind of event to send.');
	return events;
}

/**
 * Refuses an address Warcon may not send to, in words for the owner typing it: a host that does
 * not resolve, one on a private network (unless the site owner is saving it) or a link-local one.
 * Answers whether the webhook needs the private-network allowance: only when the site owner saves
 * an address that is private now, so a public one they save cannot be re-pointed inside later.
 */
async function checkAddress(host: string, user: SessionUser): Promise<boolean> {
	const allowPrivate = mayUsePrivateHosts(user);
	try {
		const resolved = await assertReachableTarget(host, allowPrivate);
		return resolved.some((r) => r.kind === 'private');
	} catch (err) {
		if (!(err instanceof ApiError)) throw err;
		if (err.code === 'unresolvable')
			throw new ApiError(400, 'That host does not resolve.', 'unresolvable');
		throw new ApiError(
			403,
			allowPrivate
				? 'That address is link-local; a webhook never goes there.'
				: 'That address is on a private network; a JSON webhook goes to a public address.',
			'blocked_host'
		);
	}
}

export async function listJsonWebhooks(env: Env, orgId: string): Promise<JsonWebhookView[]> {
	const rows = await env.db
		.select()
		.from(jsonWebhooks)
		.where(eq(jsonWebhooks.orgId, orgId))
		.orderBy(asc(jsonWebhooks.createdAt));
	return rows.map(shape);
}

async function webhookOf(env: Env, orgId: string, id: string): Promise<JsonWebhookRow> {
	const [row] = await env.db
		.select()
		.from(jsonWebhooks)
		.where(and(eq(jsonWebhooks.id, id), eq(jsonWebhooks.orgId, orgId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Webhook not found.');
	return row;
}

/** Adds one; the answer carries the signing secret, the only time it is shown. */
export async function createJsonWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<{ webhook: JsonWebhookView; secret: string }> {
	const endpoint = parseEndpointUrl(body.url);
	const events = parseEvents(body.events);
	const allowPrivate = await checkAddress(endpoint.host, user);
	const serverIds = await parseServerScope(env, org.id, body.serverIds);
	const label = str(body.label, 60) || endpoint.host;
	const secret = newSigningSecret();
	// Counted and added under the organisation's row lock, so two saves at once cannot pass the cap.
	const row = await env.db.transaction(async (tx) => {
		await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.id, org.id))
			.for('update');
		const [{ n }] = await tx
			.select({ n: count() })
			.from(jsonWebhooks)
			.where(eq(jsonWebhooks.orgId, org.id));
		if (n >= MAX_JSON_WEBHOOKS)
			throw new ApiError(400, `An organisation keeps ${MAX_JSON_WEBHOOKS} JSON webhooks at most.`);
		const [made] = await tx
			.insert(jsonWebhooks)
			.values({
				id: newId(),
				orgId: org.id,
				label,
				urlEnc: encryptSecret(env, endpoint.url),
				urlHint: endpoint.hint,
				secretEnc: encryptSecret(env, secret),
				events,
				serverIds,
				enabled: body.enabled === undefined ? true : !!body.enabled,
				allowPrivate,
				createdBy: user.id
			})
			.returning();
		return made;
	});
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.jsonhook.create',
		target: label,
		outcome: 'ok',
		detail: { orgId: org.id, webhookId: row.id, hint: endpoint.hint, events, serverIds }
	});
	return { webhook: shape(row), secret };
}

/**
 * Edits one. A new address is checked like a first one and made by whoever saves it; `signing:
 * "new"` makes a new secret, returned once, and the old one stops matching at once.
 */
export async function updateJsonWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string,
	body: Record<string, unknown>
): Promise<{ webhook: JsonWebhookView; secret?: string }> {
	const row = await webhookOf(env, org.id, id);
	const set: Partial<typeof jsonWebhooks.$inferInsert> = {};
	const changes: Record<string, unknown> = {};
	if (body.label !== undefined) changes.label = set.label = str(body.label, 60) || row.label;
	if (typeof body.url === 'string' && body.url.trim()) {
		const endpoint = parseEndpointUrl(body.url);
		set.allowPrivate = await checkAddress(endpoint.host, user);
		set.urlEnc = encryptSecret(env, endpoint.url);
		set.urlHint = endpoint.hint;
		set.lastError = '';
		set.lastStatus = null;
		changes.hint = endpoint.hint;
	}
	if (body.events !== undefined) changes.events = set.events = parseEvents(body.events);
	if (body.serverIds !== undefined)
		changes.serverIds = set.serverIds = await parseServerScope(env, org.id, body.serverIds);
	if (body.enabled !== undefined) {
		changes.enabled = set.enabled = !!body.enabled;
		// enabled again by an owner: whatever paused it is theirs to have seen
		if (set.enabled) set.lastError = '';
	}
	let secret: string | undefined;
	if (body.signing === 'new') {
		secret = newSigningSecret();
		set.secretEnc = encryptSecret(env, secret);
		changes.signing = 'new';
	}
	if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(jsonWebhooks)
		.set(set)
		.where(eq(jsonWebhooks.id, row.id))
		.returning();
	// a paused webhook gets nothing, not even what was waiting for it
	if (set.enabled === false) await skipQueued(env.db, [row.id], 'The webhook was paused.');
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.jsonhook.update',
		target: updated.label,
		outcome: 'ok',
		detail: { orgId: org.id, webhookId: row.id, ...changes }
	});
	return secret ? { webhook: shape(updated), secret } : { webhook: shape(updated) };
}

/** Removes one; POSTs still queued for it are dropped when their turn comes. */
export async function deleteJsonWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<void> {
	const row = await webhookOf(env, org.id, id);
	await env.db.delete(jsonWebhooks).where(eq(jsonWebhooks.id, row.id));
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.jsonhook.delete',
		target: row.label,
		outcome: 'ok',
		detail: { orgId: org.id, webhookId: row.id, hint: row.urlHint }
	});
}

/** Sends a `ping` event now, signed like any other, and records how it went on the webhook. */
export async function testJsonWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<SendResult> {
	const row = await webhookOf(env, org.id, id);
	const eventId = `ping-${randomUUID()}`;
	const result = await sendEvent(
		env,
		row,
		'ping',
		eventId,
		JSON.stringify({
			event: 'ping',
			id: eventId,
			at: new Date().toISOString(),
			org: { id: org.id, name: org.name }
		})
	);
	await noteResult(env.db, row.id, result);
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.jsonhook.test',
		target: row.label,
		outcome: result.ok ? 'ok' : 'error',
		status: result.status ?? undefined,
		message: result.ok ? 'Test event delivered.' : result.error,
		detail: { orgId: org.id, webhookId: row.id }
	});
	return result;
}
