/**
 * One CSV cell. Quotes and escapes as usual, and text that a spreadsheet would run as a formula
 * (a cell starting with = + - @, a tab or a carriage return) is prefixed with an apostrophe and
 * quoted, per OWASP's CSV injection guidance. Only strings can come from users; numbers, dates
 * and JSON objects are emitted as they are.
 */
export function csvCell(v: unknown): string {
	let s =
		v === null || v === undefined
			? ''
			: v instanceof Date
				? v.toISOString()
				: typeof v === 'object'
					? JSON.stringify(v)
					: String(v);
	const formula = typeof v === 'string' && /^[=+\-@\t\r]/.test(s);
	if (formula) s = `'${s}`;
	return formula || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A server or org name as the start of a download's file name: lowercase ASCII letters and
 * digits joined by dashes, at most 40 characters, so it needs no quoting in Content-Disposition.
 */
export function fileSlug(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/, '');
	return slug || 'warcon';
}
