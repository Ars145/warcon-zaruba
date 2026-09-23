// zaruba: couch reserve
// Pure logic over the wardogs_reserve document set: which personal/clan grants are active right
// now, and how to resolve a multi-master conflict CouchDB reports. No I/O in this file (see
// couch.ts for the HTTP client, reserve-store.ts for the org-list CRUD that uses both).
import type { Env } from './env';
import { couchConfig, deleteDoc, find, getRevs, putDoc, type CouchDoc } from './couch';

export interface PersonalDoc extends CouchDoc {
	type: 'personal';
	steamId: string;
	/** null = permanent */
	expiresAt: string | null;
	reason: string;
	addedBy: string;
	addedAt: string;
}

export interface ClanDoc extends CouchDoc {
	type: 'clan';
	clanId: string;
	clanTag: string;
	slots: number;
	expiresAt: string;
}

export interface ClanSlotDoc extends CouchDoc {
	type: 'clanslot';
	clanId: string;
	steamId: string;
	assignedBy: string;
	assignedAt: string;
}

export type ReserveDoc = PersonalDoc | ClanDoc | ClanSlotDoc;

export interface ActiveReserveEntry {
	steamId: string;
	/** null = permanent */
	expiresAt: string | null;
	source: 'personal' | 'clan';
	clanTag?: string;
}

const isActiveExpiry = (expiresAt: string | null, now: Date): boolean =>
	expiresAt === null || new Date(expiresAt).getTime() > now.getTime();

/** null beats any date (permanent outlives everything); otherwise the later date wins. */
function laterExpiry(a: string | null, b: string | null): string | null {
	if (a === null || b === null) return null;
	return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/**
 * The reserve list as it stands right now: expired personals and clanslots whose clan expired (or
 * is missing) are dropped here, not written back — expiry is a read-time filter, nothing is
 * deleted for it. One entry per steamId: a player who holds both a personal grant and an active
 * clan slot shows once, as 'personal' (it wins for display), with whichever expiry is later (null
 * if either is permanent).
 */
export function activeReserve(docs: ReserveDoc[], now: Date): ActiveReserveEntry[] {
	const clans = new Map(
		docs.filter((d): d is ClanDoc => d.type === 'clan').map((c) => [c.clanId, c])
	);

	const personalByPlayer = new Map<string, PersonalDoc>();
	for (const d of docs) {
		if (d.type !== 'personal') continue;
		if (!isActiveExpiry(d.expiresAt, now)) continue;
		personalByPlayer.set(d.steamId, d);
	}

	const clanByPlayer = new Map<string, ClanDoc>();
	for (const d of docs) {
		if (d.type !== 'clanslot') continue;
		const clan = clans.get(d.clanId);
		if (!clan || !isActiveExpiry(clan.expiresAt, now)) continue;
		const existing = clanByPlayer.get(d.steamId);
		if (!existing || new Date(clan.expiresAt).getTime() > new Date(existing.expiresAt).getTime())
			clanByPlayer.set(d.steamId, clan);
	}

	const steamIds = new Set([...personalByPlayer.keys(), ...clanByPlayer.keys()]);
	const out: ActiveReserveEntry[] = [];
	for (const steamId of steamIds) {
		const personal = personalByPlayer.get(steamId);
		const clan = clanByPlayer.get(steamId);
		if (personal && clan) {
			out.push({
				steamId,
				expiresAt: laterExpiry(personal.expiresAt, clan.expiresAt),
				source: 'personal'
			});
		} else if (personal) {
			out.push({ steamId, expiresAt: personal.expiresAt, source: 'personal' });
		} else if (clan) {
			out.push({ steamId, expiresAt: clan.expiresAt, source: 'clan', clanTag: clan.clanTag });
		}
	}
	return out;
}

// zaruba: couch reserve — desiredFor (lists-sync.ts) calls this once per server, and fanOut/syncOrg
// runs every one of an org's servers in parallel, so a naive implementation makes one CouchDB
// _find per server on every sync. A short TTL memo coalesces those into one call per org sync: the
// N concurrent callers within the window share the same in-flight promise. `now` is passed straight
// through to activeReserve on every call (its filtering, not the cache, is what "now" means), so a
// cached response computed a moment earlier for a slightly different `now` is fine — expiry is not
// time-critical to the second.
const RESERVE_CACHE_TTL_MS = 2000;
let reserveCache: { promise: Promise<ReserveDoc[]>; expiresAt: number } | null = null;

async function loadReserveDocs(env: Env): Promise<ReserveDoc[]> {
	const nowMs = Date.now();
	if (reserveCache && reserveCache.expiresAt > nowMs) return reserveCache.promise;
	const c = couchConfig(env);
	const promise = find<ReserveDoc>(c, { type: { $in: ['personal', 'clan', 'clanslot'] } });
	reserveCache = { promise, expiresAt: nowMs + RESERVE_CACHE_TTL_MS };
	// A failed fetch must not poison the cache for the TTL window: the next caller (in this same
	// sync, or the next one) should retry rather than reuse a rejected promise.
	promise.catch(() => {
		if (reserveCache?.promise === promise) reserveCache = null;
	});
	return promise;
}

/** Loads every personal/clan/clanslot doc and reduces it to the active list. */
export async function desiredReserve(env: Env, now = new Date()): Promise<ActiveReserveEntry[]> {
	const docs = await loadReserveDocs(env);
	return activeReserve(docs, now);
}

export interface RevDoc<T extends CouchDoc = CouchDoc> {
	rev: string;
	doc: T;
}

/**
 * The conflict rule (implemented only here in Warcon): among the given revisions of one doc, the
 * winner is whichever has expiresAt === null (permanent beats any date); failing that, the one
 * with the max expiresAt.
 */
export function pickWinner<T extends CouchDoc & { expiresAt?: string | null }>(
	revs: RevDoc<T>[]
): RevDoc<T> {
	if (!revs.length) throw new Error('pickWinner: no revisions given.');
	let winner = revs[0];
	for (const r of revs.slice(1)) {
		const a = winner.doc.expiresAt ?? null;
		const b = r.doc.expiresAt ?? null;
		if (a === null) continue; // current winner is already permanent; nothing beats it
		if (b === null || new Date(b).getTime() > new Date(a).getTime()) winner = r;
	}
	return winner;
}

/**
 * A doc read off `_changes` with `_conflicts`: resolves it by the rule above. The winner's body is
 * written onto the doc's current winning revision (CouchDB's own pick) only if it differs, and
 * every losing revision is deleted. No-op when there is nothing to resolve.
 */
export async function resolveConflict(
	env: Env,
	doc: CouchDoc & { expiresAt?: string | null; _conflicts?: string[] }
): Promise<void> {
	const conflicts = doc._conflicts;
	const rev = doc._rev;
	const id = doc._id;
	if (!conflicts?.length || !rev) return;
	const c = couchConfig(env);
	const revIds = [rev, ...conflicts];
	const fetched = await getRevs<CouchDoc & { expiresAt?: string | null }>(c, id, revIds);
	const revDocs: RevDoc[] = fetched.map((d) => ({ rev: d._rev!, doc: d }));
	if (!revDocs.length) return; // every revision already gone (raced with another resolver)
	const winner = pickWinner(revDocs);
	if (winner.rev !== rev) {
		const { _id: _unusedId, _rev: _unusedRev, ...body } = winner.doc;
		await putDoc(c, { _id: id, _rev: rev, ...body });
	}
	for (const conflictRev of conflicts) await deleteDoc(c, id, conflictRev);
}
