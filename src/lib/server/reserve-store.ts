// zaruba: couch reserve
// CRUD for the org's reserved-slot list, backed by CouchDB instead of Postgres list_entries.
// Mirrors the signatures and return shapes of the upstream functions in lists.ts it stands in for
// (entriesView / addEntry / removeEntry / updateEntry, always for kind 'reserve' and the org's own
// list — never a server's own reserve list, never bans). Per-server standing (applied/failed/
// pending/local) still comes from serverListState/serverReserved in Postgres: only which steamIds
// the org wants reserved moved to CouchDB, not how the sync tracks what each server got.
//
// Personal entries (personal:{steamId}) are the only docs this module writes; clan:/clanslot: docs
// are written only by the platform and are shown here as read-only synthetic entries, the same way
// lists.ts shows membership-reserved slots.
import { ApiError, str } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import type { Env } from './env';
import { requireSteamId } from './steam';
import { gateway } from './gateway';
import { namesFor, orgServerRefs, parseExpiry, standings } from './lists';
import { memberSlots } from './lists-sync'; // zaruba: couch reserve
import { couchConfig, deleteDoc, find, getDoc, putDoc } from './couch';
import {
	activeReserve,
	type ClanDoc,
	type ClanSlotDoc,
	type PersonalDoc,
	type ReserveDoc
} from './wardogs-reserve';
import type { ListEntryView, ListServerStateView, ListSyncSummary } from '$lib/types';

const KIND = 'reserve' as const;
const personalId = (steamId: string) => `personal:${steamId}`;

async function loadDocs(env: Env): Promise<ReserveDoc[]> {
	const c = couchConfig(env);
	return find<ReserveDoc>(c, { type: { $in: ['personal', 'clan', 'clanslot'] } });
}

/**
 * The note (reason) and expiry to show for these steamIds' org-wide reserved slot, whichever of a
 * personal grant or a clan slot is currently active for them (see wardogs-reserve.activeReserve).
 * Used by serverListsState (lists.ts) to fill in what used to come from list_entries.
 */
export async function notesFor(
	env: Env,
	steamIds: string[]
): Promise<Map<string, { reason: string; expiresAt: string | null }>> {
	const out = new Map<string, { reason: string; expiresAt: string | null }>();
	if (!steamIds.length) return out;
	const docs = await loadDocs(env);
	const wanted = new Set(steamIds);
	const now = new Date();
	for (const a of activeReserve(docs, now)) {
		if (!wanted.has(a.steamId)) continue;
		if (a.source === 'personal') {
			const p = docs.find(
				(d): d is PersonalDoc => d.type === 'personal' && d.steamId === a.steamId
			);
			// activeReserve only reports source 'personal' for a steamId when it found a personal
			// doc for it, so p is always here; reason is required by PersonalDoc (not optional),
			// so there is no missing-value case to fall back for.
			if (!p) throw new Error(`reserve-store: no personal doc found for active grant ${a.steamId}.`);
			out.set(a.steamId, { reason: p.reason, expiresAt: a.expiresAt });
		} else {
			out.set(a.steamId, { reason: a.clanTag ? `clan ${a.clanTag}` : 'clan', expiresAt: a.expiresAt });
		}
	}
	return out;
}

