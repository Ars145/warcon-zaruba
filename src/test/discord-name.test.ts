// Warcon names none of its Discord posts, so each shows the name and picture its owner gave the
// webhook in Discord. A name sent with a post takes their place, which is why renaming a webhook in
// Discord used to change nothing: every post said the panel's name instead.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { webhooks } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { encryptSecret } from '$lib/server/crypto';
import { newId } from '$lib/server/http';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import { refreshStatusMessages, resetStatusMirror } from '$lib/server/webhook-status';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const TEST_ROUTE = join(
	import.meta.dir,
	'..',
	'routes',
	'api',
	'orgs',
	'[id]',
	'webhooks',
	'[webhookId]',
	'test',
	'+server.ts'
);

describe.skipIf(!hasTestDb)("the name on Warcon's Discord posts", () => {
	let env: Env;
	let w: World;
	const token = randomBytes(34).toString('hex');
	/** the bodies of the new messages this test's webhook was sent */
	const posts: Record<string, unknown>[] = [];
	const realFetch = globalThis.fetch;
	let id = '';

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		id = newId();
		await env.db.insert(webhooks).values({
			id,
			orgId: w.org.id,
			label: 'staff',
			urlEnc: encryptSecret(env, `https://discord.com/api/webhooks/123456789012345678/${token}`),
			events: ['bans'],
			serverIds: [w.server.id],
			statusEnabled: true
		});
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			if (String(url).includes(token) && init?.method === 'POST')
				posts.push(JSON.parse(String(init.body)));
			return Response.json({ id: `m${posts.length}` });
		}) as typeof fetch;
	});

	afterAll(async () => {
		// the database is shared by every file: leave no cards for another file's passes
		await env.db.update(webhooks).set({ statusEnabled: false }).where(eq(webhooks.orgId, w.org.id));
		globalThis.fetch = realFetch;
		resetWebhookQueues();
		resetStatusMirror();
	});

	test('a test message, a status card and a mirrored ban all leave the name to Discord', async () => {
		const { POST } = await import(TEST_ROUTE);
		const res = await callApi(POST, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id, webhookId: id }
		});
		expect(res.status).toBe(200);

		resetStatusMirror();
		await refreshStatusMessages(env);

		await writeAudit(env, null, {
			actorName: 'owner',
			server: { id: w.server.id, name: 'Example Clan #1' },
			orgId: w.org.id,
			category: 'rcon',
			action: 'rcon.ban',
			target: '76561198000000961',
			outcome: 'ok',
			message: 'Banned.'
		});
		// the mirror batches for a moment before it posts
		await new Promise((r) => setTimeout(r, 2000));

		const titles = posts.flatMap((p) => (p.embeds as { title: string }[]).map((e) => e.title));
		expect(titles).toContain('Webhook test');
		expect(titles).toContain('Ban');
		expect(posts.length).toBe(3);
		for (const post of posts) {
			expect(post).not.toHaveProperty('username');
			expect(post).not.toHaveProperty('avatar_url');
		}
	});
});
