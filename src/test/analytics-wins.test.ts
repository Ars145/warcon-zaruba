// Wins per team on the Analytics tab: the matches that ended in the range, by the boards' rule
// (a winner, else a draw when somebody scored, else no result), and nothing from another server,
// from before the range or still running.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { matches } from '$lib/server/db/schema';
import { loadAnalytics } from '$lib/server/analytics';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const HOUR = 3_600_000;
const scores = (v: number, l: number, m: number) => [
	{ name: 'Valkyra', score: v },
	{ name: 'Lonestar', score: l },
	{ name: 'Manticore', score: m }
];

describe.skipIf(!hasTestDb)('wins per team', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		const ago = (h: number) => new Date(Date.now() - h * HOUR);
		const ended = (h: number, finalScores: unknown, winner: string | null) => ({
			serverId: w.server.id,
			startedAt: ago(h + 1),
			endedAt: ago(h),
			map: 'Ozeti',
			finalScores,
			winner
		});
		await env.db.insert(matches).values([
			ended(2, scores(100, 80, 60), 'Valkyra'),
			ended(4, scores(100, 90, 20), 'Valkyra'),
			ended(6, scores(70, 100, 40), 'Lonestar'),
			// a draw: the leaders tied when the scores reset
			ended(8, scores(55, 55, 10), null),
			// a winner whose scores cannot be read still counts for that side, as on the boards
			ended(14, [], 'Manticore'),
			// no result: nobody scored, an abandoned match with no scores at all, and scores that
			// are not numbers (read as none, not as an error)
			ended(10, scores(0, 0, 0), null),
			ended(12, null, null),
			ended(13, [{ name: 'Valkyra', score: 'abc' }], null),
			// outside it: ended before the range, still running, another server's
			ended(30, scores(100, 1, 1), 'Manticore'),
			{ serverId: w.server.id, startedAt: ago(1), map: 'Ozeti', winner: null },
			{ ...ended(2, scores(1, 1, 100), 'Manticore'), serverId: w.otherServer.id }
		]);
	});

	test('counts the range by result, a side by its wins', async () => {
		const { wins } = await loadAnalytics(env, w.server.id, '24h');
		expect(wins.decided).toBe(5);
		expect(wins.draws).toBe(1);
		expect(wins.noResult).toBe(3);
		expect(wins.teams.map((t) => [t.name, t.wins])).toEqual([
			['Valkyra', 2],
			['Lonestar', 1],
			['Manticore', 1]
		]);
	});

	test('a longer range takes the older match in', async () => {
		const { wins } = await loadAnalytics(env, w.server.id, '7d');
		expect(wins.decided).toBe(6);
		expect(wins.teams.find((t) => t.name === 'Manticore')?.wins).toBe(2);
	});

	test('a side that played and never won is listed with none', async () => {
		const { wins } = await loadAnalytics(env, w.otherServer.id, '24h');
		expect(wins.teams.map((t) => [t.name, t.wins])).toEqual([
			['Manticore', 1],
			['Lonestar', 0],
			['Valkyra', 0]
		]);
	});

	test('a server with no matches has nothing to show', async () => {
		const { wins } = await loadAnalytics(env, w.otherOrgServer.id, '24h');
		expect(wins).toEqual({ teams: [], decided: 0, draws: 0, noResult: 0 });
	});
});
