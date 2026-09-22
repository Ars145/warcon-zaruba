# CouchDB-backed org reserve list

The org-level reserved-slot list (kind `reserve`, `server_id is null`) is stored in CouchDB
(`wardogs_reserve`), replicated multi-master with the platform's own CouchDB, instead of Postgres
`list_entries`. Server-own reserve lists, the ban list, and everything else about Warcon are
unchanged.

## Why

The platform writes personal and clan reserved slots directly; Berni keeps adding/removing
personal entries by hand through the Warcon WebUI. Both sides need to see and write the same data
without going through each other's API, so it lives in a replicated document store both write to
directly, with one place (here) that resolves the conflicts multi-master writes eventually produce.

## Document schema (the contract; also implemented independently by the platform's Python services)

- `personal:{steamId}` — `{ type: "personal", steamId, expiresAt: ISO-8601 UTC "…Z" | null, reason, addedBy, addedAt }`.
  `expiresAt: null` means permanent. Written by Warcon (this repo) and by the platform.
- `clan:{clanId}` — `{ type: "clan", clanId, clanTag, slots, expiresAt: ISO }`. Written only by the platform.
- `clanslot:{clanId}:{steamId}` — `{ type: "clanslot", clanId, steamId, assignedBy, assignedAt }`. Written only by the platform.
- Removal is a CouchDB `DELETE`, never a soft-delete field.
- Expiry is a read-time filter: nothing is written when something expires. Active personal:
  `expiresAt` is null or in the future. Active clanslot: its `clan` doc exists and `clan.expiresAt`
  is in the future.

## Conflict rule (implemented only in Warcon, not by the platform)

Among the revisions CouchDB reports as conflicting for one doc: the winner is whichever has
`expiresAt === null` (permanent beats any date), else the one with the latest `expiresAt`. The
winner's body is written onto the doc's current winning revision if it differs, and every losing
revision is deleted. See `pickWinner` / `resolveConflict` in `src/lib/server/wardogs-reserve.ts`.

## What changed in this repo

New files (none of this logic lives in an upstream file):

- `src/lib/server/couch.ts` — minimal CouchDB HTTP client (basic auth): `getDoc`, `putDoc`,
  `deleteDoc`, `find` (Mango), `getRevs` (open_revs), `changes` (`_changes` longpoll),
  `ensureDatabase`, `ensureIndex`.
- `src/lib/server/wardogs-reserve.ts` — pure logic: `activeReserve`, `pickWinner`,
  `resolveConflict`, `desiredReserve`. No I/O beyond what couch.ts does on its behalf; the merge
  and conflict rules are unit-tested in `wardogs-reserve.test.ts` without a database.
- `src/lib/server/reserve-store.ts` — the org reserve list's CRUD (`entriesView`, `addEntry`,
  `removeEntry`, `updateEntry`, `notesFor`), mirroring the signatures of the Postgres-backed
  functions it stands in for.
- `src/lib/server/wardogs-watch.ts` — the worker's `_changes` watch loop: resolves conflicts and
  triggers a list sync (`gateway().syncOrg`) on every batch of changes.
- `scripts/migrate-reserve-to-couch.ts` — idempotent backfill from Postgres `list_entries` into
  CouchDB `personal:` docs, and `ensureDatabase`/`ensureIndex` on first run. Runs standalone
  (`bun run scripts/migrate-reserve-to-couch.ts`) and automatically as part of the migrate step.
- `drizzle/0029_couch_state.sql` + the `couchState` table in `db/schema.ts` — a tiny generic
  key/value table holding the `_changes` watch loop's last seq, so a restart resumes instead of
  re-scanning. (`site_settings` was not reused: its values are bounded numeric settings, not an
  opaque cursor.)
- `docs/zaruba-couch-reserve.md` — this file.

Seams in upstream files (search for `zaruba: couch reserve` — every one is a single added line or
a one-line early-return, never a rewrite of surrounding logic):

- `src/lib/server/env.ts` — `Env.COUCH_URL/COUCH_DB/COUCH_USER/COUCH_PASSWORD` (required), a
  `couchEnvProblem()` check in `initEnv()` that throws when any is missing.
