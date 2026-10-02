import { describe, expect, test } from 'bun:test';
import {
	AFK_REARM_EMPTY_MS,
	afkReplay,
	afkState,
	afkStep,
	validateAfkProtection,
	type AfkLook,
	type AfkProtectionState
} from './afk-protection';

const MIN = 60_000;
/** Looks are timed from here: a real clock, never 0 (which a state reads as none). */
const T0 = Date.UTC(2026, 9, 2, 6);
const cfg = validateAfkProtection({});
/** A look at a seeding server `at` ms after T0: 5 on, nobody has scored, the list taken. */
const look = (at: number, over: Partial<AfkLook> = {}): AfkLook => ({
	now: T0 + at,
	count: 5,
	scored: false,
	startedAt: 1,
	listed: true,
	recovered: false,
	emptyFor: 0,
	...over
});
/** Runs looks in turn from a state, returning every step. */
function run(prev: AfkProtectionState | null, looks: AfkLook[], goal = 20) {
	const steps = [];
	let state = prev;
	for (const l of looks) {
		const step = afkStep(cfg, state, l, goal);
		steps.push(step);
		state = step.state;
	}
	return steps;
}

describe('validateAfkProtection', () => {
	test('defaults to every 3 min, off at 20, no messages; clamps what is out of range', () => {
		expect(cfg).toEqual({ everyMinutes: 3, stopAt: 20, message: '', doneMessage: '' });
		expect(validateAfkProtection({ stopAt: '' }).stopAt).toBe(20);
		expect(validateAfkProtection({ stopAt: 25 }).stopAt).toBe(25);
		expect(validateAfkProtection({ everyMinutes: 1, stopAt: 1 })).toMatchObject({
			everyMinutes: 2,
			stopAt: 2
		});
		expect(validateAfkProtection({ everyMinutes: 60, stopAt: 5000 })).toMatchObject({
			everyMinutes: 10,
			stopAt: 1000
		});
		expect(validateAfkProtection({ message: 'x'.repeat(400) }).message).toHaveLength(256);
	});
});

describe('afkState', () => {
	test('only a state the rule wrote', () => {
		expect(afkState(null)).toBeNull();
		expect(afkState({ enabledAt: 5 })).toBeNull();
		expect(afkState({ on: true, roundAt: 'x' })).toEqual({
			on: true,
			since: 0,
			startedAt: 0,
			seedingSince: 0,
			roundAt: 0,
			why: ''
		});
		expect(afkState({ on: false, since: 5, why: 'a side scored' })).toMatchObject({
			on: false,
			why: 'a side scored'
		});
	});
});

