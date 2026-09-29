// In-memory sliding-window limits, per process: requests per user or per address on endpoints that
// cost something (the connectivity test, raw actions, Steam lookups, sign-in), and the players a
// game server is whispered in groups (kept in the worker, where actions run). With several web
// replicas a per-user limit is that many times higher, which is still enough to stop the panel
// being used as a fast scanner.
import { ApiError } from './http';
import { rateLimited } from './metrics';

const windows = new Map<string, number[]>();
let sweepAt = 0;

/** Throws 429 once `key` has been seen more than `limit` times inside the last `windowMs`. */
export function assertRate(key: string, limit: number, windowMs: number): void {
	const retryIn = takeRate(key, 1, limit, windowMs);
	if (retryIn)
		throw new ApiError(
			429,
			`Too many requests; try again in ${retryIn} second${retryIn === 1 ? '' : 's'}.`,
			'rate_limited'
		);
}

/**
 * Takes `count` of the `limit` that `key` may have inside the last `windowMs`, all of them or
 * none. Answers 0 when taken, else the seconds until they would fit.
 */
export function takeRate(key: string, count: number, limit: number, windowMs: number): number {
	const now = Date.now();
	if (sweepAt <= now) {
		for (const [k, stamps] of windows)
			if (stamps[stamps.length - 1] <= now - windowMs) windows.delete(k);
		sweepAt = now + windowMs;
	}
	const stamps = (windows.get(key) ?? []).filter((t) => t > now - windowMs);
	if (stamps.length + count > limit) {
		// Room for `count` comes when this stamp leaves the window (a whole window when `count` alone is over).
		const frees = stamps[stamps.length + count - limit - 1] ?? now;
		windows.set(key, stamps);
		rateLimited.inc({ scope: key.slice(0, key.indexOf(':') > 0 ? key.indexOf(':') : undefined) });
		return Math.max(1, Math.ceil((frees + windowMs - now) / 1000));
	}
	for (let i = 0; i < count; i++) stamps.push(now);
	windows.set(key, stamps);
	return 0;
}

/** Gives back the newest `count` that `takeRate` took for `key`, for work that never happened. */
export function giveRate(key: string, count: number): void {
	const stamps = windows.get(key);
	if (stamps && count > 0) stamps.splice(Math.max(0, stamps.length - count));
}

/** Test-only: forget every window. */
export function resetRates(): void {
	windows.clear();
	sweepAt = 0;
}
