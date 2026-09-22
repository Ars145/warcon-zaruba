# CouchDB-backed org reserve list

The org-level reserved-slot list (kind `reserve`, `server_id is null`) of **one org, `COUCH_ORG_ID`**,
is stored in CouchDB (`wardogs_reserve`), replicated multi-master with the platform's own CouchDB,
instead of Postgres `list_entries`. Every other org's reserve list is untouched Postgres
`list_entries`, same as before this feature existed. Server-own reserve lists, the ban list, and
everything else about Warcon are unchanged for every org, `COUCH_ORG_ID` included.

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

### What this means for the two conflicts that actually happen

- **An admin `DELETE`s a `personal:` doc while the platform concurrently extends it.** CouchDB
  reports this as a conflict between "doc gone" and "doc with a later `expiresAt`" the next time
  each side reads it (a delete and a normal revision race on the same doc id create exactly the
  conflicted-revision-tree case `pickWinner` resolves). The extension wins: `pickWinner` never
  considers "deleted" a candidate revision at all — `getRevs` only returns revisions that still
  have a body, so a tombstone loses to any live revision it's conflicting with, dated or
  permanent. In effect, removing a grant and extending it at the same moment always ends with the
  grant standing.
- **An admin shortens (or otherwise edits) a `personal:` doc while the platform concurrently
  extends it.** Ordinary `pickWinner` rule: the later `expiresAt` wins outright (permanent beats
  any date; otherwise max date wins). The admin's shortening is discarded, not merged — there is
  no field-level merge, the whole losing revision is deleted.

Both are a direct consequence of one rule ("later wins, permanent wins hardest") applied
uniformly; there is no separate carve-out for deletes vs edits. It favors the platform's grants
staying live over an admin's attempt to remove or shorten one made at the same instant — a
narrow, expected-to-be-rare race, not the everyday add/remove path (which never conflicts: it's a
plain `PUT`/`DELETE` with the right `_rev`, not two writers racing the same revision tree).

## What changed in this repo

New files (none of this logic lives in an upstream file):

- `src/lib/server/couch.ts` — minimal CouchDB HTTP client (basic auth): `getDoc`, `putDoc`,
  `deleteDoc`, `find` (Mango), `getRevs` (open_revs), `changes` (`_changes` longpoll),
  `ensureDatabase`, `ensureIndex`.
- `src/lib/server/wardogs-reserve.ts` — pure logic: `activeReserve`, `pickWinner`,
  `resolveConflict`, `desiredReserve`. No I/O beyond what couch.ts does on its behalf; the merge
  and conflict rules are unit-tested in `wardogs-reserve.test.ts` without a database.
  `desiredReserve` memoizes its underlying CouchDB `_find` behind a 2s TTL, keyed process-wide (not
  per org, since only one org is ever couch-backed): `desiredFor` (lists-sync.ts) calls it once per
  server, and `fanOut`/`syncOrg` run every one of an org's servers concurrently, so without the
  memo a sync fans out one `_find` per server instead of one per sync.
- `src/lib/server/reserve-store.ts` — the org reserve list's CRUD (`entriesView`, `addEntry`,
  `removeEntry`, `updateEntry`, `notesFor`), mirroring the signatures of the Postgres-backed
  functions it stands in for. `entriesView` also folds in members-reserved slots
  (`org.membersReserved` → `memberSlots`, imported from `lists-sync.ts`) for members not already
  covered by an active personal or clan grant — the couch-backed counterpart of the members branch
  in `lists.ts`'s own `entriesView`, which `isCouchReserve` makes unreachable for this org.
- `src/lib/server/wardogs-watch.ts` — the worker's `_changes` watch loop: resolves conflicts and
  triggers a list sync (`gateway().syncOrg`) on every batch of changes, coalesced per org through
  `makeCoalescer` (exported, unit-tested in `wardogs-watch.test.ts` independent of CouchDB/Postgres):
  a sync already running for an org is left to finish and at most one more run is queued behind it,
  rather than one `syncOrg` firing per `_changes` batch regardless of how many are still in flight.
  `stopReserveWatch` is `async` and awaits both the loop's current iteration and every coalesced
  sync it kicked off, so a caller that awaits it can rely on the watch being fully quiesced.
