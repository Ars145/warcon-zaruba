import { describe, expect, it } from 'bun:test';
import { buildStatusCard, statusCardKey, TOP_ROWS } from './data';
import { bannerUrlOf, COMPONENTS_V2, statusFiles, statusPayload } from './message';
import { statusVals } from './render';
import type { LiveView, Player, Status } from '$lib/types';

const player = (p: Partial<Player> & { name: string }): Player => ({
	steamId: p.name,
	faction: 'Manticore',
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null,
	...p
});

const status = (over: Partial<Status> = {}): Status => ({
	serverName: '★ ZARUBA ★',
	// the status reports the display name, not the art folder: verified on the live server
	map: 'Ozeti',
	experiences: ['Ozeti_KOTH_01'],
	lighting: 'DayLateGray',
	alternator: 'ZoneAlternator.Ozeti.River.Circle',
	scoreTick: 20,
	scoreTickMin: null,
	scoreTickMax: null,
	// Live builds send neither; the card must not read them.
	scoreCap: null,
	matchSeconds: null,
	playerCount: 78,
	maxPlayers: 98,
	scores: [
		{ name: 'Manticore', colorHex: '#1DD65C', score: 74 },
		{ name: 'Lonestar', colorHex: '#4CB1EF', score: 61 }
	],
	rotationNow: 0,
	rotationNext: 1,
	...over
});

const live = (over: Partial<LiveView> = {}): LiveView => ({
	serverId: 's1',
	ok: true,
	error: '',
	tier: 'hot',
	build: '++Wardogs+CL-501228',
	gameServerId: '4f2a91c0',
	startedAt: '2026-09-20T08:00:00.000Z',
	reservedSlots: 2,
	throttledUntil: null,
	status: status(),
	players: [
		player({ name: 'BR', kills: 31, deaths: 4, cash: 12400 }),
		player({ name: 'Tomato', faction: 'Lonestar', kills: 24, deaths: 6, cash: 9850 })
	],
	statusAt: '2026-09-20T17:00:00.000Z',
	playersAt: '2026-09-20T17:00:00.000Z',
	observedAt: '2026-09-20T17:00:00.000Z',
	...over
});

const card = () => buildStatusCard('ZARUBA #1', 'Zaruba', live())!;

describe('buildStatusCard', () => {
	it('has nothing to draw without a look, a status or a reachable server', () => {
		expect(buildStatusCard('s', 'o', null)).toBeNull();
		expect(buildStatusCard('s', 'o', live({ status: null }))).toBeNull();
		expect(buildStatusCard('s', 'o', live({ ok: false }))).toBeNull();
		expect(buildStatusCard('s', 'o', live({ observedAt: null }))).toBeNull();
	});

	it('takes the cap from the game constant, since live builds send none', () => {
		const c = card();
		expect(c.scoreCap).toBe(100);
		expect(c.factions[0]).toMatchObject({ name: 'Manticore', pct: 74, leading: true });
		expect(c.factions[1].leading).toBe(false);
	});

	it('takes the map name the status already reports', () => {
		expect(card().mapName).toBe('Ozeti');
	});

	it('leads nobody while the board is still at nought', () => {
		const flat = status({ scores: [{ name: 'Manticore', colorHex: '#1DD65C', score: 0 }] });
		const c = buildStatusCard('s', 'o', live({ status: flat }))!;
		expect(c.factions[0].leading).toBe(false);
	});

	it('ranks by kills then cash and cuts at ten, counting the rest', () => {
		const many = Array.from({ length: 24 }, (_, i) =>
			player({ name: `p${i}`, kills: i, cash: i * 10 })
		);
		const c = buildStatusCard('s', 'o', live({ players: many }))!;
		expect(c.rows).toHaveLength(TOP_ROWS);
		expect(c.rows[0].name).toBe('p23');
		expect(c.playersTotal).toBe(24);
	});

	it('colours a player from the faction scores, and neutral when they have no side', () => {
		const c = buildStatusCard(
			's',
			'o',
			live({ players: [player({ name: 'x', faction: null }), player({ name: 'y' })] })
		)!;
		expect(c.rows.find((r) => r.name === 'y')?.factionColor).toBe('#1DD65C');
		expect(c.rows.find((r) => r.name === 'x')?.factionColor).toBe('rgba(255,255,255,.3)');
	});

	it('carries an absent join code and uptime through as empty rather than inventing them', () => {
		const c = buildStatusCard('s', 'o', live({ gameServerId: '', startedAt: null }))!;
		expect(c.joinCode).toBe('');
		expect(c.startedAt).toBeNull();
	});
});

describe('statusCardKey', () => {
	it('moves when a figure moves and stands still otherwise', () => {
		const before = statusCardKey(card());
		expect(statusCardKey(card())).toBe(before);
		const scored = status({
			scores: [
				{ name: 'Manticore', colorHex: '#1DD65C', score: 75 },
				{ name: 'Lonestar', colorHex: '#4CB1EF', score: 61 }
			]
		});
		expect(
			statusCardKey(buildStatusCard('ZARUBA #1', 'Zaruba', live({ status: scored }))!)
		).not.toBe(before);
	});

	it('ignores the clock, so a look that changed nothing costs no render', () => {
		const later = live({ observedAt: '2026-09-20T17:05:00.000Z' });
		expect(statusCardKey(buildStatusCard('ZARUBA #1', 'Zaruba', later)!)).toBe(
			statusCardKey(card())
		);
	});
});

