import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { Env } from './env';
import { encryptSecret } from './crypto';
import { ApiError } from './http';
import { parseEndpointUrl, sendEvent, sharedCheck, signature, within } from './json-webhook-send';
import type { Resolved } from './hostpolicy';
import { covers } from './json-webhook-events';

const env = { ENCRYPTION_KEY: randomBytes(32).toString('base64') } as Env;
const SECRET = 'whsec_test';
const hookAt = (url: string, allowPrivate = false) => ({
	urlEnc: encryptSecret(env, url),
	secretEnc: encryptSecret(env, SECRET),
	allowPrivate
});

describe('parseEndpointUrl', () => {
	test('https only, with the path kept and only the host shown', () => {
		expect(parseEndpointUrl(' https://Members.Example.org/hooks/warcon?t=abc#x ')).toEqual({
			url: 'https://members.example.org/hooks/warcon?t=abc',
			host: 'members.example.org',
			port: 443,
			path: '/hooks/warcon?t=abc',
			hint: 'members.example.org/…'
		});
		expect(parseEndpointUrl('https://93.184.216.34:8443').hint).toBe('93.184.216.34:8443/…');
		expect(parseEndpointUrl('https://[2606:2800:220:1::1]/x').host).toBe('[2606:2800:220:1::1]');
	});

	test('refuses anything else', () => {
		for (const bad of [
			'',
			'members.example.org/hooks',
			'http://members.example.org/hooks',
			'ftp://members.example.org/',
			'https://user:pass@members.example.org/',
			'https://members.example.org:0/',
			`https://members.example.org/${'x'.repeat(500)}`,
			42
		])
			expect(() => parseEndpointUrl(bad)).toThrow(ApiError);
	});
});

describe('signature', () => {
	test('is HMAC-SHA256 of "<time>.<body>" under the secret, as the README tells receivers', () => {
		expect(signature(SECRET, '{"event":"ping","id":"ping-1"}', 1700000000)).toBe(
			't=1700000000,v1=d3d4bb0df2ce8e3baac8ffcd3f63993e6b66d1b52198eb9ce44d80e352da627e'
		);
	});
});

