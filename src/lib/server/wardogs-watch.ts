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
import { changes, couchConfig, type CouchChange } from './couch';
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

/** Every org whose reserve list lives in CouchDB: in practice, every org (ensureOrgLists gives each one). */
async function reserveOrgs(env: Env): Promise<OrgRow[]> {
	const rows = await env.db
		.select({ org: organizations })
		.from(lists)
		.innerJoin(organizations, eq(organizations.id, lists.orgId))
		.where(and(eq(lists.kind, 'reserve'), isNull(lists.serverId)));
	const seen = new Set<string>();
	return rows.map((r) => r.org).filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
}

async function resolveConflicts(env: Env, results: CouchChange[]): Promise<void> {
	for (const change of results) {
		if (!change.doc?._conflicts?.length) continue;
		try {
			await resolveConflict(env, change.doc);
		} catch (err) {
			console.error(`[warcon] couch reserve conflict on ${change.id}`, err);
		}
	}
}

async function loop(env: Env): Promise<void> {
	const c = couchConfig(env);
	let since = await lastSeq(env);
	while (!stopRequested) {
		try {
			const batch = await changes(c, since);
			if (stopRequested) break;
			if (batch.results.length) {
				await resolveConflicts(env, batch.results);
				for (const org of await reserveOrgs(env))
					gateway()
						.syncOrg(env, org)
						.catch((err) => console.error(`[warcon] couch reserve sync ${org.name}`, err));
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

/** Signals the loop to stop after its current poll; does not await the in-flight _changes call. */
export function stopReserveWatch(): void {
	stopRequested = true;
	loopPromise = null;
}
