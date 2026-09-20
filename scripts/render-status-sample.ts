// Renders the live status card's two pictures from made-up data, for looking at them.
//
//   CHROMIUM_PATH=/usr/bin/chromium bun run scripts/render-status-sample.ts
//
// The names are deliberately awkward for the same reason as the match card's sample: Cyrillic,
// CJK, Greek and dingbats all appear in the real scoreboard, and they catch a missing font.
import { writeFileSync } from 'node:fs';
import { closeCardBrowser } from '../src/lib/server/match-card/render';
import { renderStatusCard } from '../src/lib/server/status-card/render';
import type { StatusCard } from '../src/lib/server/status-card/data';

const card: StatusCard = {
	serverName: 'ZARUBA WARDOGS #1',
	orgName: 'Zaruba',
	mapId: 'Europe',
	mapName: 'Ozeti',
	mode: 'King of the Hill',
	lighting: 'DayLateGray',
	zone: 'Eastern',
	online: 78,
	maxPlayers: 98,
	reservedSlots: 2,
	scoreCap: 100,
	factions: [
		{ name: 'Manticore', colorHex: '#1DD65C', score: 74, pct: 74, leading: true },
		{ name: 'Lonestar', colorHex: '#4CB1EF', score: 61, pct: 61, leading: false },
		{ name: 'Valkyra', colorHex: '#E0B341', score: 48, pct: 48, leading: false }
	],
	rows: [
		['BR♡', 'Manticore', '#1DD65C', 31, 4, 12400],
		['Tomato', 'Lonestar', '#4CB1EF', 24, 6, 9850],
		['kig07', 'Valkyra', '#E0B341', 22, 9, 8100],
		['Шпротина', 'Manticore', '#1DD65C', 19, 11, 7300],
		['不知道这是什么名字', 'Valkyra', '#E0B341', 17, 8, 6950],
		['Hedgehog', 'Manticore', '#1DD65C', 14, 7, 5200],
		['✪ Мурзик ✪', 'Lonestar', '#4CB1EF', 12, 13, 4880],
		['ΑΘΗΝΑ', 'Valkyra', '#E0B341', 11, 5, 4100],
		['Dima_2007', 'Manticore', '#1DD65C', 9, 14, 3640],
		['Пельмень', null, 'rgba(255,255,255,.3)', 8, 6, 3210]
	].map(([name, faction, factionColor, kills, deaths, cash], i) => ({
		rank: i + 1,
		name: name as string,
		faction: faction as string | null,
		factionColor: factionColor as string,
		kills: kills as number,
		deaths: deaths as number,
		cash: cash as number
	})),
	playersTotal: 78,
	joinCode: '4f2a91c0',
	startedAt: Math.floor(Date.now() / 1000) - 32400,
	observedAt: Math.floor(Date.now() / 1000)
};

const { scores, top } = await renderStatusCard(card);
writeFileSync('status-scores.png', scores);
writeFileSync('status-top.png', top);
console.log(`status-scores.png: ${scores.length} bytes, status-top.png: ${top.length} bytes`);
await closeCardBrowser();
