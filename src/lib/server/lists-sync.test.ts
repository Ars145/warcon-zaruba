// zaruba: couch reserve
import { describe, expect, test } from 'bun:test';
import { includedInPostgresDesired, withReserveRemovalsHeldBack } from './lists-sync';
import type { SyncPlan } from './lists-plan';

const COUCH_ORG = 'org-wardogs';
const OTHER_ORG = 'org-other';

describe('includedInPostgresDesired', () => {
	test('bans are always included, for every org, on or off a server', () => {
		expect(includedInPostgresDesired({ kind: 'ban', orgId: COUCH_ORG, listServerId: null }, COUCH_ORG)).toBe(true);
		expect(includedInPostgresDesired({ kind: 'ban', orgId: OTHER_ORG, listServerId: null }, COUCH_ORG)).toBe(true);
		expect(includedInPostgresDesired({ kind: 'ban', orgId: COUCH_ORG, listServerId: 'srv-1' }, COUCH_ORG)).toBe(
			true
		);
	});

	test("a server's own reserve list is always included, for every org", () => {
		expect(
			includedInPostgresDesired({ kind: 'reserve', orgId: COUCH_ORG, listServerId: 'srv-1' }, COUCH_ORG)
		).toBe(true);
		expect(
			includedInPostgresDesired({ kind: 'reserve', orgId: OTHER_ORG, listServerId: 'srv-1' }, COUCH_ORG)
		).toBe(true);
	});

	test("COUCH_ORG_ID's own org-wide reserve list (server_id null) is excluded — its entries come from CouchDB", () => {
		expect(includedInPostgresDesired({ kind: 'reserve', orgId: COUCH_ORG, listServerId: null }, COUCH_ORG)).toBe(
			false
		);
	});

	test("every other org's org-wide reserve list stays included — regression test for the HIGH bug where it was dropped for every org, not just COUCH_ORG_ID's", () => {
		expect(includedInPostgresDesired({ kind: 'reserve', orgId: OTHER_ORG, listServerId: null }, COUCH_ORG)).toBe(
			true
		);
	});
});

describe('withReserveRemovalsHeldBack', () => {
	const plan = (): SyncPlan => ({
		adds: [{ kind: 'ban', steamId: '11111111111111111', listId: 'l1', reason: 'x' }],
		removes: [
			{ kind: 'reserve', steamId: '22222222222222222' },
			{ kind: 'ban', steamId: '33333333333333333' }
		],
		confirms: [],
		deletes: [],
		local: []
	});

	test('no reserveError: plan is returned unchanged', () => {
		const p = plan();
		expect(withReserveRemovalsHeldBack(p, undefined)).toEqual(p);
	});

	test('reserveError set: reserve removals are dropped, ban removals and adds are untouched', () => {
		const out = withReserveRemovalsHeldBack(plan(), 'CouchDB unreachable');
		expect(out.removes).toEqual([{ kind: 'ban', steamId: '33333333333333333' }]);
		expect(out.adds).toEqual(plan().adds);
	});

	test('reserveError set but no reserve removals in the plan: removes list is unchanged in content', () => {
		const p: SyncPlan = { ...plan(), removes: [{ kind: 'ban', steamId: '44444444444444444' }] };
		const out = withReserveRemovalsHeldBack(p, 'boom');
		expect(out.removes).toEqual([{ kind: 'ban', steamId: '44444444444444444' }]);
	});
});
