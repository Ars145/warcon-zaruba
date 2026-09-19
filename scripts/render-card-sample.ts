// Renders the match result card from made-up data, for looking at it.
//
//   CHROMIUM_PATH=/usr/bin/chromium bun run scripts/render-card-sample.ts [out.png]
//
// The names are deliberately awkward: Cyrillic, CJK, Greek and dingbats all appear in the real
// scoreboard (6% of the names seen in a week), and they are what catches a missing font.
import { writeFileSync } from 'node:fs';
import type { MatchResultCard } from '../src/lib/server/match-card/data';
import { closeCardBrowser, renderMatchCard } from '../src/lib/server/match-card/render';

const players: Array<[string, string, number, number, number, boolean]> = [
	['kig07', 'Manticore', 49, 5, 248000, false],
	["Cap Li'Mochi", 'Manticore', 18, 3, 211500, false],
	['高渐离', 'Lonestar', 15, 0, 199000, true],
	['[ViVA] Zel3', 'Lonestar', 15, 3, 186400, false],
	['ΜΣ$†ΛΜΝ ΣΚΣΠØΝΛ† ♡', 'Valkyra', 13, 4, 172000, false],
	['Кинзару', 'Lonestar', 11, 4, 164800, false],
	['『 sus 』', 'Valkyra', 11, 5, 150300, true],
	['muuK', 'Lonestar', 11, 6, 142100, false],
	['онрё [怨霊]', 'Manticore', 10, 5, 128700, false],
	['Sm1leStyle', 'Valkyra', 10, 6, 119400, false],
	['Шкипер TTV', null as unknown as string, 7, 3, 112600, false],
	['ФРЭНК', 'Lonestar', 7, 10, 108300, false]
];

const scoreboard = players.map(([name, faction, kills, deaths, cash, newcomer], i) => ({
	rank: i + 1,
	steamId: String(76561198000000000 + i),
	name,
	faction,
	kills,
	deaths,
	kd: deaths === 0 ? kills : Math.round((kills / deaths) * 100) / 100,
	cash,
	newcomer
}));

const card: MatchResultCard = {
	endedAt: new Date('2026-09-19T20:09:50Z').toISOString(),
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
	factions: [
		{ name: 'Manticore', colorHex: '#1DD65C', score: 100, players: 34, winner: true },
		{ name: 'Valkyra', colorHex: '#FA503E', score: 71, players: 33, winner: false },
		{ name: 'Lonestar', colorHex: '#4CB1EF', score: 37, players: 33, winner: false }
	],
	winner: 'Manticore',
	scoreboard,
	awards: {
		topKills: { ...scoreboard[0] },
		topCash: { ...scoreboard[0] },
		topKd: { ...scoreboard[3] }
	}
};

const out = process.argv[2] || 'match-card-sample.png';
const png = await renderMatchCard(card);
writeFileSync(out, png);
await closeCardBrowser();
console.log(`${out}: ${png.length} bytes`);
