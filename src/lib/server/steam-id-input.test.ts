import { expect, mock, test } from 'bun:test';

mock.module('$env/dynamic/private', () => ({ env: process.env }));
const { requireSteamId } = await import('./steam');
const { ACTIONS } = await import('./actions');

// What a bot's JSON body delivers when it writes the id as a number: the last digits are gone,
// and what is left is still 17 digits, another player's id.
const rounded = JSON.parse('{"steamId": 76561198100000101}').steamId as number;

test('a SteamID sent as a JSON number arrives as another id', () => {
	expect(String(rounded)).toBe('76561198100000100');
});

test('requireSteamId takes a string only', () => {
	expect(requireSteamId('76561198100000101')).toBe('76561198100000101');
	expect(requireSteamId(' 76561198100000101 ')).toBe('76561198100000101');
	expect(() => requireSteamId(rounded)).toThrow('must be sent as a string');
	expect(() => requireSteamId(null)).toThrow('17-digit SteamID64');
	expect(() => requireSteamId(['76561198100000101'])).toThrow('17-digit SteamID64');
});

test('no game action sends a SteamID that came as a number', async () => {
	const calls: string[] = [];
	const client: any = {
		json: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			return { message: 'ok', players: [] };
		}
	};
	for (const [action, extra] of [
		['kick', {}],
		['kill', {}],
		['ban', { reason: 'x' }],
		['unban', {}],
		['whisper', { message: 'hi' }],
		['changeTeam', { faction: 'Valkyra' }],
		['reservedAdd', {}],
		['reservedRemove', {}]
	] as const)
		// As the lane calls it: inside an async function, so a throw is a rejection.
		await expect(
			(async () => ACTIONS[action].run(client, { steamId: rounded, ...extra }))(),
			action
		).rejects.toMatchObject({ status: 400 });
	expect(calls).toEqual([]);
});
