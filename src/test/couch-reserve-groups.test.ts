// The fork's CouchDB default list must coexist with upstream reserved-slot groups.
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { getOrg } from '$lib/server/access';
import { listEntries, lists, serverLists } from '$lib/server/db/schema';
import { ensureServerLists, listOf } from '$lib/server/lists';
import { desiredFor, expireEntries } from '$lib/server/lists-sync';
import { PRIORITY } from '$lib/server/lists-plan';
import { newId } from '$lib/server/http';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const A = '76561198000000801';
const B = '76561198000000802';
const LEGACY = '76561198000000803';

describe.skipIf(!hasTestDb)('CouchDB default reserve with Postgres groups', () => {
	let env: Env;
	beforeAll(async () => {
		env = await testEnv();
	});

	test('combines sources, attributes overlaps to the default, and expires only group rows', async () => {
		const w = await seedWorld(env);
		const def = await listOf(env, w.org.id, 'reserve');
		await ensureServerLists(env.db, w.server.id, w.org.id);
		const groupId = newId();
		await env.db.insert(lists).values({
			id: groupId,
			orgId: w.org.id,
			kind: 'reserve',
			name: 'Event',
			isDefault: false
		});
		await env.db.insert(serverLists).values({ serverId: w.server.id, listId: groupId });
		await env.db.insert(listEntries).values([
			{ id: newId(), listId: groupId, steamId: A },
			{ id: newId(), listId: groupId, steamId: B },
			{ id: newId(), listId: def.id, steamId: LEGACY }
		]);
		const couch = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					docs: [
						{
							_id: `personal:${A}`,
							type: 'personal',
							steamId: A,
							expiresAt: null,
							reason: 'VIP',
							addedBy: 'test',
							addedAt: new Date().toISOString()
						}
					]
				})
		});
		try {
			const scoped = { ...env, COUCH_ORG_ID: w.org.id, COUCH_URL: couch.url.origin };
			const org = (await getOrg(env, w.org.id))!;
			const server = { id: w.server.id, orgId: w.org.id };
			const wanted = await desiredFor(scoped, server, org);
			expect(wanted.reserveError).toBeUndefined();
			expect(wanted.reserved.map((r) => r.steamId).sort()).toEqual([A, B]);
			expect(wanted.reserved.find((r) => r.steamId === A)).toMatchObject({
				listId: def.id,
				priority: PRIORITY.org
			});
			expect(wanted.reserved.find((r) => r.steamId === B)).toMatchObject({
				listId: groupId,
				priority: PRIORITY.group
			});
			await env.db.update(lists).set({ archivedAt: new Date() }).where(eq(lists.id, groupId));
			expect((await desiredFor(scoped, server, org)).reserved.map((r) => r.steamId)).toEqual([A]);
			await env.db
				.update(listEntries)
				.set({ expiresAt: new Date(Date.now() - 60_000) })
				.where(eq(listEntries.steamId, B));
			await env.db
				.update(listEntries)
				.set({ expiresAt: new Date(Date.now() - 60_000) })
				.where(eq(listEntries.steamId, LEGACY));
			await expireEntries(scoped);
			const rows = await env.db.select().from(listEntries).where(eq(listEntries.listId, groupId));
			expect(rows.find((r) => r.steamId === B)!.removal).toBe('expired');
			const [legacy] = await env.db
				.select()
				.from(listEntries)
				.where(eq(listEntries.listId, def.id));
			expect(legacy.removedAt).toBeNull();
		} finally {
			await couch.stop(true);
		}
	});
});
