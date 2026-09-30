import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from './http';
import { assertRate, giveRate, resetRates, takeRate } from './ratelimit';

describe('assertRate', () => {
	beforeEach(resetRates);

	test('allows up to the limit, then answers 429 with a retry hint', () => {
		for (let i = 0; i < 3; i++) assertRate('test:u1', 3, 60_000);
		let caught: unknown;
		try {
			assertRate('test:u1', 3, 60_000);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ApiError);
		expect((caught as ApiError).status).toBe(429);
		expect((caught as ApiError).code).toBe('rate_limited');
		expect((caught as ApiError).message).toMatch(/try again in \d+ seconds?/);
	});

	test('keys are independent', () => {
		for (let i = 0; i < 3; i++) assertRate('test:u1', 3, 60_000);
		expect(() => assertRate('test:u2', 3, 60_000)).not.toThrow();
		expect(() => assertRate('raw:u1', 3, 60_000)).not.toThrow();
	});

	test('old stamps fall out of the window', () => {
		for (let i = 0; i < 3; i++) assertRate('k', 3, 1);
		const until = Date.now() + 3;
		while (Date.now() < until) {
			/* let the window pass */
		}
		expect(() => assertRate('k', 3, 1)).not.toThrow();
	});
});

describe('takeRate', () => {
	beforeEach(resetRates);

	test('takes a count all or none, and says when it would fit', () => {
		expect(takeRate('whisper:s1', 200, 300, 60_000)).toBe(0);
		expect(takeRate('whisper:s1', 101, 300, 60_000)).toBeGreaterThan(0);
		expect(takeRate('whisper:s1', 100, 300, 60_000)).toBe(0);
		const wait = takeRate('whisper:s1', 1, 300, 60_000);
		expect(wait).toBeGreaterThanOrEqual(59);
		expect(wait).toBeLessThanOrEqual(60);
		expect(takeRate('whisper:s2', 300, 300, 60_000)).toBe(0);
	});

	test('a count over the whole limit never fits and waits a window', () => {
		expect(takeRate('whisper:s3', 301, 300, 60_000)).toBe(60);
		expect(takeRate('whisper:s3', 300, 300, 60_000)).toBe(0);
	});

	test('what is given back can be taken again; giving back more than was taken empties the window', () => {
		expect(takeRate('whisper:s4', 300, 300, 60_000)).toBe(0);
		giveRate('whisper:s4', 120);
		expect(takeRate('whisper:s4', 121, 300, 60_000)).toBeGreaterThan(0);
		expect(takeRate('whisper:s4', 120, 300, 60_000)).toBe(0);
		giveRate('whisper:s4', 1000);
		expect(takeRate('whisper:s4', 300, 300, 60_000)).toBe(0);
		giveRate('whisper:nobody', 5);
		expect(takeRate('whisper:nobody', 300, 300, 60_000)).toBe(0);
	});
});
