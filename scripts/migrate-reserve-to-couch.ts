// zaruba: couch reserve
// One-time (but idempotent) backfill: every active entry (removedAt null, not expired) of every
// org's reserve list in Postgres becomes a personal:{steamId} doc in CouchDB, unless one already
// exists there. Postgres rows are left exactly as they are — this only ever adds docs to CouchDB.
// Also ensures the wardogs_reserve database and its indexes exist (idempotent: 201/412 on create).
//
//   bun run scripts/migrate-reserve-to-couch.ts
//
// Runs automatically as part of the migrate container / `bun run db:migrate` too — see the seam in
// src/worker/migrate.ts, which calls migrateReserveToCouch after the Postgres migrations apply.
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { connect, type Db } from '../src/lib/server/db';
import { couchState, listEntries, lists } from '../src/lib/server/db/schema';
import {
	couchConfig,
	ensureDatabase,
	ensureIndex,
	ensureReplicationUser,
	ensureValidateDesignDoc,
	getDoc,
	putDoc,
	setSecurity,
	type CouchEnvLike
} from '../src/lib/server/couch';
import type { PersonalDoc } from '../src/lib/server/wardogs-reserve';

// zaruba: couch reserve — replication trust. The platform (and anything else replicating
// wardogs_reserve) authenticates as this dedicated non-admin user, never the admin credentials
// Warcon itself connects with; `_security.members` on the db is set to exactly this one user.
// `validate_doc_update` then bounds what even that user (or anyone else with these credentials)
// can write: only the three known doc shapes, and only deletions of docs of those three kinds.
// Server admins bypass both `_security` and `validate_doc_update` (CouchDB's own rule, not
// something enforced here), so this only ever constrains a non-admin writer — but the function
// still accepts the fork's own admin-written shapes (personal:/clan:/clanslot:) unconditionally,
// so nothing here would reject Warcon's own writes if it were ever run as a non-admin.
const VALIDATE_DOC_UPDATE = `function (newDoc, oldDoc, userCtx) {
  if (newDoc._deleted === true) {
    if (/^(personal:|clan:|clanslot:)/.test(newDoc._id)) return;
    throw({forbidden: 'Only personal:, clan: and clanslot: docs may be deleted.'});
  }
  if (newDoc._id.indexOf('_design/') === 0) {
    throw({forbidden: 'Design docs may not be written through this validator.'});
  }
  var steamIdRe = /^\\d{17}$/;
  if (newDoc._id.indexOf('personal:') === 0) {
    var steamId = newDoc._id.slice('personal:'.length);
    if (newDoc.type !== 'personal') throw({forbidden: 'personal: doc must have type "personal".'});
    if (!steamIdRe.test(newDoc.steamId) || newDoc.steamId !== steamId)
      throw({forbidden: 'personal: doc steamId must be a 17-digit SteamID64 matching the doc id.'});
    if (newDoc.expiresAt !== null && typeof newDoc.expiresAt !== 'string')
      throw({forbidden: 'personal: doc expiresAt must be null or an ISO string.'});
    if (typeof newDoc.reason !== 'string')
      throw({forbidden: 'personal: doc reason must be a string.'});
    return;
  }
  if (newDoc._id.indexOf('clanslot:') === 0) {
    var parts = newDoc._id.split(':');
    if (parts.length !== 3) throw({forbidden: 'clanslot: doc id must be clanslot:{clanId}:{steamId}.'});
    var slotClanId = parts[1];
    var slotSteamId = parts[2];
    if (newDoc.type !== 'clanslot') throw({forbidden: 'clanslot: doc must have type "clanslot".'});
    if (newDoc.clanId !== slotClanId) throw({forbidden: 'clanslot: doc clanId must match the doc id.'});
    if (!steamIdRe.test(newDoc.steamId) || newDoc.steamId !== slotSteamId)
      throw({forbidden: 'clanslot: doc steamId must be a 17-digit SteamID64 matching the doc id.'});
    return;
  }
  if (newDoc._id.indexOf('clan:') === 0) {
    var clanId = newDoc._id.slice('clan:'.length);
    if (newDoc.type !== 'clan') throw({forbidden: 'clan: doc must have type "clan".'});
    if (newDoc.clanId !== clanId) throw({forbidden: 'clan: doc clanId must match the doc id.'});
    if (typeof newDoc.clanTag !== 'string') throw({forbidden: 'clan: doc clanTag must be a string.'});
    if (typeof newDoc.slots !== 'number') throw({forbidden: 'clan: doc slots must be a number.'});
    if (typeof newDoc.expiresAt !== 'string') throw({forbidden: 'clan: doc expiresAt must be an ISO string.'});
    return;
  }
  throw({forbidden: 'Only personal:, clan: and clanslot: docs may be written.'});
}`;

// zaruba: couch reserve — one-time backfill marker (couch_state key). Without it, running the
// migrate container again after an admin deleted a personal: doc straight in CouchDB would
// recreate that doc from the Postgres row, resurrecting a grant the admin just removed. The
// backfill's job is only to seed CouchDB the first time the couch reserve list goes live; once
// that has happened, CouchDB (not Postgres) is the source of truth and this must not run again.
const BACKFILL_KEY = 'reserve_backfilled';

