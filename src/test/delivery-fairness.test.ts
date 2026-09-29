// One server's deliveries never hold up another's: each server's rows go out in a chain of their
// own, a claim takes only a few of any one server's rows, and the loop never waits for a slow chain
// before claiming for the rest. The game is a stand-in whose answer time is set per server.
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test
} from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor } from '$lib/server/observe';
import { deliveryStats, startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { resetSetting, saveSettings } from '$lib/server/settings';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('delivery across servers', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	/** how long the stand-in game takes to answer, by server */
	const answerMs = new Map<string, number>();
	/** every request the stand-in game got, in the order they started */
	const sent: { serverId: string; message: string; at: number }[] = [];
	const open = new Map<string, number>();
	/** requests that started while another to the same server was still open */
	let overlaps = 0;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'delivery-fairness')).toBe(true);
		// the worker renews its lease as it runs; a slow run of these tests can outlast one lease
		renewing = setInterval(() => void acquireOrRenew(env, 'delivery-fairness'), 5000);
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		for (const id of [w.server.id, w.otherServer.id]) {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, id));
			memoryFor(server, org);
		}
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async (_env, server) =>
				({
					json: async (_method: string, _path: string, body?: { message?: string }) => {
						const n = (open.get(server.id) ?? 0) + 1;
						if (n > 1) overlaps++;
						open.set(server.id, n);
						sent.push({ serverId: server.id, message: body?.message ?? '', at: Date.now() });
						await Bun.sleep(answerMs.get(server.id) ?? 0);
						open.set(server.id, (open.get(server.id) ?? 1) - 1);
						return { ok: true };
					}
				}) as unknown as WardogsClient
		);
	});

	// The worker renews its ownership every few seconds; these tests outlast one lease together.
	beforeEach(async () => {
		expect(await acquireOrRenew(env, 'delivery-fairness')).toBe(true);
	});

	// A test that fails part-way must not leave its loop or its rows running into the next one.
	afterEach(async () => {
		stopDelivery();
		for (let i = 0; i < 400 && deliveryStats().chains > 0; i++) await Bun.sleep(25);
		await env.db
			.update(outbox)
			.set({ state: 'skipped', outcome: 'Left over by a test.', doneAt: new Date() })
			.where(
				and(
					inArray(outbox.serverId, [w.server.id, w.otherServer.id]),
					inArray(outbox.state, ['pending', 'sending'])
				)
			);
	});

	afterAll(async () => {
		clearInterval(renewing);
		stopDelivery();
		spy?.mockRestore();
		forgetMemory(w.server.id);
		forgetMemory(w.otherServer.id);
		await releaseOwnership(env);
	});

	let seq = 0;
	/** Queues one broadcast row per message on a server; returns their ids, oldest first. */
	const queue = async (serverId: string, messages: string[]) =>
		(
			await env.db
				.insert(outbox)
				.values(
					messages.map((message) => ({
						serverId,
						triggerName: 'Broadcast',
						triggerKind: 'broadcast',
						action: 'broadcast',
						params: { message },
						target: message,
						okMessage: 'Broadcast sent.',
						dedupeKey: `fairness-${seq++}`
					}))
				)
				.returning({ id: outbox.id })
		).map((r) => r.id);
	const rowsOf = async (ids: number[]) =>
		(await env.db.select().from(outbox).where(inArray(outbox.id, ids))).sort((a, b) => a.id - b.id);
	const until = async (ok: () => Promise<boolean>, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!(await ok())) {
			if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
			await Bun.sleep(25);
		}
	};
	const settled = (ids: number[]) => async () =>
		(await rowsOf(ids)).every((r) => r.state !== 'pending' && r.state !== 'sending');

	test('a slow server holds up no other server', async () => {
		answerMs.set(w.server.id, 2500);
		answerMs.set(w.otherServer.id, 0);
		const slowRows = await queue(w.server.id, ['slow 1', 'slow 2']);
		startDelivery(env);
		await until(async () => sent.some((s) => s.message === 'slow 1'));
		// Queued while the slow server's chain has five seconds still to run.
		const queuedAt = Date.now();
		const [quick] = await queue(w.otherServer.id, ['quick']);
		await until(async () => (await rowsOf([quick]))[0].state === 'delivered');
		expect(Date.now() - queuedAt).toBeLessThan(4000);
		await until(settled(slowRows));
		expect((await rowsOf(slowRows)).map((r) => r.state)).toEqual(['delivered', 'delivered']);
	}, 30_000);

	test("a burst on one server does not fill a claim, and each server's rows go out in order", async () => {
		answerMs.set(w.server.id, 40);
		answerMs.set(w.otherServer.id, 0);
		const burst = Array.from({ length: 60 }, (_, i) => `burst ${i}`);
		const burstRows = await queue(w.server.id, burst);
		const [after] = await queue(w.otherServer.id, ['after the burst']);
		const from = sent.length;
		const overlapsBefore = overlaps;
		startDelivery(env);
		await until(settled([...burstRows, after]));
		const order = sent.slice(from).map((s) => s.message);
		// Claimed with the burst's first rows, not after the first fifty of them.
		expect(order.indexOf('after the burst')).toBeLessThan(3);
		expect(order.filter((m) => m.startsWith('burst'))).toEqual(burst);
		expect(overlaps - overlapsBefore).toBe(0);
		expect((await rowsOf([...burstRows, after])).every((r) => r.state === 'delivered')).toBe(true);
	}, 30_000);

	test('a send that outlasts its lease is not marked unknown by the passes that run meanwhile', async () => {
		await saveSettings(env, { outboxLeaseMs: 5000 }, null);
		try {
			answerMs.set(w.server.id, 6000);
			const [long] = await queue(w.server.id, ['longer than the lease']);
			startDelivery(env);
			await until(async () => (await rowsOf([long]))[0].doneAt !== null, 15_000);
			const [row] = await rowsOf([long]);
			expect([row.state, row.outcome]).toEqual(['delivered', 'Broadcast sent.']);
		} finally {
			stopDelivery();
			await resetSetting(env, 'outboxLeaseMs');
		}
	}, 30_000);

	test('no pass starts after stopDelivery, not even from a chain that ends later', async () => {
		answerMs.set(w.server.id, 1500);
		answerMs.set(w.otherServer.id, 0);
		const [first] = await queue(w.server.id, ['before the stop']);
		startDelivery(env);
		await until(async () => sent.some((s) => s.message === 'before the stop'));
		stopDelivery();
		const [late] = await queue(w.otherServer.id, ['after the stop']);
		// The running chain finishes its row; its end wakes no pass.
		await until(settled([first]));
		await Bun.sleep(1500);
		expect((await rowsOf([first, late])).map((r) => r.state)).toEqual(['delivered', 'pending']);
	}, 30_000);

	test('rows claimed by a pass that was stopped part-way go back unsent', async () => {
		answerMs.set(w.server.id, 0);
		// A send that lapsed long ago: the pass's lease sweep must lock it, and waits while a
		// transaction of the test's own holds it.
		const [lapsed] = await env.db
			.insert(outbox)
			.values({
				serverId: w.otherServer.id,
				triggerName: 'Broadcast',
				triggerKind: 'broadcast',
				action: 'broadcast',
				params: { message: 'lapsed' },
				target: 'lapsed',
				dedupeKey: `fairness-${seq++}`,
				state: 'sending',
				leaseUntil: new Date(Date.now() - 60_000)
			})
			.returning({ id: outbox.id });
		let taken!: () => void;
		let letGo!: () => void;
		const lockTaken = new Promise<void>((r) => (taken = r));
		const released = new Promise<void>((r) => (letGo = r));
		const holder = env.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM outbox WHERE id = ${lapsed.id} FOR UPDATE`);
			taken();
			await released;
		});
		await lockTaken;
		try {
			const rows = await queue(w.server.id, [
				'claimed after the stop 1',
				'claimed after the stop 2'
			]);
			const from = sent.length;
			startDelivery(env);
			// The first pass starts at the first tick and waits on the lock inside its transaction.
			await Bun.sleep(1500);
			// As a worker shuts down: stop, wait for the pass caught claiming, then give the lease up.
			const stopping = stopDelivery();
			letGo();
			await holder;
			await stopping;
			await releaseOwnership(env);
			expect((await rowsOf([lapsed.id]))[0].state).toBe('unknown');
			expect((await rowsOf(rows)).map((r) => [r.state, r.attempts])).toEqual([
				['pending', 1],
				['pending', 1]
			]);
			expect(sent.slice(from)).toEqual([]);
		} finally {
			letGo();
			await holder.catch(() => {});
		}
	}, 30_000);
});
