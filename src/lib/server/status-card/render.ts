// The two pictures a live status message carries: the score bars and the top of the scoreboard.
//
// Both come off one page in one pass, because they are one document — the template holds #scores
// and #top side by side and each is photographed on its own. The template, the fonts and the
// banner live beside the match card's, so the two cards share one set of font files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir, fill, shoot, template } from '../match-card/render';
import type { StatusCard } from './data';

/** The design's own width. The height follows the content. */
const CARD_WIDTH = 1200;

const num = (n: number) => n.toLocaleString('ru-RU');
const cut = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s);

/** Everything the template reads, in the shapes it expects. */
export function statusVals(card: StatusCard): Record<string, unknown> {
	const online = `${card.online}/${card.maxPlayers}`;
	return {
		mapName: cut(card.mapName, 24),
		modeLine: `${cut(card.mode, 34)} · ${online}`,
		factions: card.factions.map((f) => ({
			name: cut(f.name, 16),
			colorHex: f.colorHex,
			score: num(f.score),
			pct: f.pct
		})),
		scoresFoot: [`до ${num(card.scoreCap)} очков`, card.lighting, card.zone]
			.filter(Boolean)
			.join(' · '),
		rows: card.rows.map((r) => ({
			rank: r.rank,
			name: cut(r.name, 22),
			faction: r.faction ? cut(r.faction, 16) : 'без стороны',
			factionColor: r.factionColor,
			kills: num(r.kills),
			deaths: num(r.deaths),
			cash: num(r.cash),
			topClass: r.rank <= 3 ? 'top' : ''
		}))
	};
}

/** The finished document, ready to photograph. Pure: no browser, no filesystem beyond the cache. */
export const statusHtml = (card: StatusCard): string =>
	fill(template('status.html'), statusVals(card));

/** The banner strip, the same bytes every time. Read once. */
let bannerCache: Uint8Array<ArrayBuffer> | null = null;
export function banner(): Uint8Array<ArrayBuffer> {
	if (!bannerCache) bannerCache = new Uint8Array(readFileSync(join(assetsDir(), 'banner.webp')));
	return bannerCache;
}

/** Photographs both pictures. Throws if Chromium is missing or the page never settles. */
export async function renderStatusCard(
	card: StatusCard
): Promise<{ scores: Uint8Array<ArrayBuffer>; top: Uint8Array<ArrayBuffer> }> {
	// webp, not png: these go up whole on every edit, and the table alone is 226 KB as a png.
	const [scores, top] = await shoot(statusHtml(card), ['#scores', '#top'], CARD_WIDTH, {
		type: 'webp',
		quality: 92
	});
	return { scores, top };
}
