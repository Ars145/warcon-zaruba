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
import { listEntries, lists } from '../src/lib/server/db/schema';
import { couchConfig, ensureDatabase, ensureIndex, getDoc, putDoc, type CouchEnvLike } from '../src/lib/server/couch';
import type { PersonalDoc } from '../src/lib/server/wardogs-reserve';

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

/** Every active entry of every org's own reserve list (server_id null), Postgres-side. */
async function activeOrgReserveEntries(db: Db) {
	const now = new Date();
	return db
		.select({ steamId: listEntries.steamId, reason: listEntries.reason, expiresAt: listEntries.expiresAt, addedAt: listEntries.addedAt, addedBy: listEntries.addedBy })
		.from(listEntries)
		.innerJoin(lists, eq(lists.id, listEntries.listId))
		.where(
			and(
				eq(lists.kind, 'reserve'),
				isNull(lists.serverId),
				isNull(listEntries.removedAt),
				or(isNull(listEntries.expiresAt), gt(listEntries.expiresAt, now))
			)
		);
}

/** Idempotent: creates `personal:{steamId}` in CouchDB for every row above that isn't there yet. */
export async function migrateReserveToCouch(db: Db, couchEnv: CouchEnvLike): Promise<{ created: number; skipped: number }> {
	const c = couchConfig(couchEnv);
	await ensureDatabase(c);
	await ensureIndex(c, ['type', 'steamId'], 'type-steamid');
	await ensureIndex(c, ['type', 'clanId'], 'type-clanid');

	const rows = await activeOrgReserveEntries(db);
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
	return { created, skipped };
}

if (import.meta.main) {
	const { client, db } = connect(databaseTarget());
	const result = await migrateReserveToCouch(db, {
		COUCH_URL: process.env.COUCH_URL,
		COUCH_DB: process.env.COUCH_DB,
		COUCH_USER: process.env.COUCH_USER,
		COUCH_PASSWORD: process.env.COUCH_PASSWORD
	});
	console.log(`[warcon] couch reserve backfill: ${result.created} created, ${result.skipped} already present`);
	await client.end();
}
