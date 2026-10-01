// A rule's list of kill feed cause tags as its settings hold it: the Kill distance watch's weapons,
// the causes the Team kill limit does not count. The game's casing varies between tags, so a tag is
// kept once in any case and matched in any case.
import { ApiError, str } from './http';

/** A cause tag as the feed writes them: dotted words. */
const TAG_RE = /^[A-Za-z0-9_.-]{1,200}$/;
export const MAX_CAUSES = 40;

/**
 * The tags of a list sent as an array, or as text with one per line or comma: blanks dropped, a
 * tag named twice kept once. `noun` and `example` word the 400s.
 */
export function causeTags(raw: unknown, noun: string, example: string): string[] {
	const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,]/);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of list) {
		const tag = str(v, 200);
		if (!tag) continue;
		if (!TAG_RE.test(tag))
			throw new ApiError(400, `A ${noun} is its kill feed tag, such as ${example}.`);
		if (seen.has(tag.toLowerCase())) continue;
		seen.add(tag.toLowerCase());
		out.push(tag);
	}
	if (out.length > MAX_CAUSES) throw new ApiError(400, `Pick at most ${MAX_CAUSES} ${noun}s.`);
	return out;
}