describe('statusPayload', () => {
	it('is a Components V2 container with neither content nor embeds', () => {
		const p = statusPayload(card(), { bannerUrl: null }) as Record<string, unknown>;
		expect(p.flags).toBe(COMPONENTS_V2);
		expect(p.content).toBeUndefined();
		expect(p.embeds).toBeUndefined();
		expect((p.components as Array<{ type: number }>)[0].type).toBe(17);
	});

	it('gives each picture a gallery of its own, or Discord tiles them into a grid', () => {
		const inner = (
			statusPayload(card(), { bannerUrl: null }).components as Array<{
				components: Array<{ type: number; items?: unknown[] }>;
			}>
		)[0].components;
		const galleries = inner.filter((c) => c.type === 12);
		expect(galleries).toHaveLength(3);
		expect(galleries.every((g) => g.items?.length === 1)).toBe(true);
		expect(inner.slice(0, 3).every((c) => c.type === 12)).toBe(true);
	});

	it('names the banner as an upload until it has a url to be carried by', () => {
		const items = (bannerUrl: string | null) =>
			(
				(
					statusPayload(card(), { bannerUrl }).components as Array<{
						components: Array<{ items?: Array<{ media: { url: string } }> }>;
					}>
				)[0].components[0].items ?? []
			).map((i) => i.media.url);
		expect(items(null)[0]).toBe('attachment://banner.webp');
		expect(items('https://cdn.discordapp.com/x/banner.webp')[0]).toBe(
			'https://cdn.discordapp.com/x/banner.webp'
		);
	});

	it('drops the join-code block on a build that serves no code', () => {
		const no = buildStatusCard('s', 'o', live({ gameServerId: '' }))!;
		const texts = (c: ReturnType<typeof statusPayload>) =>
			(
				c.components as Array<{ components: Array<{ type: number; content?: string }> }>
			)[0].components
				.filter((x) => x.type === 10)
				.map((x) => x.content ?? '');
		expect(texts(statusPayload(card(), { bannerUrl: null })).join()).toContain('Код входа');
		expect(texts(statusPayload(no, { bannerUrl: null })).join()).not.toContain('Код входа');
	});

	it('leaves both clocks to Discord', () => {
		const p = statusPayload(card(), { bannerUrl: null });
		const text = JSON.stringify(p);
		expect(text).toContain(`<t:${card().startedAt}:R>`);
		expect(text).toContain(`<t:${card().observedAt}:R>`);
	});
});

describe('statusFiles', () => {
	const pics = {
		scores: new Uint8Array([1]) as Uint8Array<ArrayBuffer>,
		top: new Uint8Array([2]) as Uint8Array<ArrayBuffer>
	};

	it('uploads the banner only when there is no url for it', () => {
		const withBanner = statusFiles(pics, new Uint8Array([3]) as Uint8Array<ArrayBuffer>);
		expect(withBanner.files.map((f) => f.name)).toEqual(['banner.webp', 'scores.png', 'top.png']);
		expect(statusFiles(pics, null).files.map((f) => f.name)).toEqual(['scores.png', 'top.png']);
	});

	it('numbers the attachments in the order the files go up', () => {
		expect(statusFiles(pics, null).attachments).toEqual([
			{ id: 0, filename: 'scores.png' },
			{ id: 1, filename: 'top.png' }
		]);
	});
});

describe('bannerUrlOf', () => {
	it('reads the gallery url back out, and shrugs at anything else', () => {
		const msg = {
			components: [
				{ type: 17, components: [{ type: 12, items: [{ media: { url: 'https://cdn/x.webp' } }] }] }
			]
		};
		expect(bannerUrlOf(msg)).toBe('https://cdn/x.webp');
		expect(bannerUrlOf({})).toBeNull();
		expect(bannerUrlOf(null)).toBeNull();
	});
});

describe('statusVals', () => {
	it('formats the way the design asks and says "без стороны" for a player without one', () => {
		const v = statusVals(
			buildStatusCard('s', 'o', live({ players: [player({ name: 'x', faction: null })] }))!
		) as {
			modeLine: string;
			scoresFoot: string;
			rows: Array<{ faction: string; topClass: string }>;
		};
		expect(v.modeLine).toBe('King of the Hill · 78/98');
		expect(v.scoresFoot).toBe('до 100 очков · DayLateGray · Ozeti River Circle');
		expect(v.rows[0].faction).toBe('без стороны');
		expect(v.rows[0].topClass).toBe('top');
	});

	it('cuts a name long enough to break the column', () => {
		const long = player({ name: 'ЯОченьДлинноеИмяКотороеНеВлезает' });
		const v = statusVals(buildStatusCard('s', 'o', live({ players: [long] }))!) as {
			rows: Array<{ name: string }>;
		};
		expect(v.rows[0].name).toBe('ЯОченьДлинноеИмяКоторо…');
	});
});
