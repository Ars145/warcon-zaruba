// zaruba: couch reserve — kept out of schema.ts so upstream edits there never touch it, and so
// drizzle-kit (which reads only schema.ts) never proposes this table: its migration is the
// hand-written drizzle/zaruba_couch_state.sql.
import { pgTable, text } from 'drizzle-orm/pg-core';

// Tiny generic key/value table, so the CouchDB watch loop's last _changes seq (and the one-time
// backfill marker) survives a restart without overloading site_settings, whose values are bounded
// numbers (see settings.ts).
export const couchState = pgTable('couch_state', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});
export type CouchStateRow = typeof couchState.$inferSelect;
