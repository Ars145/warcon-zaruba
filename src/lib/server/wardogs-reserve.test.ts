import { describe, expect, test } from 'bun:test';
import {
	activeReserve,
	pickWinner,
	type ClanDoc,
	type ClanSlotDoc,
	type PersonalDoc,
	type RevDoc
} from './wardogs-reserve';
import type { CouchDoc } from './couch';

type TestDoc = CouchDoc & { expiresAt: string | null };

const now = new Date('2026-09-09T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

const personal = (steamId: string, expiresAt: string | null, extra: Partial<PersonalDoc> = {}): PersonalDoc => ({
	_id: `personal:${steamId}`,
	_rev: '1-a',
	type: 'personal',
	steamId,
	expiresAt,
	reason: '',
	addedBy: 'admin',
	addedAt: ago(1000),
	...extra
});

const clan = (clanId: string, expiresAt: string, extra: Partial<ClanDoc> = {}): ClanDoc => ({
	_id: `clan:${clanId}`,
	_rev: '1-a',
	type: 'clan',
	clanId,
	clanTag: 'TAG',
	slots: 5,
	expiresAt,
	...extra
});

const clanslot = (clanId: string, steamId: string, extra: Partial<ClanSlotDoc> = {}): ClanSlotDoc => ({
	_id: `clanslot:${clanId}:${steamId}`,
	_rev: '1-a',
	type: 'clanslot',
	clanId,
	steamId,
	assignedBy: 'admin',
	assignedAt: ago(1000),
	...extra
});

describe('activeReserve', () => {
	test('an expired personal grant is dropped', () => {
		const out = activeReserve([personal('1', ago(1000))], now);
		expect(out).toEqual([]);
	});

	test('a null (permanent) expiry is kept', () => {
		const out = activeReserve([personal('1', null)], now);
		expect(out).toEqual([{ steamId: '1', expiresAt: null, source: 'personal' }]);
	});

	test('a clanslot whose clan has expired is dropped', () => {
		const docs = [clan('c1', ago(1000)), clanslot('c1', '1')];
		expect(activeReserve(docs, now)).toEqual([]);
	});

	test('a clanslot whose clan doc is missing is dropped', () => {
		const out = activeReserve([clanslot('c1', '1')], now);
		expect(out).toEqual([]);
	});

	test('a player with both an active personal grant and an active clan slot appears once', () => {
		const docs = [personal('1', ahead(1000)), clan('c1', ahead(5000)), clanslot('c1', '1')];
		const out = activeReserve(docs, now);
		expect(out).toHaveLength(1);
		expect(out[0].steamId).toBe('1');
		expect(out[0].source).toBe('personal');
		// the later of the two expiries is kept
		expect(out[0].expiresAt).toBe(ahead(5000));
	});

	test('personal wins for display, and a permanent personal grant stays permanent even with a dated clan slot', () => {
		const docs = [personal('1', null), clan('c1', ahead(5000)), clanslot('c1', '1')];
		const out = activeReserve(docs, now);
		expect(out).toEqual([{ steamId: '1', expiresAt: null, source: 'personal' }]);
	});

	test('a clan slot with no personal grant shows as clan, with the clan tag', () => {
		const docs = [clan('c1', ahead(5000), { clanTag: 'ZARUBA' }), clanslot('c1', '1')];
		const out = activeReserve(docs, now);
		expect(out).toEqual([{ steamId: '1', expiresAt: ahead(5000), source: 'clan', clanTag: 'ZARUBA' }]);
	});
});

describe('pickWinner', () => {
	test('a null expiry beats any dated revision', () => {
		const revs: RevDoc<TestDoc>[] = [
			{ rev: '1-a', doc: { _id: 'x', expiresAt: ahead(1000) } },
			{ rev: '2-b', doc: { _id: 'x', expiresAt: null } },
			{ rev: '3-c', doc: { _id: 'x', expiresAt: ahead(5000) } }
		];
		expect(pickWinner(revs).rev).toBe('2-b');
	});

	test('among dated revisions, the max expiry wins', () => {
		const revs: RevDoc<TestDoc>[] = [
			{ rev: '1-a', doc: { _id: 'x', expiresAt: ahead(1000) } },
			{ rev: '2-b', doc: { _id: 'x', expiresAt: ahead(9000) } },
			{ rev: '3-c', doc: { _id: 'x', expiresAt: ahead(5000) } }
		];
		expect(pickWinner(revs).rev).toBe('2-b');
	});
});
