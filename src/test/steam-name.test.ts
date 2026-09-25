// The players table's marks carry the Steam name on record for each player (the dossier already
// shows it to anyone who can open the server), so the table can say who is behind a name that
// hides it. Profiles are seeded fresh, so no Steam call is made whether or not a key is set.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { steamProfiles } from '$lib/server/db/schema';
import type { PlayerMark } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { GET as marksRoute } from '../routes/api/servers/[id]/players/marks/+server';

const HIDDEN = '76561198000000144';
const NO_NAME = '76561198000000145';

describe.skipIf(!hasTestDb)('Steam names on the players table', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		await env.db
			.insert(steamProfiles)
			.values([
				{ steamId: HIDDEN, persona: 'shadowfox', fetchedAt: new Date() },
				{ steamId: NO_NAME, persona: '', error: 'not found', fetchedAt: new Date() }
			])
			.onConflictDoNothing();
	});

	test('a viewer reads the Steam name on record, and nothing where there is none', async () => {
		const answer = await callApi(marksRoute, w.users.viewer, {
			params: { id: w.server.id },
			query: new URLSearchParams({
				ids: `${HIDDEN},${NO_NAME}`,
				names: 'Anonymous\nAnonymous'
			}).toString()
		});
		expect(answer.status).toBe(200);
		const marks = (answer.body as { marks: PlayerMark[] }).marks;
		expect(marks.find((m) => m.steamId === HIDDEN)?.steamName).toBe('shadowfox');
		expect(marks.find((m) => m.steamId === NO_NAME)?.steamName).toBeNull();
	});

	test('someone who cannot open the server gets nothing', async () => {
		const answer = await callApi(marksRoute, w.users.outsider, {
			params: { id: w.server.id },
			query: `ids=${HIDDEN}&names=Anonymous`
		});
		expect(answer.status).toBe(404);
	});
});
