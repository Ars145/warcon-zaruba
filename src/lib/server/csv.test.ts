import { describe, expect, test } from 'bun:test';
import { csvCell, fileSlug } from './csv';

describe('fileSlug', () => {
	test('keeps letters and digits, dashes the rest, drops what a header would need quoted', () => {
		expect(fileSlug('Clan UK #1')).toBe('clan-uk-1');
		expect(fileSlug('[ABC] Late Nights')).toBe('abc-late-nights');
		expect(fileSlug('Night Ops // EU')).toBe('night-ops-eu');
		expect(fileSlug('José\'s "server"; rm -rf')).toBe('jose-s-server-rm-rf');
		expect(fileSlug('Ünïcödé')).toBe('unicode');
	});

	test('falls back when nothing is left, and stays short', () => {
		expect(fileSlug('★彡')).toBe('warcon');
		expect(fileSlug('')).toBe('warcon');
		expect(fileSlug('a'.repeat(39) + ' b c')).toBe('a'.repeat(39));
		expect(fileSlug('x'.repeat(80)).length).toBe(40);
	});
});

describe('csvCell', () => {
	test('plain values pass through, delimiters and quotes are quoted', () => {
		expect(csvCell('hello')).toBe('hello');
		expect(csvCell(42)).toBe('42');
		expect(csvCell(null)).toBe('');
		expect(csvCell(undefined)).toBe('');
		expect(csvCell('a,b')).toBe('"a,b"');
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
		expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
		expect(csvCell(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
		expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
	});

	test('formula-looking text is neutralised', () => {
		expect(csvCell('=1+1')).toBe(`"'=1+1"`);
		expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`);
		expect(csvCell('-2+3')).toBe(`"'-2+3"`);
		expect(csvCell('@cmd')).toBe(`"'@cmd"`);
		expect(csvCell('\tx')).toBe(`"'\tx"`);
		expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
	});

	test('numbers are never touched, so negative durations stay numeric', () => {
		expect(csvCell(-5)).toBe('-5');
	});
});