/** The org's reserved-slot list: personal entries (editable) plus clan slots (synthetic, read-only). */
export async function entriesView(env: Env, org: OrgRow): Promise<ListEntryView[]> {
	const docs = await loadDocs(env);
	const personalByPlayer = new Map(
		docs.filter((d): d is PersonalDoc => d.type === 'personal').map((p) => [p.steamId, p])
	);
	const clans = new Map(docs.filter((d): d is ClanDoc => d.type === 'clan').map((c) => [c.clanId, c]));
	const clanslotByPlayer = new Map(
		docs.filter((d): d is ClanSlotDoc => d.type === 'clanslot').map((s) => [s.steamId, s])
	);
	const now = new Date();
	// One resolved entry per steamId, source already decided (a player with both an expired
	// personal doc and an active clan slot resolves to 'clan' here — activeReserve drops the
	// expired personal before picking a source, so this list is never keyed off the raw doc set).
	const active = activeReserve(docs, now);

	// zaruba: couch reserve — members-reserved slots for org.membersReserved, the couch-backed
	// counterpart of the members branch in lists.ts entriesView (~L374-381), which this function's
	// early return (lists.ts isCouchReserve) makes unreachable for this org. A member already
	// covered by an active personal or clan grant above is not also listed as a member slot.
	const members = org.membersReserved
		? (await memberSlots(env, org.id)).filter((m) => !active.some((a) => a.steamId === m.steamId))
		: [];

	const srv = await orgServerRefs(env, org.id);
	const serverIds = srv.map((s) => s.id);
	const steamIds = [...new Set([...active.map((a) => a.steamId), ...members.map((m) => m.steamId)])];
	const [names, byServer] = await Promise.all([
		namesFor(env, serverIds, steamIds),
		standings(env, KIND, serverIds, steamIds)
	]);
	const perServer = (steamId: string): ListServerStateView[] =>
		srv.map((s) => {
			const st = byServer.get(s.id)?.get(steamId);
			return { serverId: s.id, serverName: s.name, state: st?.state ?? 'pending', error: st?.error ?? '' };
		});

	const out: ListEntryView[] = [];
	for (const a of active) {
		if (a.source === 'personal') {
			const p = personalByPlayer.get(a.steamId);
			if (!p) throw new Error(`reserve-store: no personal doc found for active grant ${a.steamId}.`);
			out.push({
				id: personalId(a.steamId),
				kind: KIND,
				steamId: a.steamId,
				name: names.get(a.steamId) ?? null,
				reason: p.reason,
				expiresAt: a.expiresAt,
				expired: false,
				addedByName: '',
				addedAt: p.addedAt,
				removedAt: null,
				removedByName: '',
				removal: null,
				member: false,
				servers: perServer(a.steamId)
			});
		} else {
			const s = clanslotByPlayer.get(a.steamId);
			if (!s) throw new Error(`reserve-store: no clanslot doc found for active grant ${a.steamId}.`);
			const clan = clans.get(s.clanId);
			out.push({
				id: `clanslot:${s.clanId}:${a.steamId}`,
				kind: KIND,
				steamId: a.steamId,
				name: names.get(a.steamId) ?? null,
				reason: clan ? `clan ${clan.clanTag}` : 'clan',
				expiresAt: a.expiresAt,
				expired: false,
				addedByName: '',
				addedAt: s.assignedAt,
				removedAt: null,
				removedByName: '',
				removal: null,
				// Read-only in this panel (the platform owns clan slots): reusing the member-slot flag
				// hides the remove control the same way membership-reserved slots do.
				member: true,
				servers: perServer(a.steamId)
			});
		}
	}
	for (const m of members)
		out.push({
			id: `member:${m.userId}`,
			kind: KIND,
			steamId: m.steamId,
			name: names.get(m.steamId) ?? (m.username ? `@${m.username}` : null),
			reason: m.username ? `member @${m.username}` : 'member',
			expiresAt: null,
			expired: false,
			addedByName: '',
			addedAt: m.since.toISOString(),
			removedAt: null,
			removedByName: '',
			removal: null,
			member: true,
			servers: perServer(m.steamId)
		});
	return out;
}

