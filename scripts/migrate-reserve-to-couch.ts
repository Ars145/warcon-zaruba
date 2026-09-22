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
import { couchConfig, ensureDatabase, ensureIndex, getDoc, putDoc, type CouchEnvLike } from '../src/lib/server/couch';
import type { PersonalDoc } from '../src/lib/server/wardogs-reserve';

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
		.select({ steamId: listEntries.steamId, reason: listEntries.reason, expiresAt: listEntries.expiresAt, addedAt: listEntries.addedAt, addedBy: listEntries.addedBy })
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
	orgId: string
): Promise<{ created: number; skipped: number; alreadyDone: boolean }> {
	const c = couchConfig(couchEnv);
	await ensureDatabase(c);
	await ensureIndex(c, ['type', 'steamId'], 'type-steamId', 'wardogs');
	await ensureIndex(c, ['type', 'clanId'], 'type-clanId', 'wardogs');

	const [marker] = await db.select().from(couchState).where(eq(couchState.key, BACKFILL_KEY)).limit(1);
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
	if (!orgId) throw new Error('Set COUCH_ORG_ID to the id of the organisation whose reserve list is couch-backed.');
	const { client, db } = connect(databaseTarget());
	const result = await migrateReserveToCouch(
		db,
		{
			COUCH_URL: process.env.COUCH_URL,
			COUCH_DB: process.env.COUCH_DB,
			COUCH_USER: process.env.COUCH_USER,
			COUCH_PASSWORD: process.env.COUCH_PASSWORD
		},
		orgId
	);
	console.log(
		result.alreadyDone
			? '[warcon] couch reserve backfill: already ran, skipped'
			: `[warcon] couch reserve backfill: ${result.created} created, ${result.skipped} already present`
	);
	await client.end();
}
