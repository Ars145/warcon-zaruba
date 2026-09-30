// A webhook's status cards while its owner changes it and the worker is posting one. Pausing it,
// switching its cards off, giving it a new URL or removing it takes down every card of what it was,
// the one the worker posts in the middle of the change too, whichever of the two lands first:
// Discord is left showing the cards the webhook keeps and nothing else.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { webhooks } from '$lib/server/db/schema';
import { encryptSecret } from '$lib/server/crypto';
import { newId } from '$lib/server/http';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import { refreshStatusMessages, resetStatusMirror } from '$lib/server/webhook-status';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const ROUTE = join(
	import.meta.dir,
	'..',
	'routes',
	'api',
	'orgs',
	'[id]',
	'webhooks',
	'[webhookId]'
);

describe.skipIf(!hasTestDb)('status cards while their webhook changes', () => {
	let env: Env;
	let w: World;
	const realFetch = globalThis.fetch;
	/** Discord as the stub keeps it: each webhook's messages, by the token in its URL */
	const discord = new Map<string, Set<string>>();
	let made = 0;
	/** runs when Discord is asked for a new message, before it answers */
	let onPost: ((token: string) => Promise<void>) | null = null;
	/** runs when Discord takes a message down, before it answers */
	let onDelete: ((token: string, id: string) => Promise<void>) | null = null;

	const messagesOf = (token: string) => {
		if (!discord.has(token)) discord.set(token, new Set());
		return discord.get(token)!;
	};
	const newToken = () => randomBytes(34).toString('hex');
	const urlOf = (token: string) => `https://discord.com/api/webhooks/123456789012345678/${token}`;

	/** The owner's change, through the route the panel calls. */
	const change = async (method: 'PATCH' | 'DELETE', id: string, body?: Record<string, unknown>) => {
		const mod = await import(join(ROUTE, '+server.ts'));
		const res = await callApi(mod[method], w.users.owner, {
			method,
			params: { id: w.org.id, webhookId: id },
			body
		});
		expect(res.status).toBe(200);
	};
	const CHANGES: {
		name: string;
		run: (id: string, token: string) => Promise<void>;
		/** the webhook's token afterwards, or null once it keeps no cards */
		after: (token: string) => string | null;
	}[] = [
		{ name: 'paused', run: (id) => change('PATCH', id, { enabled: false }), after: () => null },
		{
			name: 'cards switched off',
			run: (id) => change('PATCH', id, { statusEnabled: false, events: ['bans'] }),
			after: () => null
		},
		{
			name: 'given a new URL',
			run: (id, token) => change('PATCH', id, { url: urlOf(token + 'new') }),
			after: (token) => token + 'new'
		},
		{ name: 'removed', run: (id) => change('DELETE', id), after: () => null }
	];

	/** A webhook keeping a card for each of the org's two servers, one of them already posted. */
	const setUp = async () => {
		// only this webhook's cards are refreshed by the passes below
		await env.db.update(webhooks).set({ statusEnabled: false }).where(eq(webhooks.orgId, w.org.id));
		const token = newToken();
		messagesOf(token).add('posted');
		const id = newId();
		await env.db.insert(webhooks).values({
			id,
			orgId: w.org.id,
			label: 'status',
			urlEnc: encryptSecret(env, urlOf(token)),
			events: [],
			statusEnabled: true,
			statusMessages: { [w.server.id]: 'posted' }
		});
		resetStatusMirror();
		return { id, token };
	};

	/** Discord shows the cards the webhook keeps, and no other. */
	const settled = async (id: string, tokens: string[]) => {
		const [row] = await env.db.select().from(webhooks).where(eq(webhooks.id, id));
		const kept = Object.values((row?.statusMessages as Record<string, string> | null) ?? {});
		const shown = tokens.flatMap((t) => [...messagesOf(t)]);
		expect(shown.sort()).toEqual(kept.sort());
	};

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const [, , , , token, , id] = new URL(String(url)).pathname.split('/');
			const messages = messagesOf(token);
			const method = init?.method ?? 'GET';
			if (method === 'DELETE') {
				messages.delete(id);
				if (onDelete) await onDelete(token, id);
				return new Response(null, { status: 204 });
			}
			if (method === 'PATCH')
				return messages.has(id)
					? Response.json({ id })
					: Response.json({ message: 'Unknown Message', code: 10008 }, { status: 404 });
			if (onPost) await onPost(token);
			const posted = `m${++made}`;
			messages.add(posted);
			return Response.json({ id: posted });
		}) as typeof fetch;
	});

	afterAll(async () => {
		// the database is shared by every file: leave no cards for another file's passes
		await env.db.update(webhooks).set({ statusEnabled: false }).where(eq(webhooks.orgId, w.org.id));
		globalThis.fetch = realFetch;
		onPost = onDelete = null;
		resetWebhookQueues();
		resetStatusMirror();
	});

	for (const c of CHANGES) {
		test(`${c.name} while the worker's new card is on its way`, async () => {
			const { id, token } = await setUp();
			// another file's webhooks may share the pass; only this one's card is held up
			onPost = async (to) => {
				if (to !== token) return;
				onPost = null;
				await c.run(id, token);
			};
			await refreshStatusMessages(env);
			const tokens = [token, c.after(token)].filter((t): t is string => !!t);
			await settled(id, tokens);
			await refreshStatusMessages(env);
			await settled(id, tokens);
		});

		test(`the worker's new card lands while the webhook is ${c.name}`, async () => {
			const { id, token } = await setUp();
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			let posting!: () => void;
			const atPost = new Promise<void>((r) => (posting = r));
			onPost = async (to) => {
				if (to !== token) return;
				onPost = null;
				posting();
				await held;
			};
			const pass = refreshStatusMessages(env);
			// the worker has read the webhook and is posting the card of the server that has none
			await atPost;
			onDelete = async (to, message) => {
				if (to !== token || message !== 'posted') return;
				onDelete = null;
				release();
				await pass;
			};
			await c.run(id, token);
			await pass;
			const tokens = [token, c.after(token)].filter((t): t is string => !!t);
			await settled(id, tokens);
			await refreshStatusMessages(env);
			await settled(id, tokens);
		});
	}
});
