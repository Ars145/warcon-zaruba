// What a Kill distance rule needs of whoever saves it, for each thing it can do, and what it asks
// for when it catches someone.
import { describe, expect, test } from 'bun:test';
import { killDistanceAct, ruleNeeds, validateConfig } from './triggers';
import { KILL_DISTANCE_FLAG, type KillDistanceConfig } from './kill-distance';
import { PANEL_BAN } from './rule-ban';

const DEFIB = 'Id.Item.Defibrillator.Standard';
const A = '76561198000000001';
const rule = (c: Record<string, unknown>) =>
	validateConfig('kill_distance', { causes: [DEFIB], ...c }) as KillDistanceConfig;

describe('ruleNeeds for a Kill distance rule', () => {
	test('a flag or a kick needs Kick; a ban needs what a ban by hand on that list needs', () => {
		expect(ruleNeeds('kill_distance', rule({ action: 'flag' }))[0]).toBe('players.kick');
		expect(ruleNeeds('kill_distance', rule({ action: 'kick' }))[0]).toBe('players.kick');
		expect(ruleNeeds('kill_distance', rule({ action: 'ban' }))[0]).toBe('bans.manage');
		expect(ruleNeeds('kill_distance', rule({ action: 'ban', banScope: 'org' }))[0]).toBe(
			'lists.ban'
		);
	});
	test('raw settings, as a dry run sends them, are read as validation reads them', () => {
		const raws: unknown[] = [
			{ action: 'ban', banScope: 'org' },
			{ action: 'ban', banScope: 'server' },
			{ action: 'ban' },
			{ action: 'BAN', banScope: 'org' },
			{ action: 'kick', banScope: 'org' },
			{ banScope: 'org' },
			'ban',
			null,
			['ban']
		];
		for (const raw of raws) {
			const saved =
				raw && typeof raw === 'object' && !Array.isArray(raw)
					? rule(raw as Record<string, unknown>)
					: rule({});
			expect([raw, ruleNeeds('kill_distance', raw)]).toEqual([
				raw,
				ruleNeeds('kill_distance', saved)
			]);
		}
	});
});

describe('killDistanceAct', () => {
	const caught = { steamId: A, name: '[ABC] Night Owl', cause: DEFIB, distanceM: 4057.2 };
	test('a flag sends nothing to the game', () => {
		const a = killDistanceAct(rule({ action: 'flag' }), caught, 2, 'Example #1');
		expect(a).toMatchObject({
			action: KILL_DISTANCE_FLAG,
			params: {},
			steamId: A,
			okMessage: 'Flagged [ABC] Night Owl: Defibrillator kill from 4057 m (2 this match)'
		});
	});
	test('a kick carries the reason with its placeholders filled, and only while the player is on', () => {
		const a = killDistanceAct(
			rule({
				action: 'kick',
				count: 1,
				reason: '{name}: {weapon} at {distance} m ({count}) on {server}'
			}),
			caught,
			1,
			'Example #1'
		);
		expect(a).toMatchObject({
			action: 'kick',
			params: {
				steamId: A,
				reason: '[ABC] Night Owl: Defibrillator at 4057 m (1) on Example #1'
			},
			steamId: A,
			line: 'kick [ABC] Night Owl (76561198000000001): Defibrillator kill from 4057 m'
		});
	});
	test('a ban names its list and length, and stands whether or not the player is still on', () => {
		const here = killDistanceAct(rule({ action: 'ban' }), caught, 2, 'Example #1');
		expect(here).toMatchObject({
			action: PANEL_BAN,
			params: {
				steamId: A,
				name: '[ABC] Night Owl',
				reason: 'Impossible kill: Defibrillator from 4057 m.',
				days: 0,
				scope: 'server'
			},
			steamId: null,
			okMessage:
				'Banned [ABC] Night Owl here for good: Defibrillator kill from 4057 m (2 this match)'
		});
		const org = killDistanceAct(
			rule({ action: 'ban', banScope: 'org', banDays: 7 }),
			caught,
			2,
			'Example #1'
		);
		expect(org.params).toMatchObject({ days: 7, scope: 'org' });
		expect(org.okMessage).toStartWith('Banned [ABC] Night Owl on every server for 7 days:');
	});
});
