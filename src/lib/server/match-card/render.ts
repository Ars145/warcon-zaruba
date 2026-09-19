// Turns a MatchResultCard into a PNG, by filling the designer's template and photographing it.
//
// The template is the exported design, kept as plain HTML so it can be re-exported and dropped in
// again. It carries three directives — `{{ value }}`, `<sc-for list="{{ xs }}" as="x">` and
// `<sc-if value="{{ flag }}">` — which fill() below understands; nothing else runs, there is no
// client-side framework and the page makes no network request. Player names are attacker-chosen,
// so every substitution is HTML-escaped on the way in.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import type { MatchResultCard } from './data';

/** The design's own width. The height follows the content. */
const CARD_WIDTH = 1920;

/**
 * Where template.html and its fonts live: beside the built client in a container, in static/
 * while developing. Set MATCH_CARD_ASSETS to override.
 */
function assetsDir(): string {
	const candidates = [
		process.env.MATCH_CARD_ASSETS,
		join(process.cwd(), 'build', 'client', 'match-card'),
		join(process.cwd(), 'static', 'match-card')
	].filter((p): p is string => !!p);
	for (const dir of candidates) if (existsSync(join(dir, 'template.html'))) return dir;
	throw new Error(`match card template not found; looked in ${candidates.join(', ')}`);
}

const MIME: Record<string, string> = {
	woff2: 'font/woff2',
	png: 'image/png',
	webp: 'image/webp'
};

let templateCache: string | null = null;

/** The template with every `asset:name` replaced by the file itself, read once. */
function template(): string {
	if (templateCache) return templateCache;
	const dir = assetsDir();
	const raw = readFileSync(join(dir, 'template.html'), 'utf8');
	templateCache = raw.replace(/asset:([\w.-]+)/g, (_, name: string) => {
		const ext = name.split('.').pop() ?? '';
		const mime = MIME[ext];
		if (!mime) throw new Error(`match card asset ${name} has no known MIME type`);
		return `data:${mime};base64,${readFileSync(join(dir, name)).toString('base64')}`;
	});
	return templateCache;
}

/** Test seam: drop the memoised template (and let a test point at its own directory). */
export function resetTemplateCache(): void {
	templateCache = null;
}

const escapeHtml = (s: string): string =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
	);

type Scope = Record<string, unknown>;

const lookup = (scope: Scope, path: string): unknown =>
	path.split('.').reduce<unknown>((v, key) => (v == null ? v : (v as Scope)[key]), scope);

/**
 * Fills one template fragment against a scope. `sc-for` and `sc-if` are matched with their own
 * closing tag by counting nested opens, so a list of cards inside a list of columns still pairs up.
 */
function fill(tpl: string, scope: Scope): string {
	let out = '';
	let i = 0;
	while (i < tpl.length) {
		const next = tpl.indexOf('<sc-', i);
		if (next === -1) {
			out += substitute(tpl.slice(i), scope);
			break;
		}
		out += substitute(tpl.slice(i, next), scope);
		const tag = tpl.startsWith('<sc-for', next) ? 'sc-for' : 'sc-if';
		const openEnd = tpl.indexOf('>', next);
		if (openEnd === -1) throw new Error(`unclosed <${tag}> in the match card template`);
		const attrs = tpl.slice(next, openEnd);
		const close = matchingClose(tpl, tag, openEnd + 1);
		const body = tpl.slice(openEnd + 1, close.start);
		if (tag === 'sc-for') {
			const list = lookup(scope, attr(attrs, 'list')) as unknown[] | undefined;
			const as = attr(attrs, 'as');
			for (const item of list ?? []) out += fill(body, { ...scope, [as]: item });
		} else if (lookup(scope, attr(attrs, 'value'))) {
			out += fill(body, scope);
		}
		i = close.end;
	}
	return out;
}

/** `list="{{ x }}"` and `as="x"` both come back as the bare name. */
function attr(attrs: string, name: string): string {
	const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
	if (!m) throw new Error(`<sc-*> in the match card template has no ${name}`);
	return m[1].replace(/\{\{|\}\}/g, '').trim();
}

function matchingClose(tpl: string, tag: string, from: number): { start: number; end: number } {
	const open = new RegExp(`<${tag}[\\s>]`, 'g');
	const closeTag = `</${tag}>`;
	let depth = 0;
	let i = from;
	for (;;) {
		const closeAt = tpl.indexOf(closeTag, i);
		if (closeAt === -1) throw new Error(`unclosed <${tag}> in the match card template`);
		open.lastIndex = i;
		let nested = 0;
		let m: RegExpExecArray | null;
		while ((m = open.exec(tpl)) && m.index < closeAt) nested++;
		depth += nested;
		if (depth === 0) return { start: closeAt, end: closeAt + closeTag.length };
		depth--;
		i = closeAt + closeTag.length;
	}
}

const substitute = (chunk: string, scope: Scope): string =>
	chunk.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
		const v = lookup(scope, path);
		return v === undefined || v === null ? '' : escapeHtml(String(v));
	});

// ---- the design's own formatting, ported from the exported template -----------------------------

const num = (n: number) => n.toLocaleString('ru-RU');
const cut = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s);

function dur(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.round((sec % 3600) / 60);
	return h > 0 ? `${h}ч ${String(m).padStart(2, '0')}м` : `${m}м`;
}

