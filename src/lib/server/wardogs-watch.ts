// zaruba: couch reserve
// Watches wardogs_reserve's _changes feed so the panel notices what the platform (and Berni,
// through the Warcon WebUI's own add/remove) wrote without waiting for the next scheduled list
// sync. Every batch: resolve any conflicted doc (the rule lives in wardogs-reserve.ts, this is the
// only place in Warcon that calls it), then push the org's lists to its servers, same as an admin
// edit does. Runs once per worker process; two workers racing the same feed is harmless (both
// resolveConflict and syncOrg are idempotent), and the last seq is persisted so a restart resumes
// instead of re-scanning.
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from './env';
import { changes, couchConfig, CouchConflict, type CouchChange } from './couch';
import { resolveConflict } from './wardogs-reserve';
import { couchState, lists, organizations, type OrgRow } from './db/schema';
import { gateway } from './gateway';

/** The remote/local CouchDB restarts; a failed poll is retried after this rather than given up on. */
const RETRY_MS = 5000;
const SEQ_KEY = 'reserve_seq';

let stopRequested = false;
let loopPromise: Promise<void> | null = null;

async function lastSeq(env: Env): Promise<string> {
	const [row] = await env.db.select().from(couchState).where(eq(couchState.key, SEQ_KEY)).limit(1);
	return row?.value ?? '0';
}

async function saveSeq(env: Env, seq: string): Promise<void> {
	await env.db
		.insert(couchState)
		.values({ key: SEQ_KEY, value: seq })
		.onConflictDoUpdate({ target: couchState.key, set: { value: seq } });
}

/**
 * COUCH_ORG_ID's own reserve list: only that org's reserve list lives in CouchDB (see
 * isCouchReserve in lists.ts), so it's the only one this watch needs to sync when the feed moves.
 */
async function reserveOrgs(env: Env): Promise<OrgRow[]> {
	const rows = await env.db
		.select({ org: organizations })
		.from(lists)
		.innerJoin(organizations, eq(organizations.id, lists.orgId))
		.where(
			and(eq(lists.kind, 'reserve'), isNull(lists.serverId), eq(lists.orgId, env.COUCH_ORG_ID))
		);
	const seen = new Set<string>();
	return rows.map((r) => r.org).filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
}

/**
 * Only a losing resolver's own CouchConflict (another resolver already won the same doc) is
 * swallowed here. Anything else propagates: the batch's outer try/catch (in loop, below) then
 * skips saveSeq, so the same `since` is retried instead of moving on with a doc left unresolved.
 */
async function resolveConflicts(env: Env, results: CouchChange[]): Promise<void> {
	for (const change of results) {
		if (!change.doc?._conflicts?.length) continue;
		try {
			await resolveConflict(env, change.doc);
		} catch (err) {
			if (err instanceof CouchConflict) {
				console.warn(`[warcon] couch reserve conflict on ${change.id} lost the race to another resolver`);
				continue;
			}
			throw err;
		}
	}
}

/**
 * Coalesces `trigger(item)` calls per key: a run already in flight for a key is left to finish,
 * and at most one more run is queued behind it (further triggers for that key while queued just
 * replace the queued item, they don't add another run). Generic and pure of any CouchDB/DB
 * dependency so it can be unit-tested on its own (see wardogs-watch.test.ts) — the reserve watch
 * below is the only caller, coalescing one syncOrg per org per batch instead of one per batch
 * regardless of how many orgs' syncs are still running.
 */
export function makeCoalescer<T>(run: (item: T) => Promise<void>, keyOf: (item: T) => string) {
	const inFlight = new Map<string, Promise<void>>();
	const pendingRerun = new Map<string, T>();

	function afterRun(key: string): void {
		inFlight.delete(key);
		const queued = pendingRerun.get(key);
		if (queued !== undefined) {
			pendingRerun.delete(key);
			go(queued);
		}
	}

	// Cleanup (afterRun) runs on either outcome, so a run() that rejects doesn't leave its key
	// stuck in `inFlight` forever (which would silently turn every later trigger for that key into
	// a no-op queue-and-drop). The rejection itself still propagates to `drain`'s Promise.all.
	function go(item: T): void {
		const key = keyOf(item);
		const p = run(item).then(
			() => afterRun(key),
			(err) => {
				afterRun(key);
				throw err;
			}
		);
		inFlight.set(key, p);
	}

	function trigger(item: T): void {
		const key = keyOf(item);
		if (inFlight.has(key)) {
			pendingRerun.set(key, item);
			return;
		}
		go(item);
	}

	/** Awaits every in-flight run, including any coalesced rerun it queues behind itself. */
	async function drain(): Promise<void> {
		while (inFlight.size) await Promise.all([...inFlight.values()]);
	}

	return { trigger, drain };
}

// zaruba: couch reserve — run() swallows its own error (logged) so one org's failed sync never
// stops the coalescer from processing the others or queuing that org's next run.
const syncCoalescer = makeCoalescer<{ env: Env; org: OrgRow }>(
	({ env, org }) =>
		gateway()
			.syncOrg(env, org)
			.then(() => undefined)
			.catch((err) => console.error(`[warcon] couch reserve sync ${org.name}`, err)),
	({ org }) => org.id
);

async function loop(env: Env): Promise<void> {
	const c = couchConfig(env);
	let since = await lastSeq(env);
	while (!stopRequested) {
		try {
			const batch = await changes(c, since);
			if (stopRequested) break;
			if (batch.results.length) {
				await resolveConflicts(env, batch.results);
				for (const org of await reserveOrgs(env)) syncCoalescer.trigger({ env, org });
			}
			// The cursor moves only after the batch is handled, so a crash replays it instead of
			// leaving its conflicts unresolved.
			await saveSeq(env, batch.last_seq);
			since = batch.last_seq;
		} catch (err) {
			console.error('[warcon] couch reserve watch', err);
			await new Promise((r) => setTimeout(r, RETRY_MS));
		}
	}
}

/** Starts the watch loop; a no-op if one is already running in this process. */
export function startReserveWatch(env: Env): void {
	if (loopPromise) return;
	stopRequested = false;
	loopPromise = loop(env).catch((err) => console.error('[warcon] couch reserve watch stopped', err));
}

/**
 * Signals the loop to stop after its current poll, then awaits it (and every in-flight syncOrg it
 * kicked off) before returning, so a caller that awaits this can rely on the watch being fully
 * quiesced — not just the loop's own while-condition having gone false.
 */
export async function stopReserveWatch(): Promise<void> {
	stopRequested = true;
	if (loopPromise) await loopPromise;
	loopPromise = null;
	await syncCoalescer.drain();
}
