import { describe, expect, test } from 'bun:test';
import { orgHome, orgsLink, type OrgEntry } from './orgs';

const org = (over: Partial<OrgEntry> = {}): OrgEntry => ({
	id: 'o1',
	role: 'member',
	suspended: false,
	listKinds: [],
	...over
});
const owner = org({ role: 'owner', listKinds: ['ban', 'reserve'] });

describe('orgHome', () => {
	test('an owner lands on the overview', () => {
		expect(orgHome(owner, false)).toBe('/orgs/o1');
	});
	test('a list holder lands on the ban list, or on the reserved slots when that is all they hold', () => {
		expect(orgHome(org({ listKinds: ['ban'] }), false)).toBe('/orgs/o1/bans');
		expect(orgHome(org({ listKinds: ['reserve', 'ban'] }), false)).toBe('/orgs/o1/bans');
		expect(orgHome(org({ listKinds: ['reserve'] }), false)).toBe('/orgs/o1/reserved');
	});
	test('a member whose roles hold no list has no page to land on', () => {
		expect(orgHome(org(), false)).toBeNull();
	});
	test('a suspended org opens for the site owner only', () => {
		// userOrgs gives a suspended org no lists, and the Orgs page carries the suspension as an object
		const frozen = org({ role: 'owner', suspended: true });
		expect(orgHome(frozen, false)).toBeNull();
		expect(orgHome({ ...frozen, suspended: { at: '2026-09-28', reason: '' } }, false)).toBeNull();
		expect(orgHome(frozen, true)).toBe('/orgs/o1');
	});
	test('the id is a path segment of its own', () => {
		expect(orgHome(org({ id: 'a/b?c', role: 'owner' }), false)).toBe('/orgs/a%2Fb%3Fc');
	});
});

describe('orgsLink', () => {
	test("someone in one org goes straight to that org's page", () => {
		expect(orgsLink([owner], false)).toBe('/orgs/o1');
		expect(orgsLink([org({ listKinds: ['reserve'] })], false)).toBe('/orgs/o1/reserved');
	});
	test('the list, when their one org has no page for them', () => {
		expect(orgsLink([org()], false)).toBe('/orgs');
		expect(orgsLink([org({ role: 'owner', suspended: true })], false)).toBe('/orgs');
	});
	test('the list, for no org or several', () => {
		expect(orgsLink([], false)).toBe('/orgs');
		expect(orgsLink([owner, org({ id: 'o2', role: 'owner' })], false)).toBe('/orgs');
	});
	test('the site owner keeps the list, even on a panel with one org', () => {
		expect(orgsLink([owner], true)).toBe('/orgs');
	});
});
