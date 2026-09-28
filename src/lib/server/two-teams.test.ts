import { describe, expect, test } from 'bun:test';
import {
	TWO_TEAMS_FORGET_MS,
	TWO_TEAMS_RETRY_MS,
	teamName,
	twoTeamsStep,
	validateTwoTeams,
	type TwoTeamsConfig
} from './two-teams';

const cfg: TwoTeamsConfig = {
	closedFaction: 'Lonestar',
	names: { Valkyra: 'Red', Manticore: 'Green' },
	message: 'You are on {team}.'
};
const OPEN = ['Valkyra', 'Manticore'];
const p = (id: string, faction: string | null) => ({ steamId: id, name: `P${id}`, faction });
const first = () => 0;

describe('validateTwoTeams', () => {
	test('needs a closed faction', () => {
		expect(() => validateTwoTeams({})).toThrow('faction');
	});
	test('keeps names for the open factions only, and an empty message', () => {
		expect(
			validateTwoTeams({
				closedFaction: 'Lonestar',
				names: { Lonestar: 'Blue', Valkyra: 'Red', Manticore: '' }
			})
		).toEqual({ closedFaction: 'Lonestar', names: { Valkyra: 'Red' }, message: '' });
	});
});

describe('twoTeamsStep', () => {
	test('moves everyone on the closed faction, filling the smaller side first', () => {
		const players = [
			p('1', 'Valkyra'),
			p('2', 'Valkyra'),
			p('3', 'Lonestar'),
			p('4', 'Lonestar'),
			p('5', 'Lonestar')
		];
		const r = twoTeamsStep(cfg, null, players, OPEN, 0, first);
		expect(r.moves.map((m) => m.to)).toEqual(['Manticore', 'Manticore', 'Valkyra']);
		expect(r.changed).toBe(true);
	});

	test('does nothing with fewer than two open factions', () => {
		const r = twoTeamsStep(cfg, null, [p('1', 'Lonestar')], ['Valkyra'], 0);
		expect(r.moves).toEqual([]);
	});

	test('leaves unplaced players and the open sides alone', () => {
		const r = twoTeamsStep(
			cfg,
			null,
			[p('1', null), p('2', 'Valkyra'), p('3', 'Valkyra'), p('4', 'Valkyra')],
			OPEN,
			0
		);
		expect(r.moves).toEqual([]);
		expect(r.changed).toBe(false);
	});

	test('a move in flight is not asked for again, and counts toward its side', () => {
		const a = twoTeamsStep(cfg, null, [p('1', 'Lonestar')], OPEN, 0, first);
		expect(a.moves).toHaveLength(1);
		const to = a.moves[0].to;
		const b = twoTeamsStep(
			cfg,
			a.state,
			[p('1', 'Lonestar'), p('2', 'Lonestar')],
			OPEN,
			5000,
			first
		);
		expect(b.moves).toEqual([expect.objectContaining({ steamId: '2' })]);
		expect(b.moves[0].to).not.toBe(to);
	});

	test('a move that has not landed is retried', () => {
		const a = twoTeamsStep(cfg, null, [p('1', 'Lonestar')], OPEN, 0, first);
		const b = twoTeamsStep(cfg, a.state, [p('1', 'Lonestar')], OPEN, TWO_TEAMS_RETRY_MS, first);
		expect(b.moves).toHaveLength(1);
	});

	test('a landed player is whispered once, and not again after the next match re-sort', () => {
		const a = twoTeamsStep(cfg, null, [p('1', 'Lonestar')], OPEN, 0, first);
		const b = twoTeamsStep(cfg, a.state, [p('1', a.moves[0].to)], OPEN, 5000);
		expect(b.whispers).toEqual([{ steamId: '1', name: 'P1', faction: a.moves[0].to }]);
		const c = twoTeamsStep(cfg, b.state, [p('1', 'Lonestar')], OPEN, 60_000, first);
		const d = twoTeamsStep(cfg, c.state, [p('1', c.moves[0].to)], OPEN, 65_000);
		expect(d.whispers).toEqual([]);
	});

	test('no whisper without a message, and none for players it never moved', () => {
		const quiet = { ...cfg, message: '' };
		const a = twoTeamsStep(quiet, null, [p('1', 'Lonestar')], OPEN, 0);
		expect(twoTeamsStep(quiet, a.state, [p('1', 'Valkyra')], OPEN, 5000).whispers).toEqual([]);
		expect(twoTeamsStep(cfg, null, [p('2', 'Valkyra')], OPEN, 0).whispers).toEqual([]);
	});

	test('a told player is forgotten after long enough away', () => {
		const a = twoTeamsStep(cfg, null, [p('1', 'Lonestar')], OPEN, 0);
		const b = twoTeamsStep(cfg, a.state, [p('1', 'Valkyra')], OPEN, 1000);
		const gone = twoTeamsStep(cfg, b.state, [], OPEN, 1000 + TWO_TEAMS_FORGET_MS + 1);
		expect(gone.state.told).toEqual({});
	});
});

test('teamName falls back to the faction', () => {
	expect(teamName(cfg, 'Valkyra')).toBe('Red');
	expect(teamName({ ...cfg, names: {} }, 'Valkyra')).toBe('Valkyra');
});