describe('afkStep', () => {
	test('switched on while the server seeds: the first round waits the full interval, then one every interval', () => {
		const steps = run(null, [
			look(0),
			look(1 * MIN),
			look(3 * MIN - 1),
			look(3 * MIN),
			look(4 * MIN),
			look(6 * MIN)
		]);
		expect(steps.map((s) => s.round)).toEqual([false, false, false, true, false, true]);
		expect(steps[0].state).toMatchObject({ on: true, seedingSince: T0, roundAt: 0 });
		expect(steps.every((s) => s.state.on)).toBe(true);
	});

	test('a round needs a look that took the player list', () => {
		const [, late, listed] = run(null, [
			look(0),
			look(3 * MIN, { listed: false }),
			look(3 * MIN + 2000)
		]);
		expect(late.round).toBe(false);
		expect(listed.round).toBe(true);
	});

	test('switched on during a match: off, whatever the count', () => {
		expect(afkStep(cfg, null, look(0, { scored: true }), 20)).toMatchObject({
			state: { on: false, why: 'a side scored' },
			off: 'a side scored',
			done: false
		});
		expect(afkStep(cfg, null, look(0, { count: 20 }), 20)).toMatchObject({
			state: { on: false },
			off: 'reached 20 (20 on)'
		});
	});

	test('a score or the count reaching the goal turns it off, and a dip below the count does not turn it on', () => {
		const steps = run(null, [
			look(0),
			look(3 * MIN),
			look(4 * MIN, { count: 20 }),
			look(5 * MIN, { count: 12 }),
			look(9 * MIN, { count: 3 }),
			look(12 * MIN, { count: 3 })
		]);
		expect(steps.map((s) => s.round)).toEqual([false, true, false, false, false, false]);
		expect(steps[2]).toMatchObject({ off: 'reached 20 (20 on)', done: true });
		expect(steps.slice(2).every((s) => !s.state.on)).toBe(true);
		const scored = run(null, [look(0), look(3 * MIN), look(4 * MIN, { scored: true })]);
		expect(scored[2]).toMatchObject({ off: 'a side scored', done: true });
	});

	test('the thank-you only after a round it ran, and never on the first look back from an outage', () => {
		const early = run(null, [look(0), look(1 * MIN, { count: 20 })]);
		expect(early[1]).toMatchObject({ off: 'reached 20 (20 on)', done: false });
		const back = run(null, [
			look(0),
			look(3 * MIN),
			look(5 * MIN, { scored: true, recovered: true })
		]);
		expect(back[2]).toMatchObject({ off: 'a side scored', done: false });
	});

	test('off: the empty list of a map change does not turn it on; ten minutes empty does', () => {
		const off: AfkProtectionState = {
			on: false,
			since: 0,
			startedAt: 1,
			seedingSince: 0,
			roundAt: 0,
			why: 'a side scored'
		};
		const steps = run(off, [
			look(1 * MIN, { count: 0, emptyFor: 35_000 }),
			look(2 * MIN, { count: 30, scored: true }),
			look(30 * MIN, { count: 0, emptyFor: AFK_REARM_EMPTY_MS - 1 }),
			look(31 * MIN, { count: 0, emptyFor: AFK_REARM_EMPTY_MS }),
			look(32 * MIN, { count: 2 }),
			look(35 * MIN, { count: 2 })
		]);
		expect(steps.map((s) => s.state.on)).toEqual([false, false, false, true, true, true]);
		expect(steps[3].rearmed).toBe(true);
		expect(steps.map((s) => s.round)).toEqual([false, false, false, false, false, true]);
	});

	test('off: an empty server still showing a score stays off, and writes nothing new', () => {
		const off: AfkProtectionState = {
			on: false,
			since: 0,
			startedAt: 1,
			seedingSince: 0,
			roundAt: 0,
			why: 'a side scored'
		};
		const step = afkStep(
			cfg,
			off,
			look(60 * MIN, { count: 0, scored: true, emptyFor: 50 * MIN }),
			20
		);
		expect(step.state).toEqual(off);
	});

	test('off: a later game start turns it on; one first seen with a match on is spent', () => {
		const off: AfkProtectionState = {
			on: false,
			since: 0,
			startedAt: 1_000,
			seedingSince: 0,
			roundAt: 0,
			why: 'a side scored'
		};
		const restarted = afkStep(cfg, off, look(MIN, { count: 0, startedAt: 90_000 }), 20);
		expect(restarted).toMatchObject({ rearmed: true, state: { on: true, startedAt: 90_000 } });
		// restarted, but the players were back before the rule looked: nothing turns on, and the
		// empty list of the next map change cannot use that restart
		const busy = run(off, [
			look(MIN, { count: 40, startedAt: 90_000 }),
			look(40 * MIN, { count: 0, startedAt: 90_000, emptyFor: 35_000 }),
			look(41 * MIN, { count: 3, startedAt: 90_000 })
		]);
		expect(busy.map((s) => s.state.on)).toEqual([false, false, false]);
		expect(busy[0].state.startedAt).toBe(90_000);
		// the same start read again, a few seconds out, is no restart
		expect(afkStep(cfg, off, look(MIN, { count: 0, startedAt: 4_000 }), 20).state.on).toBe(false);
	});

	test('off with no start known: the first start read is kept, so the restart after it is seen', () => {
		const off: AfkProtectionState = {
			on: false,
			since: 0,
			startedAt: 0,
			seedingSince: 0,
			roundAt: 0,
			why: 'a side scored'
		};
		const steps = run(off, [
			look(MIN, { count: 30, scored: true, startedAt: 5_000 }),
			look(2 * MIN, { count: 0, startedAt: 500_000 })
		]);
		expect(steps[0].state).toMatchObject({ on: false, startedAt: 5_000 });
		expect(steps[1]).toMatchObject({ rearmed: true, state: { on: true } });
	});

	test('nobody on ends the stretch; the next player gets the full interval', () => {
		const steps = run(null, [
			look(0),
			look(3 * MIN),
			look(4 * MIN, { count: 0 }),
			look(5 * MIN, { count: 1 }),
			look(7 * MIN, { count: 1 }),
			look(8 * MIN, { count: 1 })
		]);
		expect(steps.map((s) => s.round)).toEqual([false, true, false, false, false, true]);
		expect(steps[2].state.seedingSince).toBe(0);
		expect(steps[3].state.seedingSince).toBe(T0 + 5 * MIN);
	});

	test('back from an outage the stretch starts again', () => {
		const steps = run(null, [
			look(0),
			look(3 * MIN),
			look(20 * MIN, { recovered: true }),
			look(22 * MIN),
			look(23 * MIN)
		]);
		expect(steps.map((s) => s.round)).toEqual([false, true, false, false, true]);
	});

	test('off: a start read a few seconds later is no restart', () => {
		const off: AfkProtectionState = {
			on: false,
			since: 0,
			startedAt: T0,
			seedingSince: 0,
			roundAt: 0,
			why: 'a side scored'
		};
		// a slow read of the uptime, then a quick one: the start moves by the difference
		expect(afkStep(cfg, off, look(MIN, { count: 3, startedAt: T0 + 6_000 }), 20).state.on).toBe(
			false
		);
		expect(afkStep(cfg, off, look(MIN, { count: 3, startedAt: T0 + 61_000 }), 20).state.on).toBe(
			true
		);
	});

	test('a look that changes nothing hands back the same state', () => {
		const [first, second] = run(null, [look(0), look(MIN)]);
		expect(second.state).toEqual(first.state);
	});
});

describe('afkReplay', () => {
	test('rounds while the server seeds, off at the match, on again after it sat empty', () => {
		const at = (m: number) => T0 + m * MIN;
		const sample = (m: number, count: number, score = 0, ok = true) => ({
			ts: at(m),
			ok,
			count,
			scores: [{ score }, { score: 0 }]
		});
		const items = afkReplay(
			cfg,
			[
				sample(0, 3),
				sample(3, 4),
				sample(6, 8),
				sample(7, 21),
				sample(8, 25, 4),
				sample(20, 0),
				sample(31, 0),
				sample(32, 2),
				sample(35, 2)
			],
			20
		);
		expect(items.map((i) => [i.kind, i.at, i.count])).toEqual([
			['round', at(3), 4],
			['round', at(6), 8],
			['off', at(7), 21],
			['on', at(31), 0],
			['round', at(35), 2]
		]);
	});

	test('a window that begins with a match on starts off', () => {
		const items = afkReplay(cfg, [{ ts: T0, ok: true, count: 30, scores: [{ score: 9 }] }], 20);
		expect(items).toEqual([{ at: T0, kind: 'off', count: 30, why: 'a side scored' }]);
	});
});
