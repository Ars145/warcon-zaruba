// JSON webhooks: who may keep them and what they give back (never the address or the secret after
// the one showing), and the queue: a Seeding reward grant becomes one signed POST per webhook of the
// grant's organisation that takes it, one in flight per webhook, sent again on no answer with the
// webhook's other POSTs waiting behind it, refused at send time for an address that became
// private, never for another organisation, and never in the way of a game action.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq, like } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	jsonWebhookPosts,
	jsonWebhooks,
	listEntries,
	outbox,
	servers
} from '$lib/server/db/schema';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { recentOutbox, startDelivery, stopDelivery } from '$lib/server/outbox';
import { revokeMintedBy } from '$lib/server/orgs';
import { signature } from '$lib/server/json-webhook-send';
import {
	queueEvent,
	startJsonWebhookPosts,
	stopJsonWebhookPosts
} from '$lib/server/json-webhook-queue';
import type { JsonWebhookView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';
import {
	GET as listRoute,
	POST as createRoute
} from '../routes/api/orgs/[id]/json-webhooks/+server';
import {
	DELETE as deleteRoute,
	PATCH as patchRoute
} from '../routes/api/orgs/[id]/json-webhooks/[webhookId]/+server';
import { POST as testRoute } from '../routes/api/orgs/[id]/json-webhooks/[webhookId]/test/+server';

const TOKEN = 'path-token-9f8e7d';
/** a grant, then its POST, each wait for a tick of their loop (one a second) */
const DELIVERY_MS = 20_000;
const PUBLIC = (path: string) => `https://93.184.216.34/${path}/${TOKEN}`;

interface Made {
	webhook: JsonWebhookView;
	secret: string;
}

describe.skipIf(!hasTestDb)('JSON webhooks', () => {
	let env: Env;
	let w: World;
	const realFetch = globalThis.fetch;
	/** what the stubbed receivers were sent, and what the next ones answer */
	let posts: { url: string; headers: Record<string, string>; body: string }[] = [];
	let status = 200;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		w = await seedWorld(env);
		globalThis.fetch = (async (url: string | URL, init?: BunFetchRequestInit) => {
			posts.push({
				url: String(url),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: String(init?.body ?? '')
			});
			// a receiver that takes the connection and never answers: only the send's timeout ends it
			if (String(url).includes('/hang/'))
				return new Promise<Response>((_, reject) =>
					init?.signal?.addEventListener('abort', () => {
						const err = new Error('timed out');
						err.name = 'TimeoutError';
						reject(err);
					})
				);
			return new Response(null, { status });
		}) as typeof fetch;
	});

	afterAll(async () => {
		globalThis.fetch = realFetch;
		stopDelivery();
		stopJsonWebhookPosts();
		await releaseOwnership(env);
	});

	const create = (who: PrincipalName, body: Record<string, unknown>, orgId = w.org.id) =>
		callApi(createRoute, w.users[who], { method: 'POST', params: { id: orgId }, body });
	const made = (answer: { body: unknown }) => answer.body as Made & { ok: boolean };
	const rowOf = async (id: string) =>
		(await env.db.select().from(jsonWebhooks).where(eq(jsonWebhooks.id, id)))[0];
	/** a webhook one test needed, gone so the organisation stays under its ten */
	const drop = (id: string) => env.db.delete(jsonWebhooks).where(eq(jsonWebhooks.id, id));

	describe('the records', () => {
		test('an owner adds one: the secret once, the host only, the address kept encrypted', async () => {
			const answer = await create('owner', {
				label: 'Memberships DB',
				url: PUBLIC('hooks'),
				events: ['seed_reward'],
				serverIds: null
			});
			expect(answer.status).toBe(201);
			const { webhook, secret } = made(answer);
			expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
			expect(webhook.urlHint).toBe('93.184.216.34/…');
			expect(JSON.stringify(webhook)).not.toContain(TOKEN);
			expect(JSON.stringify(webhook)).not.toContain(secret);
			const row = await rowOf(webhook.id);
			expect(decryptSecret(env, row.urlEnc)).toBe(PUBLIC('hooks'));
			expect(decryptSecret(env, row.secretEnc)).toBe(secret);
			expect(row.allowPrivate).toBe(false);

			const list = await callApi(listRoute, w.users.owner, { params: { id: w.org.id } });
			expect(list.status).toBe(200);
			expect(JSON.stringify(list.body)).not.toContain(TOKEN);
			expect(JSON.stringify(list.body)).not.toContain(secret);
			expect(JSON.stringify(list.body)).not.toContain(row.urlEnc);
		});

		test('an address on a private network is the site owner’s to add; link-local nobody’s', async () => {
			const priv = { url: 'https://10.0.0.5/in', events: ['seed_reward'], serverIds: null };
			const refused = await create('owner', priv);
			expect([refused.status, refused.code]).toEqual([403, 'blocked_host']);
			const site = await create('site', priv);
			expect(site.status).toBe(201);
			expect((await rowOf(made(site).webhook.id)).allowPrivate).toBe(true);
			// a public address the site owner saves gets no allowance: it cannot be re-pointed inside
			const sitePublic = await create('site', {
				url: PUBLIC('site-public'),
				events: ['seed_reward'],
				serverIds: null
			});
			expect((await rowOf(made(sitePublic).webhook.id)).allowPrivate).toBe(false);
			await drop(made(sitePublic).webhook.id);
			for (const who of ['owner', 'site'] as const) {
				const meta = await create(who, {
					url: 'https://169.254.169.254/latest/meta-data',
					events: ['seed_reward'],
					serverIds: null
				});
				expect([meta.status, meta.code]).toEqual([403, 'blocked_host']);
			}
		});

		test('https only, no credentials in the address, at least one event', async () => {
			for (const body of [
				{ url: 'http://93.184.216.34/in', events: ['seed_reward'] },
				{ url: 'https://me:pw@93.184.216.34/in', events: ['seed_reward'] },
				{ url: PUBLIC('in'), events: [] },
				{ url: PUBLIC('in'), events: ['bans'] }
			])
				expect((await create('owner', { ...body, serverIds: null })).status).toBe(400);
		});

		test('an organisation keeps ten at most', async () => {
			const fresh = await seedWorld(env);
			const add = () =>
				callApi(createRoute, fresh.users.owner, {
					method: 'POST',
					params: { id: fresh.org.id },
					body: { url: PUBLIC('many'), events: ['seed_reward'], serverIds: null }
				});
			// saved at once: counted and added under the org's row lock, so the cap holds
			const answers = await Promise.all(Array.from({ length: 12 }, add));
			expect(answers.filter((a) => a.status === 201)).toHaveLength(10);
			expect(answers.filter((a) => a.status === 400).map((a) => a.message)).toEqual([
				'An organisation keeps 10 JSON webhooks at most.',
				'An organisation keeps 10 JSON webhooks at most.'
			]);
		});

		test('another organisation’s webhook is not found through this one', async () => {
			const theirs = made(
				await create(
					'outsider',
					{ url: PUBLIC('theirs'), events: ['seed_reward'], serverIds: null },
					w.otherOrg.id
				)
			).webhook;
			const params = { id: w.org.id, webhookId: theirs.id };
			for (const [route, method, body] of [
				[patchRoute, 'PATCH', { label: 'mine now', url: PUBLIC('mine') }],
				[deleteRoute, 'DELETE', {}],
				[testRoute, 'POST', {}]
			] as const) {
				const answer = await callApi(route, w.users.owner, { method, params, body });
				expect([answer.status, answer.message]).toEqual([404, 'Webhook not found.']);
			}
			const row = await rowOf(theirs.id);
			expect(row.label).not.toBe('mine now');
			expect(decryptSecret(env, row.urlEnc)).toBe(PUBLIC('theirs'));
		});

		test('a new secret comes back once and replaces the old; audit rows carry neither', async () => {
			const first = made(
				await create('owner', { url: PUBLIC('rotate'), events: ['seed_reward'], serverIds: null })
			);
			const answer = await callApi(patchRoute, w.users.owner, {
				method: 'PATCH',
				params: { id: w.org.id, webhookId: first.webhook.id },
				body: { signing: 'new' }
			});
			expect(answer.status).toBe(200);
			const second = (answer.body as { secret: string }).secret;
			expect(second).toMatch(/^whsec_[0-9a-f]{48}$/);
			expect(second).not.toBe(first.secret);
			expect(decryptSecret(env, (await rowOf(first.webhook.id)).secretEnc)).toBe(second);
			const quiet = await callApi(patchRoute, w.users.owner, {
				method: 'PATCH',
				params: { id: w.org.id, webhookId: first.webhook.id },
				body: { label: 'Renamed' }
			});
			expect((quiet.body as { secret?: string }).secret).toBeUndefined();

			const rows = await env.db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.orgId, w.org.id), like(auditLog.action, 'org.jsonhook.%')));
			expect(rows.length).toBeGreaterThan(0);
			const text = JSON.stringify(rows);
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain(first.secret);
			expect(text).not.toContain(second);
		});

		test('a test event is signed, and its answer recorded on the webhook', async () => {
			const hook = made(
				await create('owner', { url: PUBLIC('ping'), events: ['seed_reward'], serverIds: null })
			);
			posts = [];
			status = 204;
			const answer = await callApi(testRoute, w.users.owner, {
				method: 'POST',
				params: { id: w.org.id, webhookId: hook.webhook.id }
			});
			status = 200;
			expect(answer.status).toBe(200);
			expect(posts).toHaveLength(1);
			const sent = JSON.parse(posts[0].body);
			expect(sent).toEqual({
				event: 'ping',
				id: posts[0].headers['x-warcon-delivery'],
				at: expect.any(String),
				org: { id: w.org.id, name: w.org.name }
			});
			const t = Number(/^t=(\d+),/.exec(posts[0].headers['x-warcon-signature'])![1]);
			expect(posts[0].headers['x-warcon-signature']).toBe(signature(hook.secret, posts[0].body, t));
			expect((await rowOf(hook.webhook.id)).lastStatus).toBe(204);
		});
	});

	describe('delivery of a grant', () => {
		let active: Made;
		let serverName = '';
		let seq = 0;
		let renewing: ReturnType<typeof setInterval> | undefined;

		const until = async (ok: () => Promise<boolean>) => {
			for (let i = 0; i < 160 && !(await ok()); i++) await Bun.sleep(50);
		};
		const postsOf = (eventId: string) =>
			env.db.select().from(jsonWebhookPosts).where(eq(jsonWebhookPosts.eventId, eventId));
		/** a grant's POSTs, found by its player: the event id is the slot entry's own id */
		const grantPosts = (g: { steamId: string }) =>
			env.db
				.select()
				.from(jsonWebhookPosts)
				.where(like(jsonWebhookPosts.body, `%"steamId":"${g.steamId}"%`));
		const setUrl = (id: string, url: string) =>
			env.db
				.update(jsonWebhooks)
				.set({ urlEnc: encryptSecret(env, url) })
				.where(eq(jsonWebhooks.id, id));
		/** a Seeding reward grant as the rule queues it, for a new player each time */
		async function grant(): Promise<{ id: number; steamId: string }> {
			const steamId = `765611980000031${String(++seq).padStart(2, '0')}`;
			const [row] = await env.db
				.insert(outbox)
				.values({
					serverId: w.server.id,
					triggerName: 'Seeding reward',
					triggerKind: 'seed_reward',
					action: 'seed_reward',
					params: {
						steamId,
						name: `Seeder ${seq}`,
						reason: 'Seeded: 64 min with 20 or fewer on',
						slotDays: 7,
						scope: 'server'
					},
					target: steamId,
					detail: { name: `Seeder ${seq}`, minutes: 64, slotDays: 7 },
					okMessage: `Reserved a slot for Seeder ${seq}.`,
					dedupeKey: `json-webhook-grant-${steamId}`
				})
				.returning({ id: outbox.id });
			return { id: row.id, steamId };
		}

		beforeAll(async () => {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
			serverName = server.name;
			// Only this one takes grants on this server: the others are paused, for another
			// server, or of another organisation.
			await env.db.update(jsonWebhooks).set({ enabled: false });
			active = made(
				await create('owner', { url: PUBLIC('grants'), events: ['seed_reward'], serverIds: null })
			);
			await create('owner', {
				url: PUBLIC('paused'),
				events: ['seed_reward'],
				serverIds: null,
				enabled: false
			});
			await create('owner', {
				url: PUBLIC('other-server'),
				events: ['seed_reward'],
				serverIds: [w.otherServer.id]
			});
			await create(
				'outsider',
				{ url: PUBLIC('other-org'), events: ['seed_reward'], serverIds: null },
				w.otherOrg.id
			);
			expect(await acquireOrRenew(env, 'json-webhooks')).toBe(true);
			// the worker renews its lease as it runs; these tests take longer than one lease
			renewing = setInterval(() => void acquireOrRenew(env, 'json-webhooks'), 5000);
			startDelivery(env);
			startJsonWebhookPosts(env);
		});

		afterAll(() => clearInterval(renewing));

		// each test starts from receivers that answer 200 and an empty queue, whatever the one
		// before left (a POST waiting for a retry holds its webhook's others back, as it should)
		beforeEach(async () => {
			posts = [];
			status = 200;
			await env.db
				.update(jsonWebhookPosts)
				.set({ state: 'skipped', outcome: 'Left by an earlier test.' })
				.where(eq(jsonWebhookPosts.state, 'pending'));
		});

		test(
			'one signed POST, to the one webhook that takes grants on this server',
			async () => {
				posts = [];
				status = 200;
				const g = await grant();
				await until(async () => (await grantPosts(g)).some((r) => r.state === 'delivered'));
				const queued = await grantPosts(g);
				expect(queued.map((r) => [r.webhookId, r.state, r.kind])).toEqual([
					[active.webhook.id, 'delivered', 'seed_reward']
				]);
				expect(posts.map((p) => p.url)).toEqual([`https://93.184.216.34:443/grants/${TOKEN}`]);
				const [entry] = await env.db
					.select({ id: listEntries.id })
					.from(listEntries)
					.where(eq(listEntries.steamId, g.steamId));
				const eventId = `seed_reward.granted:${entry.id}`;
				expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
				const body = JSON.parse(posts[0].body);
				expect(Object.keys(body).slice(0, 3)).toEqual(['event', 'id', 'at']);
				expect(body).toEqual({
					event: 'seed_reward.granted',
					id: eventId,
					at: expect.any(String),
					org: { id: w.org.id, name: w.org.name },
					server: { id: w.server.id, name: serverName },
					player: { steamId: g.steamId, name: `Seeder ${seq}` },
					slot: { scope: 'server', expiresAt: expect.any(String), days: 7 },
					rule: { id: null, name: 'Seeding reward' },
					seedMinutes: 64
				});
				const days = (Date.parse(body.slot.expiresAt) - Date.now()) / 86_400_000;
				expect(days).toBeGreaterThan(6.9);
				expect(days).toBeLessThan(7.01);
				expect(posts[0].headers['x-warcon-event']).toBe('seed_reward.granted');
				expect(posts[0].headers['x-warcon-delivery']).toBe(eventId);
				const t = Number(/^t=(\d+),/.exec(posts[0].headers['x-warcon-signature'])![1]);
				expect(posts[0].headers['x-warcon-signature']).toBe(
					signature(active.secret, posts[0].body, t)
				);
				const hook = await rowOf(active.webhook.id);
				expect([hook.lastStatus, hook.lastError]).toEqual([200, '']);
				// the game actions' queue holds the grant and nothing of the POST
				const actions = (await recentOutbox(env, w.server.id)).map((r) => r.action);
				expect(actions).toEqual(['seed_reward']);
			},
			DELIVERY_MS
		);

		test(
			'a burst to one webhook drains as fast as the receiver answers, one at a time',
			async () => {
				const started = Date.now();
				for (let key = 1; key <= 5; key++)
					await queueEvent(env.db, {
						kind: 'seed_reward',
						event: 'burst.test',
						key: String(key),
						orgId: w.org.id,
						serverId: w.server.id,
						fields: {}
					});
				await until(async () =>
					(
						await env.db
							.select()
							.from(jsonWebhookPosts)
							.where(like(jsonWebhookPosts.eventId, 'burst.test:%'))
					).every((r) => r.state === 'delivered')
				);
				// one at a tick would be five ticks, a second apart
				expect(Date.now() - started).toBeLessThan(2500);
				expect(posts.map((p) => JSON.parse(p.body).id)).toEqual(
					[1, 2, 3, 4, 5].map((k) => `burst.test:${k}`)
				);
			},
			DELIVERY_MS
		);

		test(
			'no answer: the POST waits for its retry, and the webhook’s other POSTs wait behind it',
			async () => {
				posts = [];
				status = 503;
				const first = await grant();
				const second = await grant();
				// the outbox may deliver either grant first: whichever POST is tried, the other waits
				const both = async () => [...(await grantPosts(first)), ...(await grantPosts(second))];
				await until(async () =>
					(await both()).some((r) => r.attempts === 1 && r.state === 'pending')
				);
				// a few ticks later the other has still not been tried: one attempt, not one per event
				await Bun.sleep(2500);
				const rows = await both();
				const tried = rows.find((r) => r.attempts === 1)!;
				const held = rows.find((r) => r.id !== tried.id)!;
				expect([tried.state, tried.attempts, tried.outcome]).toEqual([
					'pending',
					1,
					'Answered 503.'
				]);
				expect(tried.notBefore.getTime()).toBeGreaterThan(Date.now() + 50_000);
				expect([held.state, held.attempts]).toEqual(['pending', 0]);
				expect(posts).toHaveLength(1);
				expect((await rowOf(active.webhook.id)).lastError).toBe('Answered 503.');
				// the receiver is back and the retry is due: it goes first, then what waited behind it
				status = 200;
				await env.db
					.update(jsonWebhookPosts)
					.set({ notBefore: new Date() })
					.where(eq(jsonWebhookPosts.id, tried.id));
				await until(async () => (await both()).every((r) => r.state === 'delivered'));
				const done = await both();
				expect(done.find((r) => r.id === tried.id)?.attempts).toBe(2);
				expect(done.find((r) => r.id === held.id)?.attempts).toBe(1);
				expect(posts.map((p) => JSON.parse(p.body).id)).toEqual([
					tried.eventId,
					tried.eventId,
					held.eventId
				]);
				expect(posts[1].body).toBe(posts[0].body);
			},
			DELIVERY_MS
		);

		test(
			'an answer such as a 404 is final, and holds nothing back',
			async () => {
				posts = [];
				status = 404;
				const first = await grant();
				const second = await grant();
				await until(async () =>
					(await Promise.all([first, second].map((g) => grantPosts(g)))).every(
						([row]) => row?.state === 'failed'
					)
				);
				for (const g of [first, second]) {
					const [row] = await grantPosts(g);
					expect([row.state, row.attempts, row.outcome]).toEqual(['failed', 1, 'Answered 404.']);
				}
				expect(posts).toHaveLength(2);
				status = 200;
			},
			DELIVERY_MS
		);

		test(
			'an address that turned private is refused at send time, and nothing is sent',
			async () => {
				await setUrl(active.webhook.id, 'https://10.0.0.9/grants');
				posts = [];
				const g = await grant();
				await until(async () => (await grantPosts(g)).some((r) => r.state === 'failed'));
				const [row] = await grantPosts(g);
				expect([row.state, row.outcome]).toEqual([
					'failed',
					'The address is not one Warcon may send to.'
				]);
				expect(posts).toHaveLength(0);
				await setUrl(active.webhook.id, PUBLIC('grants'));
			},
			DELIVERY_MS
		);

		test(
			'a receiver that hangs holds up neither a game action nor another webhook',
			async () => {
				await setUrl(active.webhook.id, PUBLIC('hang'));
				const other = made(
					await create('owner', { url: PUBLIC('fine'), events: ['seed_reward'], serverIds: null })
				);
				const first = await grant();
				const hung = async () =>
					(await grantPosts(first)).find((r) => r.webhookId === active.webhook.id)!;
				await until(async () => (await hung())?.state === 'sending');
				// the hung POST is in flight and will be for seconds: a game action is queued now...
				const [action] = await env.db
					.insert(outbox)
					.values({
						serverId: w.server.id,
						triggerName: 'Scheduled broadcast',
						triggerKind: 'broadcast',
						action: 'broadcast',
						params: { message: 'Seed with us tonight' },
						target: 'Seed with us tonight',
						dedupeKey: `json-webhook-hang-${first.id}`
					})
					.returning({ id: outbox.id });
				// ...and another grant, which the healthy webhook takes too
				const second = await grant();
				const queuedAt = Date.now();
				const actionState = async () =>
					(await env.db.select().from(outbox).where(eq(outbox.id, action.id)))[0].state;
				const fine = async () =>
					(await grantPosts(second)).find((r) => r.webhookId === other.webhook.id)?.state;
				await until(
					async () => (await actionState()) !== 'pending' && (await fine()) === 'delivered'
				);
				expect(Date.now() - queuedAt).toBeLessThan(3000);
				expect((await hung()).state).toBe('sending');
				// the hung POST gives up at the send's timeout and waits for its retry
				await until(async () => (await hung()).state === 'pending');
				expect([(await hung()).state, (await hung()).outcome]).toEqual([
					'pending',
					'Could not deliver (no answer in time).'
				]);
				await setUrl(active.webhook.id, PUBLIC('grants'));
				await drop(other.webhook.id);
				// what waits for the hung webhook goes out once it is due
				await env.db
					.update(jsonWebhookPosts)
					.set({ notBefore: new Date() })
					.where(eq(jsonWebhookPosts.webhookId, active.webhook.id));
				await until(async () =>
					(
						await env.db
							.select()
							.from(jsonWebhookPosts)
							.where(eq(jsonWebhookPosts.webhookId, active.webhook.id))
					).every((r) => r.state !== 'pending' && r.state !== 'sending')
				);
			},
			DELIVERY_MS
		);

		test(
			'a POST cut off by a worker stop goes out again, within the attempts a retry would have had',
			async () => {
				const own = made(
					await create('owner', { url: PUBLIC('cut'), events: ['seed_reward'], serverIds: null })
				);
				const lapsed = new Date(Date.now() - 60_000);
				const [again, spent] = await env.db
					.insert(jsonWebhookPosts)
					.values(
						[1, 8].map((attempts) => ({
							webhookId: own.webhook.id,
							serverId: w.server.id,
							kind: 'seed_reward',
							eventId: `seed_reward.granted:cut-${attempts}`,
							body: JSON.stringify({
								event: 'seed_reward.granted',
								id: `seed_reward.granted:cut-${attempts}`
							}),
							state: 'sending',
							attempts,
							leaseUntil: lapsed
						}))
					)
					.returning({ id: jsonWebhookPosts.id });
				const stateOf = async (id: number) =>
					(await env.db.select().from(jsonWebhookPosts).where(eq(jsonWebhookPosts.id, id)))[0];
				await until(async () => (await stateOf(again.id)).state === 'delivered');
				expect([(await stateOf(again.id)).state, (await stateOf(again.id)).attempts]).toEqual([
					'delivered',
					2
				]);
				expect([(await stateOf(spent.id)).state, (await stateOf(spent.id)).outcome]).toEqual([
					'failed',
					'The worker stopped while sending.'
				]);
				expect(
					posts.filter((p) => p.url.includes('/cut/')).map((p) => JSON.parse(p.body).id)
				).toEqual(['seed_reward.granted:cut-1']);
				await drop(own.webhook.id);
			},
			DELIVERY_MS
		);

		test(
			'a POST still sending from another worker holds its webhook’s others back until it is settled',
			async () => {
				const own = made(
					await create('owner', { url: PUBLIC('held'), events: ['seed_reward'], serverIds: null })
				);
				const post = (key: string, extra: Partial<typeof jsonWebhookPosts.$inferInsert>) => ({
					webhookId: own.webhook.id,
					serverId: w.server.id,
					kind: 'seed_reward',
					eventId: `seed_reward.granted:${key}`,
					body: JSON.stringify({ event: 'seed_reward.granted', id: `seed_reward.granted:${key}` }),
					...extra
				});
				// the first went out from a worker that stopped mid-send; its lease has a moment left
				const [first, second] = await env.db
					.insert(jsonWebhookPosts)
					.values([
						post('held-1', {
							state: 'sending',
							attempts: 1,
							leaseUntil: new Date(Date.now() + 2500)
						}),
						post('held-2', {})
					])
					.returning({ id: jsonWebhookPosts.id });
				const stateOf = async (id: number) =>
					(await env.db.select().from(jsonWebhookPosts).where(eq(jsonWebhookPosts.id, id)))[0];
				await Bun.sleep(1500);
				expect([(await stateOf(second.id)).state, (await stateOf(second.id)).attempts]).toEqual([
					'pending',
					0
				]);
				expect(posts.filter((p) => p.url.includes('/held/'))).toHaveLength(0);
				// its lease runs out: it goes out again, and then the one behind it
				await until(async () => (await stateOf(second.id)).state === 'delivered');
				expect([(await stateOf(first.id)).state, (await stateOf(first.id)).attempts]).toEqual([
					'delivered',
					2
				]);
				expect(
					posts.filter((p) => p.url.includes('/held/')).map((p) => JSON.parse(p.body).id)
				).toEqual(['seed_reward.granted:held-1', 'seed_reward.granted:held-2']);
				await drop(own.webhook.id);
			},
			DELIVERY_MS
		);

		test(
			'a POST queued for another organisation’s webhook on this one’s server is dropped unsent',
			async () => {
				const [theirs] = await env.db
					.select()
					.from(jsonWebhooks)
					.where(eq(jsonWebhooks.orgId, w.otherOrg.id))
					.limit(1);
				await env.db
					.update(jsonWebhooks)
					.set({ enabled: true })
					.where(eq(jsonWebhooks.id, theirs.id));
				posts = [];
				const [row] = await env.db
					.insert(jsonWebhookPosts)
					.values({
						webhookId: theirs.id,
						serverId: w.server.id,
						kind: 'seed_reward',
						eventId: 'seed_reward.granted:crafted',
						body: JSON.stringify({
							event: 'seed_reward.granted',
							id: 'seed_reward.granted:crafted'
						})
					})
					.returning({ id: jsonWebhookPosts.id });
				const stateOf = async () =>
					(await env.db.select().from(jsonWebhookPosts).where(eq(jsonWebhookPosts.id, row.id)))[0];
				await until(async () => (await stateOf()).state === 'skipped');
				expect((await stateOf()).state).toBe('skipped');
				expect(posts).toHaveLength(0);
			},
			DELIVERY_MS
		);

		test(
			'a POST with no answer through every wait fails, and pauses its webhook',
			async () => {
				const gone = made(
					await create('owner', { url: PUBLIC('gone'), events: ['seed_reward'], serverIds: null })
				);
				status = 503;
				const later = new Date(Date.now() + 3_600_000);
				const [last, behind] = await env.db
					.insert(jsonWebhookPosts)
					.values([
						// its seventh wait is over; this is its last attempt
						{
							webhookId: gone.webhook.id,
							serverId: w.server.id,
							kind: 'seed_reward',
							eventId: 'seed_reward.granted:gone-1',
							body: JSON.stringify({
								event: 'seed_reward.granted',
								id: 'seed_reward.granted:gone-1'
							}),
							attempts: 7
						},
						{
							webhookId: gone.webhook.id,
							serverId: w.server.id,
							kind: 'seed_reward',
							eventId: 'seed_reward.granted:gone-2',
							body: JSON.stringify({
								event: 'seed_reward.granted',
								id: 'seed_reward.granted:gone-2'
							}),
							notBefore: later
						}
					])
					.returning({ id: jsonWebhookPosts.id });
				const stateOf = async (id: number) =>
					(await env.db.select().from(jsonWebhookPosts).where(eq(jsonWebhookPosts.id, id)))[0];
				await until(async () => (await stateOf(last.id)).state === 'failed');
				expect([(await stateOf(last.id)).state, (await stateOf(last.id)).attempts]).toEqual([
					'failed',
					8
				]);
				expect([(await stateOf(behind.id)).state, (await stateOf(behind.id)).outcome]).toEqual([
					'skipped',
					'The webhook was paused.'
				]);
				const hook = await rowOf(gone.webhook.id);
				expect([hook.enabled, hook.lastError]).toEqual([
					false,
					'Paused: nothing delivered for two days.'
				]);
				// written once the POST is settled
				const paused = () =>
					env.db
						.select()
						.from(auditLog)
						.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.jsonhook.pause')));
				await until(async () => (await paused()).length > 0);
				expect((await paused()).map((a) => [a.target, a.actorName, a.message])).toEqual([
					[hook.label, 'system', 'Paused: nothing delivered for two days.']
				]);
				expect(JSON.stringify(await paused())).not.toContain(TOKEN);
				// and nothing more is queued for it
				const g = await grant();
				await until(
					async () =>
						(
							await env.db
								.select()
								.from(outbox)
								.where(eq(outbox.dedupeKey, `json-webhook-grant-${g.steamId}`))
						)[0]?.state === 'delivered'
				);
				const queued = await grantPosts(g);
				expect(queued.map((r) => r.webhookId)).toEqual([active.webhook.id]);
				await drop(gone.webhook.id);
			},
			DELIVERY_MS
		);

		test('pausing a webhook skips what was waiting for it; enabling it clears why', async () => {
			const own = made(
				await create('owner', { url: PUBLIC('pause'), events: ['seed_reward'], serverIds: null })
			);
			const [waiting] = await env.db
				.insert(jsonWebhookPosts)
				.values({
					webhookId: own.webhook.id,
					serverId: w.server.id,
					kind: 'seed_reward',
					eventId: 'seed_reward.granted:pause-1',
					body: JSON.stringify({ event: 'seed_reward.granted', id: 'seed_reward.granted:pause-1' }),
					notBefore: new Date(Date.now() + 3_600_000)
				})
				.returning({ id: jsonWebhookPosts.id });
			const patch = (body: Record<string, unknown>) =>
				callApi(patchRoute, w.users.owner, {
					method: 'PATCH',
					params: { id: w.org.id, webhookId: own.webhook.id },
					body
				});
			expect((await patch({ enabled: false })).status).toBe(200);
			const [row] = await env.db
				.select()
				.from(jsonWebhookPosts)
				.where(eq(jsonWebhookPosts.id, waiting.id));
			expect([row.state, row.outcome]).toEqual(['skipped', 'The webhook was paused.']);
			await env.db
				.update(jsonWebhooks)
				.set({ lastError: 'Paused: nothing delivered for two days.' })
				.where(eq(jsonWebhooks.id, own.webhook.id));
			expect((await patch({ enabled: true })).status).toBe(200);
			const hook = await rowOf(own.webhook.id);
			expect([hook.enabled, hook.lastError]).toEqual([true, '']);
			await drop(own.webhook.id);
		});

		test('a webhook stops when whoever added it stops being an owner', async () => {
			const x = await seedWorld(env);
			const add = async (who: PrincipalName) =>
				made(
					await callApi(createRoute, x.users[who], {
						method: 'POST',
						params: { id: x.org.id },
						body: { url: PUBLIC('leaver'), events: ['seed_reward'], serverIds: null }
					})
				).webhook.id;
			const theirs = await add('owner');
			const siteOwners = await add('site');
			const [waiting] = await env.db
				.insert(jsonWebhookPosts)
				.values({
					webhookId: theirs,
					serverId: x.server.id,
					kind: 'seed_reward',
					eventId: 'seed_reward.granted:leaver-1',
					body: JSON.stringify({
						event: 'seed_reward.granted',
						id: 'seed_reward.granted:leaver-1'
					}),
					notBefore: new Date(Date.now() + 3_600_000)
				})
				.returning({ id: jsonWebhookPosts.id });
			// what removing or demoting them runs, with their keys and links
			const ended = await revokeMintedBy(env.db, x.users.owner!.id, x.org.id);
			expect(ended.jsonWebhooksPaused).toBe(1);
			const hook = await rowOf(theirs);
			expect([hook.enabled, hook.lastError]).toEqual([
				false,
				'Paused: whoever added it is no longer an owner.'
			]);
			expect((await rowOf(siteOwners)).enabled).toBe(true);
			const [row] = await env.db
				.select()
				.from(jsonWebhookPosts)
				.where(eq(jsonWebhookPosts.id, waiting.id));
			expect(row.state).toBe('skipped');
		});

		test('removing a webhook removes what was queued for it', async () => {
			const doomed = made(
				await create('owner', { url: PUBLIC('doomed'), events: ['seed_reward'], serverIds: null })
			);
			await env.db.insert(jsonWebhookPosts).values({
				webhookId: doomed.webhook.id,
				serverId: w.server.id,
				kind: 'seed_reward',
				eventId: 'seed_reward.granted:doomed',
				body: JSON.stringify({ event: 'seed_reward.granted', id: 'seed_reward.granted:doomed' }),
				notBefore: new Date(Date.now() + 3_600_000)
			});
			const answer = await callApi(deleteRoute, w.users.owner, {
				method: 'DELETE',
				params: { id: w.org.id, webhookId: doomed.webhook.id }
			});
			expect(answer.status).toBe(200);
			const left = await env.db
				.select()
				.from(jsonWebhookPosts)
				.where(eq(jsonWebhookPosts.webhookId, doomed.webhook.id));
			expect(left).toHaveLength(0);
		});
	});

	describe('queueEvent', () => {
		test('an organisation-wide event reaches every webhook that takes its kind, once, under its own id', async () => {
			const x = await seedWorld(env);
			const add = async (who: PrincipalName, orgId: string, body: Record<string, unknown>) =>
				made(
					await callApi(createRoute, x.users[who], {
						method: 'POST',
						params: { id: orgId },
						body: { url: PUBLIC('queue'), events: ['seed_reward'], serverIds: null, ...body }
					})
				).webhook.id;
			const everywhere = await add('owner', x.org.id, {});
			const oneServer = await add('owner', x.org.id, { serverIds: [x.otherServer.id] });
			await add('owner', x.org.id, { enabled: false });
			await add('outsider', x.otherOrg.id, {});
			// held back so the loop running for the other tests leaves them be
			const hold = () =>
				env.db
					.update(jsonWebhookPosts)
					.set({ notBefore: new Date(Date.now() + 3_600_000) })
					.where(eq(jsonWebhookPosts.state, 'pending'));
			const event = (name: string, key: string, fields: Record<string, unknown> = {}) => ({
				kind: 'seed_reward' as const,
				event: name,
				key,
				orgId: x.org.id,
				serverId: null,
				fields
			});
			expect(await queueEvent(env.db, event('reserve.test', '7', { id: 'not-this' }))).toBe(2);
			await hold();
			// the same event again is not queued again
			expect(await queueEvent(env.db, event('reserve.test', '7'))).toBe(0);
			// another event with the same key is another event
			expect(await queueEvent(env.db, event('reserve.other', '7'))).toBe(2);
			await hold();
			const rows = await env.db
				.select()
				.from(jsonWebhookPosts)
				.where(like(jsonWebhookPosts.eventId, 'reserve.%:7'));
			expect(rows.map((r) => [r.eventId, r.webhookId, r.serverId]).sort()).toEqual(
				[
					['reserve.other:7', everywhere, null],
					['reserve.other:7', oneServer, null],
					['reserve.test:7', everywhere, null],
					['reserve.test:7', oneServer, null]
				].sort()
			);
			const body = JSON.parse(rows.find((r) => r.eventId === 'reserve.test:7')!.body) as Record<
				string,
				unknown
			>;
			expect(body.id).toBe('reserve.test:7');
			expect(Object.keys(body).slice(0, 3)).toEqual(['event', 'id', 'at']);
			// a server event reaches only the webhooks that cover that server
			expect(
				await queueEvent(env.db, { ...event('reserve.here', '8'), serverId: x.server.id })
			).toBe(1);
			await hold();
		});
	});
});