- `scripts/migrate-reserve-to-couch.ts` — idempotent backfill from `COUCH_ORG_ID`'s Postgres
  `list_entries` into CouchDB `personal:` docs, and `ensureDatabase`/`ensureIndex` (ddoc `wardogs`,
  index names `type-steamId`/`type-clanId` — matching what the platform's own init job creates) on
  first run. Runs standalone (`bun run scripts/migrate-reserve-to-couch.ts`, `COUCH_ORG_ID`
  required) and automatically as part of the migrate step. Runs **only once, ever**: see "Backfill
  marker" below.
- `drizzle/0029_couch_state.sql` + the `couchState` table in `db/schema.ts` — a tiny generic
  key/value table holding the `_changes` watch loop's last seq, so a restart resumes instead of
  re-scanning. (`site_settings` was not reused: its values are bounded numeric settings, not an
  opaque cursor.)
- `docs/zaruba-couch-reserve.md` — this file.

Seams in upstream files (search for `zaruba: couch reserve` — every one is a single added line, a
one-line early-return, or a small guard condition, never a rewrite of surrounding logic):

- `src/lib/server/env.ts` — `Env.COUCH_URL/COUCH_DB/COUCH_USER/COUCH_PASSWORD/COUCH_ORG_ID`
  (all required), `couchEnvProblem()` and `couchOrgIdProblem()` checks in `initEnv()` that throw
  when any is missing. See "COUCH_ORG_ID" below.
- `src/lib/server/lists.ts` — `isCouchReserve(env, kind, orgId)` (`kind === 'reserve' && orgId ===
  env.COUCH_ORG_ID`), so only `COUCH_ORG_ID`'s own reserve list takes the CouchDB path; every other
  org's `kind === 'reserve'` falls through to the same `list_entries` code every other kind uses:
  - `entriesView` — `if (isCouchReserve(env, kind, org.id)) return reserveStore.entriesView(env, org);`
  - `addEntry` — `if (isCouchReserve(env, kind, org.id)) return reserveStore.addEntry(...);`
  - `removeEntry` — `if (isCouchReserve(env, kind, org.id)) return reserveStore.removeEntry(...);`
  - `updateEntry` — `if (isCouchReserve(env, kind, org.id) && !server) return reserveStore.updateEntry(...);`
    (server-own reserve lists are untouched: `server` is only ever set for those.)
  - `importEntries` — reserve picks for `COUCH_ORG_ID` throw 400 `reserve_import_disabled` instead
    of adopting server-observed slots into a Postgres list that isn't the source of truth for that
    org; every other org still imports reserve picks normally. See "Known gaps" below for why
    disabling was chosen over a seam, for the couch-backed org.
  - `serverListsState` — a fallback block after the existing `list_entries` lookup: org-scoped
    slots it found nothing for get their note/expiry from `reserveStore.notesFor`. (Unconditional:
    `notesFor` only ever has entries when the calling org is `COUCH_ORG_ID`, since that's the only
    org anything is ever written to CouchDB for — see `entriesView`/`notesFor` in
    `reserve-store.ts`, both of which read the same single, org-agnostic CouchDB database.)
- `src/lib/server/lists-sync.ts`:
  - `desiredFor` — the org reserve list is excluded from the generic Postgres query
    (`or(ne(lists.kind, 'reserve'), isNotNull(lists.serverId))`) for every org; `COUCH_ORG_ID`'s
    entries are then added from `desiredReserve(env, now)`, gated on `server.orgId ===
    env.COUCH_ORG_ID`. A `desiredReserve` failure (CouchDB unreachable) is caught around that one
    call only and returned as `reserveError` on the result rather than thrown: bans, and reserve
    entries already computed from `list_entries` (every other org's, and this org's
    members-reserved additions), are unaffected by a CouchDB outage. The caller (`run` in this same
    file) surfaces `reserveError` as `Reserve list: …` in the server's sync result `error` field
    without marking the sync `ok: false`.
  - `expireEntries` — the org reserve list's Postgres rows are excluded from the expiry sweep
    (`notInArray(listEntries.listId, orgReserveListIds)`): expiry for it is a CouchDB read-time
    filter now, nothing to lift here. Applies to every org's reserve list the same way `desiredFor`
    excludes it, not just `COUCH_ORG_ID`'s — harmless for every other org, since their reserve list
    was never a CouchDB list to begin with and this just skips an already-empty exclusion set.
- `src/lib/server/poller.ts` — `startReserveWatch(env)` / `await stopReserveWatch()` alongside the
  existing `startDelivery`/`startStatusMirror` pair in `startPoller`/`stopPoller` (`stopPoller` was
  already `async`).
- `src/lib/server/db/schema.ts` — the new `couchState` table (additive; nothing existing changed).
  Doubles as the backfill marker's storage (see below) and the `_changes` watch's last-seq cursor.
- `src/worker/migrate.ts` — requires `COUCH_ORG_ID` (fails fast if unset) and passes it to
  `migrateReserveToCouch(db, process.env, couchOrgId)` after `runMigrations`.
- `docker-compose.yml` — a `couch` service, `COUCH_*` (including `COUCH_ORG_ID`) in the shared env
  anchor, `migrate` gains `depends_on: couch (healthy)` (mirroring how it already depends on `db`;
  `warcon`/`worker` don't depend on `db` directly either — they depend on `migrate`, which gates
  both).

## COUCH_ORG_ID

Exactly one org's reserve list is couch-backed; every other org keeps ordinary Postgres
`list_entries`, unaffected by any of this. `COUCH_ORG_ID` names that one org, and is required with
no fallback — an unset value is refused at startup (`couchOrgIdProblem` in `env.ts`), specifically
*because* the alternative (treating unset as "couch-backed for no org") would look like a
successful, silent no-op: every `isCouchReserve` check would just always be false, and the feature
would appear to work (no errors) while quietly never engaging. The CouchDB documents themselves
carry no `orgId` field at all — `wardogs_reserve` only ever holds one org's data by construction,
which is also why `wardogs-watch.ts`'s `reserveOrgs()` and the migrate script's backfill both
filter to `lists.orgId = COUCH_ORG_ID` explicitly, rather than "every org with a reserve list"
(which, before this fix, is what both did — see git history on this file's authoring commit).

## Backfill marker

`migrateReserveToCouch` (in `scripts/migrate-reserve-to-couch.ts`, called from
`src/worker/migrate.ts`) runs the Postgres → CouchDB backfill **at most once, ever**, guarded by a
`couch_state` row (`key: 'reserve_backfilled'`, `value` = the ISO timestamp it ran) written after a
successful run. Every later `bun run db:migrate` / migrate-container start checks for that row
first and returns immediately (`alreadyDone: true`) without touching CouchDB or Postgres if it's
present.

This exists because the backfill is not actually idempotent against CouchDB deletions: without the
marker, every migrate run would re-read `COUCH_ORG_ID`'s active Postgres `list_entries` rows and
re-`PUT` any `personal:{steamId}` doc missing from CouchDB — including one an admin had
deliberately `DELETE`d straight in CouchDB since the last migrate. The backfill's job is only to
seed CouchDB the first time the couch-backed list goes live, when Postgres is still the only
source of truth; once CouchDB has data, it — not the old Postgres rows, which are never cleaned up
(see "Known gaps") — is authoritative, and nothing should ever write into it *from* those rows
again.

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
| `COUCH_ORG_ID` | yes | the one org whose reserve list is couch-backed; see "COUCH_ORG_ID" above |

All five are required with no fallback: `initEnv()` throws at startup if any is missing (see
`couchEnvProblem`/`couchOrgIdProblem` in `env.ts`).
