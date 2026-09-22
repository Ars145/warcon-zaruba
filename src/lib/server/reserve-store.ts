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
			out.set(a.steamId, { reason: p?.reason ?? '', expiresAt: a.expiresAt });
		} else {
			out.set(a.steamId, { reason: a.clanTag ? `clan ${a.clanTag}` : 'clan', expiresAt: a.expiresAt });
		}
	}
	return out;
}

/** The org's reserved-slot list: personal entries (editable) plus clan slots (synthetic, read-only). */
export async function entriesView(env: Env, org: OrgRow): Promise<ListEntryView[]> {
	const docs = await loadDocs(env);
	const personals = docs.filter((d): d is PersonalDoc => d.type === 'personal');
	const clans = new Map(docs.filter((d): d is ClanDoc => d.type === 'clan').map((c) => [c.clanId, c]));
	const clanslots = docs.filter((d): d is ClanSlotDoc => d.type === 'clanslot');
	const now = new Date();
	const activeIds = new Set(activeReserve(docs, now).map((a) => a.steamId));

	const srv = await orgServerRefs(env, org.id);
	const serverIds = srv.map((s) => s.id);
	const steamIds = [
		...new Set([...personals.map((p) => p.steamId), ...clanslots.map((s) => s.steamId)])
	];
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
	for (const p of personals) {
		if (!activeIds.has(p.steamId)) continue; // expired: dropped here, nothing written to couch
		out.push({
			id: personalId(p.steamId),
			kind: KIND,
			steamId: p.steamId,
			name: names.get(p.steamId) ?? null,
			reason: p.reason,
			expiresAt: p.expiresAt,
			expired: false,
			addedByName: '',
			addedAt: p.addedAt,
			removedAt: null,
			removedByName: '',
			removal: null,
			member: false,
			servers: perServer(p.steamId)
		});
	}
	const personalIds = new Set(personals.map((p) => p.steamId));
	for (const s of clanslots) {
		if (personalIds.has(s.steamId) || !activeIds.has(s.steamId)) continue;
		const clan = clans.get(s.clanId);
		out.push({
			id: `clanslot:${s.clanId}:${s.steamId}`,
			kind: KIND,
			steamId: s.steamId,
			name: names.get(s.steamId) ?? null,
			reason: clan ? `clan ${clan.clanTag}` : 'clan',
			expiresAt: clan?.expiresAt ?? null,
			expired: false,
			addedByName: '',
			addedAt: s.assignedAt,
			removedAt: null,
			removedByName: '',
			removal: null,
			// Read-only in this panel (the platform owns clan slots): reusing the member-slot flag
			// hides the remove control the same way membership-reserved slots do.
			member: true,
			servers: perServer(s.steamId)
		});
	}
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