/** Adds (or replaces an expired) personal grant. 409 when an active one already exists. */
export async function addEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<{ entry: ListEntryView; sync: ListSyncSummary }> {
	const steamId = requireSteamId(body.steamId);
	const reason = str(body.reason, 200);
	const expiresAt = parseExpiry(body.expiresAt);
	const c = couchConfig(env);
	const now = new Date();
	const existing = await getDoc<PersonalDoc>(c, personalId(steamId));
	if (existing && (existing.expiresAt === null || new Date(existing.expiresAt) > now))
		throw new ApiError(409, `${steamId} is already on the reserved-slot list.`, 'duplicate');
	const doc: PersonalDoc = {
		_id: personalId(steamId),
		...(existing ? { _rev: existing._rev } : {}),
		type: 'personal',
		steamId,
		expiresAt: expiresAt ? expiresAt.toISOString() : null,
		reason,
		addedBy: actor.id,
		addedAt: now.toISOString()
	};
	await putDoc(c, doc);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.add',
		target: steamId,
		outcome: 'ok',
		message:
			`Reserved slot across ${org.name}` +
			(reason ? `: ${reason}` : '') +
			(expiresAt ? ` (until ${expiresAt.toISOString()})` : ''),
		detail: {
			orgId: org.id,
			org: org.name,
			kind: KIND,
			reason,
			expiresAt: expiresAt ? expiresAt.toISOString() : null
		}
	});
	const sync = await gateway().syncOrg(env, org);
	const entry = (await entriesView(env, org)).find((e) => e.steamId === steamId)!;
	return { entry, sync };
}

/** Removes an active personal grant (a CouchDB DELETE). 404 when there is none. */
export async function removeEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	steamIdIn: unknown
): Promise<{ sync: ListSyncSummary }> {
	const steamId = requireSteamId(steamIdIn);
	const c = couchConfig(env);
	const now = new Date();
	const existing = await getDoc<PersonalDoc>(c, personalId(steamId));
	if (!existing || !(existing.expiresAt === null || new Date(existing.expiresAt) > now))
		throw new ApiError(404, `${steamId} is not on the reserved-slot list.`, 'not_found');
	await deleteDoc(c, personalId(steamId), existing._rev!);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.remove',
		target: steamId,
		outcome: 'ok',
		message: `Reserved slot withdrawn across ${org.name}`,
		detail: { orgId: org.id, org: org.name, kind: KIND }
	});
	const sync = await gateway().syncOrg(env, org);
	return { sync };
}

/** Changes the reason and/or expiry of an active personal grant. */
export async function updateEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	steamIdIn: unknown,
	body: Record<string, unknown>
): Promise<{ entry: { steamId: string; reason: string; expiresAt: string | null } }> {
	const steamId = requireSteamId(steamIdIn);
	const set: { reason?: string; expiresAt?: Date | null } = {};
	if ('reason' in body) set.reason = str(body.reason, 200);
	if ('expiresAt' in body) set.expiresAt = parseExpiry(body.expiresAt);
	if (!('reason' in set) && !('expiresAt' in set))
		throw new ApiError(400, 'Nothing to change: send reason, expiresAt or both.');
	const c = couchConfig(env);
	const now = new Date();
	const existing = await getDoc<PersonalDoc>(c, personalId(steamId));
	if (!existing || !(existing.expiresAt === null || new Date(existing.expiresAt) > now))
		throw new ApiError(404, `${steamId} is not on the reserved-slot list of ${org.name}.`, 'not_found');
	const doc: PersonalDoc = {
		...existing,
		reason: 'reason' in set ? set.reason! : existing.reason,
		expiresAt: 'expiresAt' in set ? (set.expiresAt ? set.expiresAt.toISOString() : null) : existing.expiresAt
	};
	await putDoc(c, doc);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.update',
		target: steamId,
		outcome: 'ok',
		message:
			`Reserved slot changed across ${org.name}` +
			('expiresAt' in set
				? set.expiresAt
					? ` (until ${set.expiresAt.toISOString()})`
					: ' (permanent)'
				: ''),
		detail: {
			kind: KIND,
			...('reason' in set ? { reason: set.reason } : {}),
			...('expiresAt' in set ? { expiresAt: set.expiresAt ? set.expiresAt.toISOString() : null } : {})
		}
	});
	return { entry: { steamId, reason: doc.reason, expiresAt: doc.expiresAt } };
}
