// bun run db:migrate — applies pending migrations and exits. The split roles refuse to start
// while any are pending, so run this (Compose's `migrate` service does) before web and worker.
import { resolve } from 'node:path';
import { connect, runMigrations } from '$lib/server/db';
import { migrateReserveToCouch } from '../../scripts/migrate-reserve-to-couch'; // zaruba: couch reserve

const url = process.env.DATABASE_URL;
const target =
	url ||
	(process.env.PGHOST && process.env.PGPASSWORD !== undefined
		? {
				hostname: process.env.PGHOST,
				port: Number(process.env.PGPORT) || 5432,
				username: process.env.PGUSER || 'warcon',
				password: process.env.PGPASSWORD,
				database: process.env.PGDATABASE || 'warcon'
			}
		: null);
if (!target) {
	console.error('Set DATABASE_URL, or PGHOST and PGPASSWORD.');
	process.exit(2);
}
const { client, db } = connect(target);
await runMigrations(db, resolve(process.cwd(), 'drizzle'));
console.log('[warcon] migrations applied');
// zaruba: couch reserve
const couchOrgId = process.env.COUCH_ORG_ID;
if (!couchOrgId) {
	console.error('Set COUCH_ORG_ID to the id of the organisation whose reserve list is couch-backed.');
	process.exit(2);
}
const couchReplUser = process.env.COUCH_REPL_USER;
const couchReplPassword = process.env.COUCH_REPL_PASSWORD;
if (!couchReplUser || !couchReplPassword) {
	console.error(
		'Set COUCH_REPL_USER and COUCH_REPL_PASSWORD (the dedicated non-admin replication user for wardogs_reserve).'
	);
	process.exit(2);
}
const couchResult = await migrateReserveToCouch(
	db,
	{
		COUCH_URL: process.env.COUCH_URL,
		COUCH_DB: process.env.COUCH_DB,
		COUCH_USER: process.env.COUCH_USER,
		COUCH_PASSWORD: process.env.COUCH_PASSWORD
	},
	couchOrgId,
	{ user: couchReplUser, password: couchReplPassword }
);
console.log(
	couchResult.alreadyDone
		? '[warcon] couch reserve backfill: already ran, skipped'
		: `[warcon] couch reserve backfill: ${couchResult.created} created, ${couchResult.skipped} already present`
);
await client.end();
