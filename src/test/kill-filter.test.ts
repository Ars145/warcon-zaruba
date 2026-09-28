// The kills route's cause filter in SQL: a tag matches whole and in any case (the game writes
// `ID.Item.` for some items and `Id.Item.` for others, and the named tags in $lib/causes are
// spelled one way), and it agrees with killMatches, which filters the kills arriving live.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { kills } from '$lib/server/db/schema';
import { EMPTY_FILTER, killMatches } from '$lib/kills';
import type { KillView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { GET as killsRoute } from '../routes/api/servers/[id]/kills/+server';

const A = '76561198000000091';
const B = '76561198000000092';
const CAUSES = ['ID.Item.BuildTool.Hammer.Large', 'Id.Item.AK74M', 'Id.Item.AK74M', null];

describe.skipIf(!hasTestDb)('the kills route by cause', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		await env.db.insert(kills).values(
			CAUSES.map((cause, i) => ({
				ts: new Date(Date.now() - (10 - i) * 1000),
				serverId: w.server.id,
				eventId: `kf${i}`,
				instanceId: 'i',
				matchId: 'g',
				eventTime: i,
				map: 'Kavkazi',
				killerSteamId: A,
				killerName: 'Ghostpepper',
				killerFaction: 'Valkyra',
				victimSteamId: B,
				victimName: 'T0XIC_AVENGER',
				victimFaction: 'Lonestar',
				cause,
				distanceM: 50,
				tags: []
			}))
		);
	});

	const get = async (query: string) => {
		const r = await callApi(killsRoute, w.users.viewer, {
			params: { id: w.server.id },
			query
		});
		expect(r.status).toBe(200);
		return r.body as { kills: KillView[]; total: number };
	};

	test('a tag matches whole, in any case, as the live filter does', async () => {
		const all = (await get('')).kills;
		expect(all).toHaveLength(CAUSES.length);
		const cases: [string, string[]][] = [
			['ID.Item.BuildTool.Hammer.Large', ['kf0']],
			['Id.Item.BuildTool.Hammer.Large', ['kf0']],
			['id.item.ak74m', ['kf1', 'kf2']],
			['Id.Item.AK74', []],
			['Id.Item.AK74%', []]
		];
		for (const [cause, want] of cases) {
			const body = await get(`cause=${encodeURIComponent(cause)}&count=1`);
			expect([cause, body.kills.map((k) => k.eventId).sort()]).toEqual([cause, want]);
			expect([cause, body.total]).toEqual([cause, want.length]);
			const live = all.filter((k) => killMatches({ ...EMPTY_FILTER, cause }, k));
			expect([cause, live.map((k) => k.eventId).sort()]).toEqual([cause, want]);
		}
	});
});
