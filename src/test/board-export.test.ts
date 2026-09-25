// Export CSV on the Leaderboards tab: the whole board as it is set, not the page on screen, with
// names written so a spreadsheet does not run them, and the organisation scope held to the
// servers the caller can open, as the board's own is.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { playerSessions } from '$lib/server/db/schema';
import { BOARD_PAGE } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { callRaw, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';
import { GET as exportRoute } from '../routes/api/servers/[id]/leaderboard/export/+server';

const PLAYERS = BOARD_PAGE + 5;
const FORMULA = '=HYPERLINK("http://evil.example","x")';
const ELSEWHERE = '76561198000000999';

describe.skipIf(!hasTestDb)('leaderboard export', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		const hour = 3_600_000;
		const session = (serverId: string, steamId: string, name: string, minutes: number) => ({
			serverId,
			steamId,
			name,
			joinedAt: new Date(Date.now() - 2 * hour),
			lastSeen: new Date(Date.now() - 2 * hour + minutes * 60_000),
			leftAt: new Date(Date.now() - 2 * hour + minutes * 60_000)
		});
		await env.db
			.insert(playerSessions)
			.values([
				...Array.from({ length: PLAYERS - 1 }, (_, i) =>
					session(w.server.id, `7656119800000${String(1000 + i)}`, `Player ${i + 1}`, 61 + i)
				),
				session(w.server.id, '76561198000002000', FORMULA, 30),
				session(w.otherServer.id, ELSEWHERE, 'Elsewhere Only', 110)
			]);
	});

	const download = async (who: PrincipalName, query: string, serverId = w.server.id) => {
		const res = await callRaw(exportRoute, w.users[who], {
			params: { id: serverId },
			query
		});
		return { res, lines: (await res.text()).split('\r\n') };
	};

	test('every row of the board, ranked, under a header', async () => {
		const { res, lines } = await download('owner', 'minMinutes=0&sort=playtime');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(
			/^attachment; filename="[a-z0-9-]+-leaderboard-30d-\d{4}-\d{2}-\d{2}\.csv"$/
		);
		expect(lines[0].split(',')).toEqual([
			'rank',
			'steam_id',
			'name',
			'playtime_min',
			'seeded_min',
			'kills',
			'deaths',
			'kd',
			'kills_per_hour',
			'headshots',
			'team_kills',
			'suicides',
			'vehicle_kills',
			'kill_streak',
			'death_streak',
			'matches',
			'wins',
			'losses',
			'draws',
			'win_pct',
			'cash',
			'last_seen'
		]);
		// more than one page of the board, in the order it ranks them
		expect(lines.length - 1).toBe(PLAYERS);
		expect(lines[1].startsWith(`1,7656119800000${1000 + PLAYERS - 2},Player ${PLAYERS - 1},`)).toBe(
			true
		);
		expect(lines.map((l) => l.split(',')[0]).slice(1, 4)).toEqual(['1', '2', '3']);
	});

	test('a name that a spreadsheet would run is written as text', async () => {
		const { lines } = await download('owner', 'minMinutes=0');
		const row = lines.find((l) => l.includes('HYPERLINK'));
		expect(row).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
	});

	test('the playtime floor and the page are the board’s, the page ignored', async () => {
		const { lines } = await download('owner', 'minMinutes=60&page=2');
		expect(lines.length - 1).toBe(PLAYERS - 1);
		expect(lines.some((l) => l.includes('HYPERLINK'))).toBe(false);
	});

	test('the organisation scope covers only the servers the caller can open', async () => {
		const owner = await download('owner', 'scope=org&minMinutes=0');
		expect(owner.lines.some((l) => l.includes(ELSEWHERE))).toBe(true);
		const viewer = await download('viewer', 'scope=org&minMinutes=0');
		expect(viewer.res.status).toBe(200);
		expect(viewer.lines.length - 1).toBe(PLAYERS);
		expect(viewer.lines.some((l) => l.includes(ELSEWHERE))).toBe(false);
	});

	test('a key held to one server exports that server alone, whatever the scope', async () => {
		const refused = await download('keyElsewhere', 'scope=org&minMinutes=0');
		expect(refused.res.status).toBe(404);
		const own = await download('keyElsewhere', 'scope=org&minMinutes=0', w.otherServer.id);
		expect(own.res.status).toBe(200);
		expect(own.lines.slice(1).map((l) => l.split(',')[1])).toEqual([ELSEWHERE]);
	});
});