- `src/lib/server/lists.ts`:
  - `entriesView` — `if (kind === 'reserve') return reserveStore.entriesView(env, org);`
  - `addEntry` — `if (kind === 'reserve') return reserveStore.addEntry(...);`
  - `removeEntry` — `if (kind === 'reserve') return reserveStore.removeEntry(...);`
  - `updateEntry` — `if (kind === 'reserve' && !server) return reserveStore.updateEntry(...);`
    (server-own reserve lists are untouched: `server` is only ever set for those.)
  - `importEntries` — reserve picks now throw 400 `reserve_import_disabled` instead of adopting
    server-observed slots into a Postgres list that no longer exists as the source of truth. See
    "Known gaps" below for why disabling was chosen over a seam.
  - `serverListsState` — a fallback block after the existing `list_entries` lookup: org-scoped
    slots it found nothing for get their note/expiry from `reserveStore.notesFor`.
- `src/lib/server/lists-sync.ts`:
  - `desiredFor` — the org reserve list is excluded from the generic Postgres query
    (`or(ne(lists.kind, 'reserve'), isNotNull(lists.serverId))`); its entries are added afterwards
    from `desiredReserve(env, now)`. Bans, and every server's own reserve list, are unaffected.
  - `expireEntries` — the org reserve list's Postgres rows are excluded from the expiry sweep
    (`notInArray(listEntries.listId, orgReserveListIds)`): expiry for it is a CouchDB read-time
    filter now, nothing to lift here.
- `src/lib/server/poller.ts` — `startReserveWatch(env)` / `stopReserveWatch()` alongside the
  existing `startDelivery`/`startStatusMirror` pair in `startPoller`/`stopPoller`.
- `src/lib/server/db/schema.ts` — the new `couchState` table (additive; nothing existing changed).
- `src/worker/migrate.ts` — one import plus one call: `await migrateReserveToCouch(db, process.env)`
  after `runMigrations`.
- `docker-compose.yml` — a `couch` service, `COUCH_*` in the shared env anchor, `migrate` gains
  `depends_on: couch (healthy)` (mirroring how it already depends on `db`; `warcon`/`worker` don't
  depend on `db` directly either — they depend on `migrate`, which gates both).

## Known gaps (not finished in this pass)

- **`importEntries` for `reserve` is disabled, not migrated.** `importCandidates` still reads
  Postgres `server_bans`/`server_reserved`/`server_list_state` and doesn't know about CouchDB, so
  it can list a player as an "import candidate" who is already reserved via CouchDB. The import
  button itself throws 400 for any reserve pick, so nothing incorrect can be *written*, but the
  candidate list can be misleading for reserve until `importCandidates` also excludes
  `desiredReserve` steamIds.
- **Old Postgres `list_entries` rows for the org reserve list are never cleaned up.** The backfill
  script only adds to CouchDB; existing Postgres rows are left active (`removed_at` still null).
  They no longer feed `desiredFor` or `entriesView` (both seam past them), but if a duplicate,
  un-migrated, or otherwise stale row happens to share a `list_id` with the org reserve list and a
  steamId that also has no CouchDB doc, `serverListsState`'s `list_entries` lookup will still
  surface it before the CouchDB fallback runs. This is a pre-existing-row edge case, not a new
  write path — the platform and Warcon only ever write to CouchDB going forward for this list.
- **`drizzle/meta/0029_couch_state_snapshot.json` was not generated** (no local `bun`/`drizzle-kit`
  available in this environment). The hand-written `0029_couch_state.sql` and the appended
  `_journal.json` entry are enough for `runMigrations`/`bun run db:migrate` (they only read the SQL
  files and the journal). Before the *next* schema change, run `bun run db:generate` once so
  drizzle-kit's snapshot catches up — otherwise it will re-diff against the last real snapshot
  (0028) and may re-propose the `couch_state` table.

## Caddy, on the host in front of the dev/prod box

```
warcon.zaruba-server.online {
    @couch {
        path /couch/*
        remote_ip 144.31.49.29
    }
    handle @couch {
        uri strip_prefix /couch
        reverse_proxy 127.0.0.1:5984
    }
    reverse_proxy 127.0.0.1:3000
}
```

`docker-compose.yml` binds CouchDB to `127.0.0.1:5984` on the host (not the public interface); the
`@couch` matcher additionally restricts it to the platform's own IP, since CouchDB's replicator
protocol carries its own auth but the port is otherwise open to anything reaching Caddy.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `COUCH_URL` | yes | e.g. `http://couch:5984` inside Compose |
| `COUCH_DB` | yes | `wardogs_reserve` |
| `COUCH_USER` | yes | basic auth |
| `COUCH_PASSWORD` | yes | basic auth; set in `.env`, never committed |

All four are required with no fallback: `initEnv()` throws at startup if any is missing (see
`couchEnvProblem` in `env.ts`).
