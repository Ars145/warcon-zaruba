// The kill feed against a real database: the game sends a batch again when it did not hear back,
// and the copy can arrive while the first is still being written.
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import type { Env } from '$lib/server/env';
import { kills, serverLive, servers } from '$lib/server/db/schema';
import { ingestBatch, mintFeedToken } from '$lib/server/feed';
import { resetRates } from '$lib/server/ratelimit';
import { POST as ingest } from '../routes/api/ingest/events/+server';
import { stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const batchOf = (eventIds: string[]) => ({
	serverId: 'e9cf2544-b21e-4b80-9f12-8ec95ff58964',
	serverName: 'Test',
	events: eventIds.map((eventId, i) => ({
		eventId,
		type: 'killed',
		eventTime: 100 + i,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		killerName: 'Alpha',
		killerSteamId: '76561198000000001',
		victimName: 'Bravo',
		victimSteamId: '76561198000000002',
		cause: 'Id.Item.AK74M',
		distance: 70,
		contextTags: []
	}))
});

// What Season 2 sends beside kills (feed-core.test.ts has them as posted).
const season2 = () => [
	{
		eventId: randomUUID(),
		type: 'player_joined',
		eventTime: 3157.0576,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		playerName: 'Charlie',
		playerId: '-0000-000000000000',
		playerSteamId: '76561198000000003',
		players: 42
	},
	{
		eventId: randomUUID(),
		type: 'player_left',
		eventTime: 3164.3425,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		playerName: 'Charlie',
		playerId: '-0000-000000000000',
		playerSteamId: '76561198000000003',
		players: 41
	},
	{
		eventId: randomUUID(),
		type: 'match_state',
		eventTime: 3185.7238,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		state: 'MatchState.Playing.KOTH'
	}
];

describe.skipIf(!hasTestDb)('kill feed ingest', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	const stored = async (serverId: string, eventId: string) =>
		(
			await env.db
				.select({ id: kills.eventId })
				.from(kills)
				.where(and(eq(kills.serverId, serverId), eq(kills.eventId, eventId)))
		).length;

	test('a batch that arrives many times at once is written once', async () => {
		const w = await seedWorld(env);
		const ids = [randomUUID(), randomUUID()];
		const results = await Promise.all(
			Array.from({ length: 12 }, () => ingestBatch(env, w.server.id, batchOf(ids)))
		);
		expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(2);
		expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(22);
		for (const id of ids) expect(await stored(w.server.id, id)).toBe(1);
	});

	test("the same event id on another server is that server's own kill", async () => {
		const w = await seedWorld(env);
		const id = randomUUID();
		const [a, b] = await Promise.all([
			ingestBatch(env, w.server.id, batchOf([id])),
			ingestBatch(env, w.otherServer.id, batchOf([id]))
		]);
		expect([a.accepted, b.accepted]).toEqual([1, 1]);
	});

	test('joins, leaves and match states are counted and never written as kills', async () => {
		const w = await seedWorld(env);
		const id = randomUUID();
		const body = batchOf([id]);
		const r = await ingestBatch(env, w.server.id, {
			...body,
			events: [...season2(), ...body.events]
		});
		expect(r).toMatchObject({ accepted: 1, other: 3, skipped: 0, duplicates: 0 });
		const rows = await env.db
			.select({ eventId: kills.eventId })
			.from(kills)
			.where(eq(kills.serverId, w.server.id));
		expect(rows).toEqual([{ eventId: id }]);
	});

	test("the route answers what it counted, and only to the server's own token", async () => {
		stubGateway();
		resetRates();
		const w = await seedWorld(env);
		const [row] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const token = await mintFeedToken(env, new Request('http://localhost/'), w.users.owner!, row);
		const id = randomUUID();
		const body = batchOf([id]);
		const post = (authorization?: string) =>
			ingest({
				request: new Request('http://localhost/api/ingest/events', {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...(authorization && { authorization }) },
					body: JSON.stringify({ ...body, events: [...season2(), ...body.events] })
				})
			} as unknown as RequestEvent);
		expect((await post()).status).toBe(401);
		expect((await post(`Bearer wkf_${'a'.repeat(43)}`)).status).toBe(401);
		expect(await stored(w.server.id, id)).toBe(0);
		const res = await post(`Bearer ${token}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			accepted: 1,
			other: 3,
			skipped: 0,
			duplicates: 0
		});
		expect(await stored(w.server.id, id)).toBe(1);
	});

	test('a batch with no kill in it still shows the feed is alive', async () => {
		const w = await seedWorld(env);
		const at = new Date('2026-10-15T11:20:00Z');
		const r = await ingestBatch(env, w.server.id, { ...batchOf([]), events: season2() }, at);
		expect(r).toMatchObject({ accepted: 0, other: 3, skipped: 0, kills: [] });
		const [live] = await env.db
			.select({ feedAt: serverLive.feedAt })
			.from(serverLive)
			.where(eq(serverLive.serverId, w.server.id));
		expect(live?.feedAt?.toISOString()).toBe(at.toISOString());
	});
});
