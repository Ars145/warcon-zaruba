// zaruba: couch reserve
// Minimal CouchDB client (basic auth) for the wardogs_reserve database. Every call talks straight
// to CouchDB's HTTP API; there is no ORM here on purpose, the schema is the shared contract in
// docs/zaruba-couch-reserve.md and the Python services that write personal:/clan:/clanslot: docs.
import { couchEnvProblem } from './env';

export interface CouchConfig {
	url: string;
	db: string;
	user: string;
	password: string;
}

export interface CouchEnvLike {
	COUCH_URL?: string;
	COUCH_DB?: string;
	COUCH_USER?: string;
	COUCH_PASSWORD?: string;
}

/**
 * Builds the client config from Env (or, at migrate time, straight from process.env — see
 * scripts/migrate-reserve-to-couch.ts, which never calls initEnv). Throws if any of the four is
 * missing: no silent fallback.
 */
export function couchConfig(env: CouchEnvLike): CouchConfig {
	const problem = couchEnvProblem(env);
	if (problem) throw new Error(problem);
	return {
		url: env.COUCH_URL!,
		db: env.COUCH_DB!,
		user: env.COUCH_USER!,
		password: env.COUCH_PASSWORD!
	};
}

/** Thrown by putDoc on a 409: the caller passed a stale (or absent) _rev. */
export class CouchConflict extends Error {
	constructor(public id: string) {
		super(`CouchDB conflict writing ${id}.`);
	}
}

export interface CouchDoc {
	_id: string;
	_rev?: string;
	[key: string]: unknown;
}

const authHeader = (c: CouchConfig) =>
	'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64');
const serverUrl = (c: CouchConfig) => c.url.replace(/\/+$/, '');
const dbUrl = (c: CouchConfig) => `${serverUrl(c)}/${c.db}`;

async function dbFetch(c: CouchConfig, path: string, init: RequestInit = {}): Promise<Response> {
	const headers: Record<string, string> = { authorization: authHeader(c) };
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return fetch(`${dbUrl(c)}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
}

async function failIfNotOk(res: Response, what: string): Promise<never> {
	throw new Error(`CouchDB ${what} failed: ${res.status} ${await res.text()}`);
}

/** null on 404; throws on any other non-2xx. */
export async function getDoc<T extends CouchDoc = CouchDoc>(c: CouchConfig, id: string): Promise<T | null> {
	const res = await dbFetch(c, `/${encodeURIComponent(id)}`);
	if (res.status === 404) return null;
	if (!res.ok) return failIfNotOk(res, `GET ${id}`);
	return (await res.json()) as T;
}

/** Creates or updates a doc (include _rev on an update). Throws CouchConflict on 409. */
export async function putDoc<T extends CouchDoc>(c: CouchConfig, doc: T): Promise<T & { _rev: string }> {
	const res = await dbFetch(c, `/${encodeURIComponent(doc._id)}`, {
		method: 'PUT',
		body: JSON.stringify(doc)
	});
	if (res.status === 409) throw new CouchConflict(doc._id);
	if (!res.ok) return failIfNotOk(res, `PUT ${doc._id}`);
	const body = (await res.json()) as { rev: string };
	return { ...doc, _rev: body.rev };
}

/** A DELETE that already found nothing (404) is treated as success: the doc is gone either way. */
export async function deleteDoc(c: CouchConfig, id: string, rev: string): Promise<void> {
	const res = await dbFetch(c, `/${encodeURIComponent(id)}?rev=${encodeURIComponent(rev)}`, {
		method: 'DELETE'
	});
	if (res.status === 404) return;
	if (!res.ok) return failIfNotOk(res, `DELETE ${id}`);
}

/** Mango query. `limit` is fixed high (the reserve list is a few thousand docs, never paged). */
export async function find<T extends CouchDoc = CouchDoc>(
	c: CouchConfig,
	selector: Record<string, unknown>,
	fields?: string[]
): Promise<T[]> {
	const res = await dbFetch(c, '/_find', {
		method: 'POST',
		body: JSON.stringify({ selector, ...(fields ? { fields } : {}), limit: 100_000 })
	});
	if (!res.ok) return failIfNotOk(res, '_find');
	const body = (await res.json()) as { docs: T[]; warning?: string };
	if (body.warning) console.warn(`[warcon] CouchDB _find warning: ${body.warning}`);
	return body.docs;
}

/** Every revision listed, in the given order; a revision CouchDB no longer has is silently absent. */
export async function getRevs<T extends CouchDoc = CouchDoc>(
	c: CouchConfig,
	id: string,
	revs: string[]
): Promise<T[]> {
	const res = await dbFetch(
		c,
		`/${encodeURIComponent(id)}?open_revs=${encodeURIComponent(JSON.stringify(revs))}&latest=false`
	);
	if (!res.ok) return failIfNotOk(res, `open_revs ${id}`);
	const body = (await res.json()) as { ok?: T }[];
	return body.filter((r): r is { ok: T } => !!r.ok).map((r) => r.ok);
}

export interface CouchChange {
	seq: string;
	id: string;
	deleted?: boolean;
	changes: { rev: string }[];
	doc?: CouchDoc & { _conflicts?: string[] };
}

/** Long-polls `_changes` from `since`; resolves with whatever arrived (possibly empty) after up to 60s. */
export async function changes(
	c: CouchConfig,
	since: string
): Promise<{ results: CouchChange[]; last_seq: string }> {
	const res = await dbFetch(
		c,
		`/_changes?feed=longpoll&conflicts=true&include_docs=true&timeout=60000&since=${encodeURIComponent(since)}`
	);
	if (!res.ok) return failIfNotOk(res, '_changes');
	return (await res.json()) as { results: CouchChange[]; last_seq: string };
}

/** Idempotent: 201 (created) and 412 (already exists) both count as success. */
export async function ensureDatabase(c: CouchConfig): Promise<void> {
	const res = await fetch(`${serverUrl(c)}/${c.db}`, {
		method: 'PUT',
		headers: { authorization: authHeader(c) }
	});
	if (res.status !== 201 && res.status !== 412) return failIfNotOk(res, `PUT /${c.db}`);
}

/** Idempotent: creating the same named index twice is a no-op on CouchDB's side. */
export async function ensureIndex(c: CouchConfig, fields: string[], name: string): Promise<void> {
	const res = await dbFetch(c, '/_index', {
		method: 'POST',
		body: JSON.stringify({ index: { fields }, name })
	});
	if (!res.ok) return failIfNotOk(res, `_index ${name}`);
}