function databaseTarget(): string | Bun.SQL.PostgresOrMySQLOptions {
	const url = process.env.DATABASE_URL;
	if (url) return url;
	if (process.env.PGHOST && process.env.PGPASSWORD !== undefined)
		return {
			hostname: process.env.PGHOST,
			port: Number(process.env.PGPORT) || 5432,
			username: process.env.PGUSER || 'warcon',
			password: process.env.PGPASSWORD,
			database: process.env.PGDATABASE || 'warcon'
		};
	throw new Error('Set DATABASE_URL, or PGHOST and PGPASSWORD.');
}

/** Every active entry of COUCH_ORG_ID's own reserve list (server_id null), Postgres-side. */
async function activeOrgReserveEntries(db: Db, orgId: string) {
	const now = new Date();
	return db
		.select({
			steamId: listEntries.steamId,
			reason: listEntries.reason,
			expiresAt: listEntries.expiresAt,
			addedAt: listEntries.addedAt,
			addedBy: listEntries.addedBy
		})
		.from(listEntries)
		.innerJoin(lists, eq(lists.id, listEntries.listId))
		.where(
			and(
				eq(lists.kind, 'reserve'),
				isNull(lists.serverId),
				eq(lists.orgId, orgId),
				isNull(listEntries.removedAt),
				or(isNull(listEntries.expiresAt), gt(listEntries.expiresAt, now))
			)
		);
}

/**
 * Idempotent within one run (existing docs are skipped), and a no-op on every run after the first
 * successful one (see BACKFILL_KEY above) — creates `personal:{steamId}` in CouchDB for every
 * active entry of orgId's own reserve list that isn't there yet.
 */
export async function migrateReserveToCouch(
	db: Db,
	couchEnv: CouchEnvLike,
	orgId: string,
	repl: { user: string; password: string }
): Promise<{ created: number; skipped: number; alreadyDone: boolean }> {
	const c = couchConfig(couchEnv);
	await ensureDatabase(c);
	await ensureIndex(c, ['type', 'steamId'], 'type-steamId', 'wardogs');
	await ensureIndex(c, ['type', 'clanId'], 'type-clanId', 'wardogs');
	// zaruba: couch reserve — replication trust, re-asserted on every migrate run (not gated on the
	// one-time backfill marker below): the dedicated non-admin replication user, this db's
	// _security locked to exactly that user, and the validate_doc_update ddoc bounding what it (or
	// anyone else with those credentials) can write. See docs/zaruba-couch-reserve.md.
	await ensureReplicationUser(c, repl.user, repl.password);
	await setSecurity(c, [repl.user]);
	await ensureValidateDesignDoc(c, VALIDATE_DOC_UPDATE);

	const [marker] = await db
		.select()
		.from(couchState)
		.where(eq(couchState.key, BACKFILL_KEY))
		.limit(1);
	if (marker) return { created: 0, skipped: 0, alreadyDone: true };

	const rows = await activeOrgReserveEntries(db, orgId);
	let created = 0;
	let skipped = 0;
	for (const r of rows) {
		const id = `personal:${r.steamId}`;
		const existing = await getDoc(c, id);
		if (existing) {
			skipped++;
			continue;
		}
		const doc: PersonalDoc = {
			_id: id,
			type: 'personal',
			steamId: r.steamId,
			expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
			reason: r.reason,
			addedBy: r.addedBy ?? '',
			addedAt: r.addedAt.toISOString()
		};
		await putDoc(c, doc);
		created++;
	}
	await db
		.insert(couchState)
		.values({ key: BACKFILL_KEY, value: new Date().toISOString() })
		.onConflictDoNothing({ target: couchState.key });
	return { created, skipped, alreadyDone: false };
}

if (import.meta.main) {
	const orgId = process.env.COUCH_ORG_ID;
	if (!orgId)
		throw new Error(
			'Set COUCH_ORG_ID to the id of the organisation whose reserve list is couch-backed.'
		);
	// zaruba: couch reserve — required, no fallback: without a dedicated replication user the
	// platform would have to replicate as the admin, which is exactly what this is meant to avoid.
	const replUser = process.env.COUCH_REPL_USER;
	const replPassword = process.env.COUCH_REPL_PASSWORD;
	if (!replUser || !replPassword)
		throw new Error(
			'Set COUCH_REPL_USER and COUCH_REPL_PASSWORD (the dedicated non-admin replication user for wardogs_reserve).'
		);
	const { client, db } = connect(databaseTarget());
	const result = await migrateReserveToCouch(
		db,
		{
			COUCH_URL: process.env.COUCH_URL,
			COUCH_DB: process.env.COUCH_DB,
			COUCH_USER: process.env.COUCH_USER,
			COUCH_PASSWORD: process.env.COUCH_PASSWORD
		},
		orgId,
		{ user: replUser, password: replPassword }
	);
	console.log(
		result.alreadyDone
			? '[warcon] couch reserve backfill: already ran, skipped'
			: `[warcon] couch reserve backfill: ${result.created} created, ${result.skipped} already present`
	);
	await client.end();
}
