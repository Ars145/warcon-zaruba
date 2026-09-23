import { describe, expect, test } from 'bun:test';
import { makeCoalescer } from './wardogs-watch';

/** A promise plus its own resolve, so a test can control exactly when a run "finishes". */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe('makeCoalescer', () => {
	test('a single trigger runs once', async () => {
		const calls: string[] = [];
		const c = makeCoalescer<string>(
			async (item) => {
				calls.push(item);
			},
			(item) => item
		);
		c.trigger('a');
		await c.drain();
		expect(calls).toEqual(['a']);
	});

	test('triggering the same key while a run is in flight queues exactly one rerun, not one per trigger', async () => {
		const calls: string[] = [];
		const runs: ReturnType<typeof deferred>[] = [];
		const c = makeCoalescer<string>(
			async (item) => {
				calls.push(item);
				const d = deferred();
				runs.push(d);
				await d.promise;
			},
			(item) => item
		);

		c.trigger('a'); // starts run #1
		c.trigger('a'); // queues a rerun
		c.trigger('a'); // already queued: no-op
		c.trigger('a'); // still no-op
		expect(calls).toEqual(['a']); // only the first run has started

		runs[0].resolve(); // finish run #1; the queued rerun should start
		await Promise.resolve(); // let the .then() chain schedule run #2
		await Promise.resolve();
		expect(calls).toEqual(['a', 'a']);

		runs[1].resolve();
		await c.drain();
		expect(calls).toEqual(['a', 'a']); // no further reruns were queued
	});

	test('different keys run independently, concurrently', async () => {
		const calls: string[] = [];
		const c = makeCoalescer<string>(
			async (item) => {
				calls.push(item);
			},
			(item) => item
		);
		c.trigger('a');
		c.trigger('b');
		await c.drain();
		expect(calls.sort()).toEqual(['a', 'b']);
	});

	test('a run that throws is swallowed by the caller-supplied run(), not the coalescer', async () => {
		const c = makeCoalescer<string>(
			async () => {
				throw new Error('boom');
			},
			(item) => item
		);
		// makeCoalescer itself never catches: a `run` that rejects would leave the in-flight
		// promise rejected. Callers (like wardogs-watch's syncCoalescer) are expected to catch
		// inside their own `run`, which this test's run deliberately does not, to document that.
		c.trigger('a');
		await expect(c.drain()).rejects.toThrow('boom');
	});

	test('drain resolves immediately when nothing is in flight', async () => {
		const c = makeCoalescer<string>(
			async () => {},
			(item) => item
		);
		await expect(c.drain()).resolves.toBeUndefined();
	});
});