function when(iso: string): string {
	const d = new Date(iso);
	const p = (x: number) => String(x).padStart(2, '0');
	return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} в ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const kd2 = (n: number) => n.toFixed(2);

/** Everything the template reads, in the shapes it expects. */
export function renderVals(card: MatchResultCard, rowLimit = 10): Scope {
	const limit = Math.max(5, Math.min(30, rowLimit));
	const topScore = Math.max(...card.factions.map((f) => f.score), 1);
	const colorOf = new Map(card.factions.map((f) => [f.name, f.colorHex]));

	const factions = card.factions.map((f) => ({
		name: cut(f.name, 18),
		color: f.colorHex,
		border: f.winner ? 'rgba(255,125,0,.55)' : 'rgba(255,255,255,.08)',
		score: num(f.score),
		players: f.players,
		winner: f.winner,
		pct: `${Math.round((f.score / topScore) * 100)}%`
	}));

	const m = card.match;
	const metaChips = [
		{ label: 'Длительность', value: dur(m.durationSec) },
		{ label: 'Пик игроков', value: `${m.peakPlayers}/${m.maxPlayers}` },
		{ label: 'Всего за бой', value: num(m.playersSeen) }
	];

	const rows = card.scoreboard.slice(0, limit).map((r) => ({
		rank: r.rank,
		rankColor: r.rank <= 3 ? '#ff9500' : 'rgba(255,255,255,.45)',
		name: cut(r.name, 20),
		faction: r.faction ? cut(r.faction, 16) : 'без стороны',
		factionColor: r.faction
			? (colorOf.get(r.faction) ?? 'rgba(255,255,255,.3)')
			: 'rgba(255,255,255,.25)',
		kills: num(r.kills),
		deaths: num(r.deaths),
		kd: kd2(r.kd),
		cash: num(r.cash),
		newcomer: r.newcomer,
		bg:
			r.rank <= 3
				? 'linear-gradient(90deg,rgba(255,125,0,.10),#121213)'
				: 'linear-gradient(90deg,#1a1a1c,#121213)',
		border: r.rank <= 3 ? 'rgba(255,125,0,.3)' : '#2b2b2b'
	}));

	const a = card.awards;
	const awards = [];
	if (a.topKills)
		awards.push({
			title: 'Больше всех убийств',
			name: cut(a.topKills.name, 20),
			sub: `${a.topKills.faction || 'без стороны'}, смертей ${a.topKills.deaths}, K/D ${kd2(a.topKills.kd)}`,
			value: num(a.topKills.kills)
		});
	if (a.topCash)
		awards.push({
			title: 'Больше всех кэша',
			name: cut(a.topCash.name, 20),
			sub: `${a.topCash.faction || 'без стороны'}, убийств ${a.topCash.kills}`,
			value: num(a.topCash.cash)
		});
	if (a.topKd)
		awards.push({
			title: 'Лучший K/D',
			name: cut(a.topKd.name, 20),
			sub: `${a.topKd.faction || 'без стороны'}, убийств ${a.topKd.kills}, смертей ${a.topKd.deaths}`,
			value: kd2(a.topKd.kd)
		});

	return {
		serverName: cut(card.serverName, 24),
		orgName: card.orgName,
		endedAtLabel: when(card.endedAt),
		mapName: cut(m.mapName, 28),
		mode: cut(m.mode, 40),
		metaChips,
		factions,
		factionCols: factions.length,
		hasWinner: !!card.winner,
		isDraw: !card.winner,
		winnerName: card.winner,
		columns: [{ rows }],
		sbCols: 'minmax(0,1fr)',
		scoreboardNote: `Топ ${rows.length} из ${card.scoreboard.length}`,
		awards,
		awardCols: awards.length || 1,
		hasAwards: awards.length > 0,
		footerLine: `${card.orgName}, ${m.mapId}, ${m.lighting}`
	};
}

/** The finished document, ready to photograph. Pure: no browser, no filesystem beyond the cache. */
export function cardHtml(card: MatchResultCard, rowLimit?: number): string {
	return fill(template(), renderVals(card, rowLimit));
}

// ---- the browser --------------------------------------------------------------------------------

let browser: Browser | null = null;

/**
 * One Chromium for the life of the worker: starting it costs about a second, and a card is due
 * every few minutes. `--no-sandbox` because the container runs as an unprivileged user with no
 * user namespaces of its own.
 */
async function getBrowser(): Promise<Browser> {
	if (browser?.connected) return browser;
	const { launch } = await import('puppeteer-core');
	browser = await launch({
		executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
		headless: true
	});
	return browser;
}

export async function closeCardBrowser(): Promise<void> {
	const b = browser;
	browser = null;
	if (b) await b.close().catch(() => {});
}

/** Photographs the card. Throws if Chromium is missing or the page never settles. */
export async function renderMatchCard(
	card: MatchResultCard,
	rowLimit?: number
): Promise<Uint8Array<ArrayBuffer>> {
	const html = cardHtml(card, rowLimit);
	const page = await (await getBrowser()).newPage();
	try {
		await page.setViewport({ width: CARD_WIDTH, height: 1080, deviceScaleFactor: 1 });
		await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
		await page.evaluateHandle('document.fonts.ready');
		const el = await page.$('#card');
		if (!el) throw new Error('the match card template has no #card element');
		return new Uint8Array(await el.screenshot({ type: 'png' }));
	} finally {
		await page.close().catch(() => {});
	}
}
