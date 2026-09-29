// Two-team mode at delivery: a second move for a player never goes out on the player list the first
// was checked against (moving, and killing, someone twice is not harmless), and a rule that changes
// drops the moves it queued under its old settings, including ones that reach the outbox after it.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, ownedSince, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf } from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { enabledTriggers, invalidateTriggers } from '$lib/server/triggers';
import { twoTeamsSettingsKey, validateTwoTeams } from '$lib/server/two-teams';
import { WardogsClient } from '$lib/server/rcon';
import type { Player } from '$lib/types';
import { subscribe } from '$lib/server/events';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput, type Outcome } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
/** The rule's settings, and the fingerprint its moves carry. */
const LONESTAR = validateTwoTeams({ closedFaction: 'Lonestar' });
const DECIDED = twoTeamsSettingsKey(LONESTAR);
const X = '76561198000000901';
const Y = '76561198000000902';
/** a player no other test moves, so this process has sent nothing for them, as after a restart */
const Z = '76561198000000903';
const on = (steamId: string, faction: string): Player => ({
	name: steamId === X ? 'X' : steamId === Y ? 'Y' : 'Z',
	steamId,
	faction,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});

describe.skipIf(!hasTestDb)('Two-team mode at delivery', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	const requests: string[] = [];
	/** the server's Two-team rule, closing Lonestar, whose moves these rows are */
	let ruleId: string;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		stubGateway();
		expect(await acquireOrRenew(env, 'two-teams-delivery')).toBe(true);
		renewing = setInterval(() => void acquireOrRenew(env, 'two-teams-delivery'), 5000);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		memoryFor(server, org);
		ruleId = `rule-${w.server.id}`;
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'two_teams',
			name: 'Two teams',
			enabled: true,
			config: LONESTAR
		});
		invalidateTriggers(w.server.id);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async () =>
				({
					json: async (method: string, path: string) => {
						requests.push(`${method} ${path}`);
						return { ok: true };
					}
				}) as unknown as WardogsClient
		);
	});

	beforeEach(async () => {
		expect(await acquireOrRenew(env, 'two-teams-delivery')).toBe(true);
	});

	afterAll(async () => {
		clearInterval(renewing);
		await stopDelivery();
		spy?.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	let seq = 0;
	const move = (steamId: string, triggerId = ruleId, serverId = w.server.id) => ({
		serverId,
		triggerId,
		triggerName: 'Two teams',
		triggerKind: 'two_teams',
		action: 'changeTeam',
		params: { steamId, faction: 'Valkyra', from: 'Lonestar', rule: DECIDED },
		target: steamId,
		steamId,
		okMessage: 'Moved.',
		dedupeKey: `two-teams-delivery-${seq++}`
	});
	const rowsOf = async (ids: number[]) =>
		(await env.db.select().from(outbox).where(inArray(outbox.id, ids))).sort((a, b) => a.id - b.id);
	const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
		const end = Date.now() + ms;
		while (!(await ok())) {
			if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
			await Bun.sleep(25);
		}
	};

	test('a second move waits for a newer player list, then goes only if the first did not land', async () => {
		const m = memoryOf(w.server.id)!;
		m.players = [on(X, 'Lonestar'), on(Y, 'Lonestar')];
		m.playersAt = Date.now();
		// Both moves, then both asked again: a retry claimed right behind the first.
		const ids = (
			await env.db
				.insert(outbox)
				.values([move(X), move(Y), move(X), move(Y)])
				.returning({ id: outbox.id })
		).map((r) => r.id);
		startDelivery(env);
		await until(async () => {
			const rows = await rowsOf(ids);
			return (
				rows[1].state === 'delivered' &&
				rows.slice(2).every((r) => r.attempts > 0 && r.state !== 'sending')
			);
		});
		// The retries were claimed behind the first moves and went back to wait for a newer list.
		expect((await rowsOf(ids)).map((r) => r.state)).toEqual([
			'delivered',
			'delivered',
			'pending',
			'pending'
		]);
		expect(requests).toEqual([
			`PATCH /v1/players/${X}`,
			`POST /v1/players/${X}/kill`,
			`PATCH /v1/players/${Y}`,
			`POST /v1/players/${Y}/kill`
		]);
		// The next list: X landed, Y did not.
		m.players = [on(X, 'Valkyra'), on(Y, 'Lonestar')];
		m.playersAt = Date.now();
		await until(async () => (await rowsOf(ids)).slice(2).every((r) => r.doneAt !== null));
		const rows = await rowsOf(ids);
		expect(rows.slice(2).map((r) => [r.state, r.outcome])).toEqual([
			['skipped', 'Already off Lonestar.'],
			['delivered', 'Moved to Valkyra and killed, so they respawn on the new side.']
		]);
		expect(requests.slice(4)).toEqual([`PATCH /v1/players/${Y}`, `POST /v1/players/${Y}/kill`]);
		await stopDelivery();
	}, 30_000);

	test('changing, switching off or deleting the rule drops its queued moves; a new name does not', async () => {
		const api = async (route: string, input: Omit<CallInput, 'method'>): Promise<Outcome> => {
			const [method, path] = route.split(' ');
			const mod = await import(join(ROUTES, path, '+server.ts'));
			return callApi(mod[method], w.users.owner, { ...input, method });
		};
		const params = { id: w.otherServer.id };
		const made = await api('POST api/servers/[id]/triggers', {
			params,
			body: { kind: 'two_teams', enabled: true, config: { closedFaction: 'Lonestar' } }
		});
		expect(made.status).toBe(201);
		const triggerId = (made.body as { trigger: { id: string } }).trigger.id;
		// the Automation page's live table hears of every row dropped
		const announced: number[] = [];
		const unsubscribe = subscribe((e) => {
			if (e.type === 'outbox' && e.state === 'skipped') announced.push(e.id);
		});
		const queue = async () =>
			(
				await env.db
					.insert(outbox)
					.values([move(X, triggerId, w.otherServer.id), move(Y, triggerId, w.otherServer.id)])
					.returning({ id: outbox.id })
			).map((r) => r.id);
		const states = async (ids: number[]) => (await rowsOf(ids)).map((r) => [r.state, r.outcome]);
		const patch = (body: Record<string, unknown>) =>
			api('PATCH api/servers/[id]/triggers/[triggerId]', {
				params: { ...params, triggerId },
				body
			});

		const renamed = await queue();
		expect((await patch({ name: 'Red against Green' })).status).toBe(200);
		expect(await states(renamed)).toEqual([
			['pending', ''],
			['pending', '']
		]);

		expect((await patch({ config: { closedFaction: 'Manticore' } })).status).toBe(200);
		const changed = ['skipped', 'The rule was changed before this was sent.'];
		expect(await states(renamed)).toEqual([changed, changed]);

		const switchedOff = await queue();
		expect((await patch({ enabled: false })).status).toBe(200);
		expect(await states(switchedOff)).toEqual([changed, changed]);

		const deleted = await queue();
		expect(
			(
				await api('DELETE api/servers/[id]/triggers/[triggerId]', {
					params: { ...params, triggerId }
				})
			).status
		).toBe(200);
		const gone = ['skipped', 'The rule was deleted before this was sent.'];
		expect(await states(deleted)).toEqual([gone, gone]);
		unsubscribe();
		expect(announced.sort((a, b) => a - b)).toEqual([...renamed, ...switchedOff, ...deleted]);
	}, 30_000);

	test('a move or whisper decided under the old settings that reaches the outbox after a change is not sent', async () => {
		const m = memoryOf(w.server.id)!;
		m.players = [on(X, 'Lonestar'), on(Y, 'Lonestar')];
		m.playersAt = Date.now();
		// The worker's cache still holds the rule as it was: the rows are judged by the table.
		invalidateTriggers(w.server.id);
		expect((await enabledTriggers(env, w.server.id)).map((r) => r.id)).toEqual([ruleId]);
		// The rule now closes Manticore; a look that read it closing Lonestar commits late.
		await env.db
			.update(triggers)
			.set({ config: validateTwoTeams({ closedFaction: 'Manticore' }) })
			.where(eq(triggers.id, ruleId));
		const from = requests.length;
		try {
			const late = (
				await env.db
					.insert(outbox)
					.values([
						move(X),
						move(Y, 'a-rule-since-deleted'),
						{
							...move(Y),
							action: 'whisper',
							params: { steamId: Y, message: 'You are on Valkyra.', rule: DECIDED }
						}
					])
					.returning({ id: outbox.id })
			).map((r) => r.id);
			startDelivery(env);
			await until(async () => (await rowsOf(late)).every((r) => r.doneAt !== null));
			const skipped = ['skipped', 'The rule was changed before this was sent.'];
			expect((await rowsOf(late)).map((r) => [r.state, r.outcome])).toEqual([
				skipped,
				skipped,
				skipped
			]);
			expect(requests.slice(from)).toEqual([]);
		} finally {
			await stopDelivery();
			await env.db.update(triggers).set({ config: LONESTAR }).where(eq(triggers.id, ruleId));
			invalidateTriggers(w.server.id);
		}
	}, 30_000);

	test('a move queued before this worker took over waits for a player list it has seen itself', async () => {
		const m = memoryOf(w.server.id)!;
		// as after a restart: the server's memory is new, with no player list yet
		m.players = [];
		m.playersAt = 0;
		const from = requests.length;
		try {
			const [id] = (
				await env.db
					.insert(outbox)
					.values([move(Z)])
					.returning({ id: outbox.id })
			).map((r) => r.id);
			startDelivery(env);
			await until(async () => (await rowsOf([id]))[0].attempts > 0);
			await Bun.sleep(300);
			expect((await rowsOf([id]))[0].state).toBe('pending');
			expect(requests.slice(from)).toEqual([]);
			// The first list this worker takes: the move made before the restart had landed.
			m.players = [on(Z, 'Valkyra')];
			m.playersAt = Math.max(Date.now(), ownedSince());
			await until(async () => (await rowsOf([id]))[0].doneAt !== null);
			expect((await rowsOf([id])).map((r) => [r.state, r.outcome])).toEqual([
				['skipped', 'Already off Lonestar.']
			]);
			expect(requests.slice(from)).toEqual([]);
		} finally {
			await stopDelivery();
		}
	}, 30_000);

	test('a rule that cannot be read holds its row back, and the error stays in the log', async () => {
		const m = memoryOf(w.server.id)!;
		m.players = [on(Z, 'Lonestar')];
		m.playersAt = Date.now();
		// The check's read of the rule fails once, with an error that names an address.
		const original = env.db.select.bind(env.db);
		let failed = false;
		const select = spyOn(env.db, 'select').mockImplementation(((fields?: object) => {
			if (!failed && fields && 'enabled' in fields && 'config' in fields) {
				failed = true;
				throw new Error('connection reset by peer at 10.2.0.4:5432');
			}
			return original(fields as never);
		}) as typeof env.db.select);
		const since = new Date();
		try {
			const [id] = (
				await env.db
					.insert(outbox)
					.values([move(Z)])
					.returning({ id: outbox.id })
			).map((r) => r.id);
			startDelivery(env);
			await until(async () => (await rowsOf([id]))[0].doneAt !== null);
			const [row] = await rowsOf([id]);
			expect(failed).toBe(true);
			expect([row.state, row.outcome]).toEqual([
				'delivered',
				'Moved to Valkyra and killed, so they respawn on the new side.'
			]);
			expect(row.attempts).toBeGreaterThan(1);
			const trail = await env.db
				.select({ message: auditLog.message })
				.from(auditLog)
				.where(and(eq(auditLog.serverId, w.server.id), gte(auditLog.ts, since)));
			expect(trail.filter((a) => a.message.includes('10.2.0.4'))).toEqual([]);
		} finally {
			select.mockRestore();
			await stopDelivery();
		}
	}, 30_000);
});
