import { describe, expect, it } from 'bun:test';
import { buildAwards, buildFactions, buildScoreboard, kdOf, TOP_KD_MIN_KILLS } from './data';
import { cardHtml, renderVals } from './render';
import type { MatchResultCard } from './data';
import type { Player } from '$lib/types';

const player = (p: Partial<Player> & { name: string }): Player => ({
	steamId: p.steamId ?? p.name,
	faction: p.faction ?? 'Valkyra',
	kills: p.kills ?? 0,
	deaths: p.deaths ?? 0,
	cash: p.cash ?? 0,
	ping: null,
	...p
});

describe('kdOf', () => {
	it('is the kill count for someone who never died', () => {
		expect(kdOf(9, 0)).toBe(9);
		expect(kdOf(0, 0)).toBe(0);
	});
	it('rounds to two decimals', () => {
		expect(kdOf(7, 3)).toBe(2.33);
	});
});

describe('buildAwards', () => {
	const grinder = player({ name: 'grinder', kills: 40, deaths: 20, cash: 9000 });
	const sniper = player({ name: 'sniper', kills: 12, deaths: 2, cash: 1000 });
	const lucky = player({ name: 'lucky', kills: 3, deaths: 0, cash: 500 });

	it('keeps a three-kill run out of best K/D', () => {
		const { topKd } = buildAwards([grinder, sniper, lucky]);
		expect(topKd?.name).toBe('sniper');
	});

	it('leaves best K/D empty when nobody reaches the threshold', () => {
		expect(buildAwards([lucky]).topKd).toBeNull();
		expect(TOP_KD_MIN_KILLS).toBe(10);
	});

	it('picks kills and cash independently', () => {
		const rich = player({ name: 'rich', kills: 1, deaths: 1, cash: 99_000 });
		const a = buildAwards([grinder, rich]);
		expect(a.topKills?.name).toBe('grinder');
		expect(a.topCash?.name).toBe('rich');
	});

	it('has no heroes on an empty match', () => {
		expect(buildAwards([])).toEqual({ topKills: null, topCash: null, topKd: null });
		const idle = player({ name: 'idle' });
		expect(buildAwards([idle]).topKills).toBeNull();
	});
});

describe('buildScoreboard', () => {
	it('ranks by kills, breaks ties on cash, and marks newcomers', () => {
		const rows = buildScoreboard(
			[
				player({ name: 'a', steamId: '1', kills: 3, cash: 10 }),
				player({ name: 'b', steamId: '2', kills: 3, cash: 90 }),
				player({ name: 'c', steamId: '3', kills: 5, cash: 0 })
			],
			new Set(['2'])
		);
		expect(rows.map((r) => r.name)).toEqual(['c', 'b', 'a']);
		expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
		expect(rows.find((r) => r.name === 'b')?.newcomer).toBe(true);
	});
});

describe('buildFactions', () => {
	it('sorts by score, counts sides and flags only the winner', () => {
		const out = buildFactions(
			[
				{ name: 'Lonestar', colorHex: '#4CB1EF', score: 37 },
				{ name: 'Manticore', colorHex: '#1DD65C', score: 100 }
			],
			[
				player({ name: 'x', faction: 'Manticore' }),
				player({ name: 'y', faction: 'Manticore' }),
				player({ name: 'z', faction: null })
			],
			'Manticore'
		);
		expect(out.map((f) => f.name)).toEqual(['Manticore', 'Lonestar']);
		expect(out[0]).toMatchObject({ players: 2, winner: true });
		expect(out[1]).toMatchObject({ players: 0, winner: false });
	});

	it('flags nobody when the match was a draw', () => {
		const out = buildFactions([{ name: 'Lonestar', colorHex: '#4CB1EF', score: 0 }], [], null);
		expect(out[0].winner).toBe(false);
	});
});

const card = (over: Partial<MatchResultCard> = {}): MatchResultCard => ({
	endedAt: '2026-09-19T20:09:50.000Z',
	serverName: 'ZARUBA',
	orgName: 'Zaruba',
	match: {
		mapId: 'Europe',
		mapName: 'Ozeti',
		mode: 'King of the Hill',
		lighting: 'DayLateGray',
		durationSec: 4527,
		peakPlayers: 100,
		maxPlayers: 100,
		playersSeen: 153
	},
	factions: [{ name: 'Manticore', colorHex: '#1DD65C', score: 100, players: 34, winner: true }],
	winner: 'Manticore',
	scoreboard: buildScoreboard([player({ name: 'kig07', kills: 49, deaths: 5 })], new Set()),
	awards: { topKills: null, topCash: null, topKd: null },
	...over
});

describe('renderVals', () => {
	it('formats the chips the way the design asks', () => {
		const v = renderVals(card()) as { metaChips: Array<{ value: string }> };
		expect(v.metaChips.map((c) => c.value)).toEqual(['1ч 15м', '100/100', '153']);
	});

	it('says "без стороны" for a player who never picked one', () => {
		const v = renderVals(
			card({ scoreboard: buildScoreboard([player({ name: 'x', faction: null })], new Set()) })
		) as { columns: Array<{ rows: Array<{ faction: string }> }> };
		expect(v.columns[0].rows[0].faction).toBe('без стороны');
	});

	it('switches to the draw line when there is no winner', () => {
		const v = renderVals(card({ winner: null })) as { hasWinner: boolean; isDraw: boolean };
		expect(v.hasWinner).toBe(false);
		expect(v.isDraw).toBe(true);
	});

	it('clamps the scoreboard to between 5 and 30 rows', () => {
		const many = buildScoreboard(
			Array.from({ length: 40 }, (_, i) => player({ name: `p${i}`, steamId: `${i}`, kills: i })),
			new Set()
		);
		const v = renderVals(card({ scoreboard: many }), 99) as { scoreboardNote: string };
		expect(v.scoreboardNote).toBe('Топ 30 из 40');
	});
});

describe('cardHtml', () => {
	it('fills the repeated and conditional blocks', () => {
		const html = cardHtml(card());
		expect(html).toContain('Ozeti');
		expect(html).toContain('ПОБЕДА');
		expect(html).not.toContain('sc-for');
		expect(html).not.toContain('{{');
		expect(html).toContain('data:font/woff2;base64,');
	});

	it('shows one of the two result lines, never both', () => {
		expect(cardHtml(card())).not.toContain('Победитель не определён');
		const draw = cardHtml(card({ winner: null }));
		expect(draw).toContain('Победитель не определён');
		expect(draw).not.toContain('Победитель боя');
	});

	it('escapes a name that would otherwise be markup', () => {
		const nasty = buildScoreboard(
			[player({ name: '<img src=x onerror=alert(1)>', kills: 1 })],
			new Set()
		);
		const html = cardHtml(card({ scoreboard: nasty }));
		expect(html).not.toContain('<img src=x');
		// the design cuts a name at 20 characters before it is escaped
		expect(html).toContain('&lt;img src=x onerror=a…');
	});

	it('drops the awards section when nobody earned one', () => {
		expect(cardHtml(card())).not.toContain('Номинации');
	});
});