describe('within', () => {
	test('answers with the work, or gives up on it after the time', async () => {
		expect(await within(Promise.resolve(7), 50)).toBe(7);
		const started = Date.now();
		await expect(within(new Promise(() => {}), 50)).rejects.toBeDefined();
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe('sharedCheck', () => {
	test('one check per host while it runs, and none past the cap: a hung resolver cannot pile up', async () => {
		let started = 0;
		const release: (() => void)[] = [];
		// a resolver that answers only when the test lets it
		const hung = () => {
			started++;
			return new Promise<Resolved[]>((resolve) => release.push(() => resolve([])));
		};
		const first = sharedCheck('hung.example', false, hung);
		expect(sharedCheck('hung.example', false, hung)).toBe(first);
		expect(started).toBe(1);
		const others = Array.from({ length: 7 }, (_, i) =>
			sharedCheck(`hung${i}.example`, false, hung)
		);
		expect(started).toBe(8);
		await expect(sharedCheck('one-more.example', false, hung)).rejects.toBeDefined();
		expect(started).toBe(8);
		// once they answer, the room comes back
		for (const r of release) r();
		await Promise.all([first, ...others]);
		expect(await sharedCheck('one-more.example', false, async () => [])).toEqual([]);
		expect(started).toBe(8);
	});

	test('a finished check makes room again', async () => {
		const done = async () => [{ address: '93.184.216.34', kind: 'public' as const }];
		expect(await sharedCheck('93.184.216.34', false, done)).toEqual([
			{ address: '93.184.216.34', kind: 'public' }
		]);
	});
});

describe('covers', () => {
	const hook = (events: string[], serverIds: string[] | null) => ({ events, serverIds });
	test('the event must be ticked, and the server in scope', () => {
		expect(covers(hook(['seed_reward'], null), 'seed_reward', 's1')).toBe(true);
		expect(covers(hook(['seed_reward'], ['s1']), 'seed_reward', 's1')).toBe(true);
		expect(covers(hook(['seed_reward'], ['s2']), 'seed_reward', 's1')).toBe(false);
		expect(covers(hook([], null), 'seed_reward', 's1')).toBe(false);
	});

	test('an organisation-wide event reaches every webhook that ticks its kind', () => {
		expect(covers(hook(['seed_reward'], ['s2']), 'seed_reward', null)).toBe(true);
		expect(covers(hook(['seed_reward'], null), 'seed_reward', null)).toBe(true);
		expect(covers(hook([], null), 'seed_reward', null)).toBe(false);
	});
});

describe('sendEvent', () => {
	const realFetch = globalThis.fetch;
	let calls: { url: string; init: BunFetchRequestInit }[] = [];
	const answer = (make: () => Response | Promise<Response>) => {
		calls = [];
		globalThis.fetch = (async (url: string | URL, init?: BunFetchRequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return make();
		}) as typeof fetch;
	};
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const payload = JSON.stringify({ event: 'ping', id: 'ping-1', at: '2026-09-25T00:00:00.000Z' });

	test('posts the signed body to the address, and follows no redirect', async () => {
		answer(() => new Response('ignored', { status: 204 }));
		const r = await sendEvent(
			env,
			hookAt('https://93.184.216.34/hooks?t=abc'),
			'ping',
			'ping-1',
			payload
		);
		expect(r).toEqual({ ok: true, status: 204, error: '', retry: false });
		expect(calls).toHaveLength(1);
		const { url, init } = calls[0];
		expect(url).toBe('https://93.184.216.34:443/hooks?t=abc');
		expect(init.method).toBe('POST');
		expect(init.redirect).toBe('manual');
		expect(init.body).toBe(payload);
		const headers = init.headers as Record<string, string>;
		expect(headers['content-type']).toBe('application/json');
		expect(headers['x-warcon-event']).toBe('ping');
		expect(headers['x-warcon-delivery']).toBe('ping-1');
		const [, t] = /^t=(\d+),v1=[0-9a-f]{64}$/.exec(headers['x-warcon-signature'])!;
		expect(headers['x-warcon-signature']).toBe(signature(SECRET, init.body as string, Number(t)));
	});

	test('a hostname is pinned to the address the check approved, the name kept for Host and TLS', async () => {
		answer(() => new Response(null, { status: 200 }));
		const r = await sendEvent(
			env,
			hookAt('https://localhost:8443/in', true),
			'ping',
			'ping-1',
			payload
		);
		expect(r.ok).toBe(true);
		expect(calls[0].url).toMatch(/^https:\/\/(127\.0\.0\.1|\[::1\]):8443\/in$/);
		expect((calls[0].init.headers as Record<string, string>).host).toBe('localhost:8443');
		expect(calls[0].init.tls).toEqual({ serverName: 'localhost' });
	});

	test('a private or link-local address is refused before anything is sent', async () => {
		answer(() => new Response(null, { status: 200 }));
		for (const [url, allowPrivate] of [
			['https://10.0.0.5/in', false],
			['https://localhost/in', false],
			['https://169.254.169.254/latest/meta-data', false],
			['https://169.254.169.254/latest/meta-data', true],
			['https://[fe80::1]/in', true]
		] as const) {
			const r = await sendEvent(env, hookAt(url, allowPrivate), 'ping', 'ping-1', payload);
			expect(r).toEqual({
				ok: false,
				status: null,
				error: 'The address is not one Warcon may send to.',
				retry: false
			});
		}
		expect(calls).toHaveLength(0);
	});

	test('what comes back decides whether it is sent again, in fixed words', async () => {
		const hook = hookAt('https://93.184.216.34/hooks/SECRET-TOKEN');
		const cases: [number, boolean][] = [
			[301, false],
			[404, false],
			[410, false],
			[429, true],
			[500, true],
			[503, true]
		];
		for (const [status, retry] of cases) {
			answer(() => new Response('body is never read', { status }));
			const r = await sendEvent(env, hook, 'ping', 'ping-1', payload);
			expect(r.ok).toBe(false);
			expect(r.status).toBe(status);
			expect(r.retry).toBe(retry);
			expect(r.error).not.toContain('93.184.216.34');
			expect(r.error).not.toContain('SECRET-TOKEN');
		}
	});

	test('no answer is worth another try, and the runtime text is never passed on', async () => {
		answer(() => {
			const err = new Error('fetch failed for https://93.184.216.34/hooks/SECRET-TOKEN');
			(err as Error & { code: string }).code = 'ECONNRESET';
			throw err;
		});
		const r = await sendEvent(
			env,
			hookAt('https://93.184.216.34/hooks/SECRET-TOKEN'),
			'ping',
			'ping-1',
			payload
		);
		expect(r).toEqual({
			ok: false,
			status: null,
			error: 'Could not deliver (the connection was closed).',
			retry: true
		});
		answer(() => {
			const err = new Error('timed out');
			err.name = 'TimeoutError';
			throw err;
		});
		const late = await sendEvent(env, hookAt('https://93.184.216.34/x'), 'ping', 'ping-1', payload);
		expect(late).toEqual({
			ok: false,
			status: null,
			error: 'Could not deliver (no answer in time).',
			retry: true
		});
	});

	test('a saved address that cannot be read is not sent anywhere', async () => {
		answer(() => new Response(null, { status: 200 }));
		const r = await sendEvent(
			env,
			{ urlEnc: 'v1.bad.bad', secretEnc: encryptSecret(env, SECRET), allowPrivate: false },
			'ping',
			'ping-1',
			payload
		);
		expect(r.ok).toBe(false);
		expect(r.retry).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
