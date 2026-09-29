// What happens in the worker once the kill feed has written a batch: the kills go out on the
// event bus (the SSE route fans them to browsers; in the split roles every web process gets them
// through the relay stream), and the team-kill rules get their turn. Their intents go through
// the same outbox as every other trigger, so delivery, audit and the Discord mirror are shared.
// The Kill rate rules see every batch; the rest of the work is for batches with team kills.
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Env } from './env';
import { emit } from './events';
import { kills, matches } from './db/schema';
import { killsOfMatch } from './matches';
import { enabledTriggers, renderTemplate, teamKillStage, type Evaluation } from './triggers';
import type { TeamKillConfig } from './trigger-rules';
import {
	countsForRate,
	KILL_RATE_FLAG,
	killRateStep,
	killTimes,
	pruneTracks,
	type KillRateConfig,
	type RateTrack,
	type RateTracks
} from './kill-rate';
import { applyTriggerUpdates, enqueueIntents, wakeDelivery } from './outbox';
import { LostOwnership, withOwnedTransaction } from './leadership';
import { memoryOf } from './observe';
import { publicMessage } from './http';
import { notifyTeamKills } from './webhook-delivery';
import { isDemoServer } from './env';
import { drainMockFeed } from './mockgame';
import { ingestBatch } from './feed';
import { servers, type ServerRow } from './db/schema';
import type { KillView } from '$lib/types';

export async function onKillsIngested(
	env: Env,
	serverId: string,
	kills: KillView[]
): Promise<void> {
	if (!kills.length) return;
	emit({ type: 'kills', serverId, kills });
	try {
		await actOnKillRate(env, serverId, kills);
	} catch (err) {
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] kill-rate rules on ${serverId}:`, publicMessage(err));
	}
	const teamKills = kills.filter((k) => k.teamKill && k.killer);
	if (!teamKills.length) return;
	const m = memoryOf(serverId);
	void notifyTeamKills(env, serverId, m?.status?.serverName || m?.server.name || '', teamKills);
	try {
		await actOnTeamKills(env, serverId, teamKills);
	} catch (err) {
		if (err instanceof LostOwnership) return;
		console.warn(`[warcon] team-kill rules on ${serverId}:`, publicMessage(err));
	}
}

/**
 * Each Kill rate rule's window of recent kills per player, in this process's memory: kills are
 * acted on only in the worker, and a restart starting the windows over costs a flag, not data
 * (the kills themselves are in the table). Kept only for servers with the rule on.
 */
const rateTracks = new Map<string, { serverId: string; tracks: RateTracks }>();

async function actOnKillRate(env: Env, serverId: string, batch: KillView[]): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'kill_rate');
	const live = new Set(rows.map((r) => r.id));
	for (const [id, t] of rateTracks)
		if (t.serverId === serverId && !live.has(id)) rateTracks.delete(id);
	if (!rows.length) return;
	const times = killTimes(
		Date.parse(batch[0].ts),
		batch.map((k) => k.eventTime)
	);
	const counted = batch
		.map((k, i) => ({ k, at: times[i] }))
		.filter(({ k }) =>
			countsForRate({ killer: k.killer?.steamId, suicide: k.suicide, cause: k.cause })
		)
		.sort((a, b) => a.at - b.at);
	const now = Date.now();
	const out: Evaluation = { intents: [], updates: [] };
	// A flag starts the player's cooldown; if it cannot be queued, neither does the cooldown.
	const flagged: { track: RateTrack; before: number | null }[] = [];
	for (const row of rows) {
		const cfg = row.config as KillRateConfig;
		let entry = rateTracks.get(row.id);
		if (!entry) {
			entry = { serverId, tracks: new Map() };
			rateTracks.set(row.id, entry);
		}
		for (const { k, at } of counted) {
			const steamId = k.killer!.steamId;
			const before = entry.tracks.get(steamId)?.flaggedAt ?? null;
			const verdict = killRateStep(cfg, entry.tracks, steamId, at, k.headshot);
			if (!verdict) continue;
			flagged.push({ track: entry.tracks.get(steamId)!, before });
			const name = k.killer!.name;
			out.intents.push({
				trigger: row,
				action: KILL_RATE_FLAG,
				params: {},
				target: steamId,
				okMessage: `Flagged ${name}: ${verdict}`,
				detail: { name, verdict },
				steamId,
				dedupeKey: [row.id, steamId, k.eventId].join(':')
			});
			out.updates.push({
				id: row.id,
				lastFiredAt: new Date(),
				lastResult: `Flagging ${name}: ${verdict}`
			});
		}
		pruneTracks(cfg, entry.tracks, now);
	}
	if (!out.intents.length) return;
	let queued = 0;
	try {
		await withOwnedTransaction(env, async (tx) => {
			queued = await enqueueIntents(tx, serverId, out.intents);
			await applyTriggerUpdates(tx, out.updates);
		});
	} catch (err) {
		for (const f of flagged.reverse()) f.track.flaggedAt = f.before;
		throw err;
	}
	if (queued) wakeDelivery();
}

/**
 * How many team kills each of these players has in the match the batch arrived in, up to and
 * including the batch: the rows that carry that match, as its match page counts them. Leaving
 * and joining again does not start the count over, and a batch acted on late does not count the
 * ones that came after it. A batch that came in while no match was open (a server's first
 * seconds, or just after its stats were purged) counts with the other such kills of the hour
 * before.
 */
async function teamKillsThisMatch(
	env: Env,
	serverId: string,
	batch: KillView[],
	steamIds: string[]
): Promise<Map<string, number>> {
	// Every kill of a batch was stamped with the match open at receipt (feed.ts); any one says which.
	const at = new Date(batch[0].ts);
	const [stamp] = await env.db
		.select({ row: kills.matchRow, startedAt: matches.startedAt, endedAt: matches.endedAt })
		.from(kills)
		.leftJoin(matches, and(eq(matches.id, kills.matchRow), eq(matches.serverId, kills.serverId)))
		.where(
			and(
				eq(kills.serverId, serverId),
				eq(kills.eventId, batch[0].eventId),
				gte(kills.ts, new Date(at.getTime() - 60_000))
			)
		)
		.limit(1);
	const match =
		stamp?.row != null && stamp.startedAt
			? killsOfMatch(stamp.row, stamp.startedAt, stamp.endedAt)
			: null;
	const rows = await env.db
		.select({ steamId: kills.killerSteamId, n: sql<number>`COUNT(*)` })
		.from(kills)
		.where(
			and(
				eq(kills.serverId, serverId),
				inArray(kills.killerSteamId, steamIds),
				eq(kills.teamKill, true),
				stamp?.row != null ? eq(kills.matchRow, stamp.row) : isNull(kills.matchRow),
				gte(kills.ts, match?.from ?? new Date(at.getTime() - 3600_000)),
				lte(kills.ts, at)
			)
		)
		.groupBy(kills.killerSteamId);
	return new Map(rows.map((r) => [r.steamId!, Number(r.n)]));
}

async function actOnTeamKills(env: Env, serverId: string, teamKills: KillView[]): Promise<void> {
	const rows = (await enabledTriggers(env, serverId)).filter((r) => r.kind === 'team_kill');
	if (!rows.length) return;
	const m = memoryOf(serverId);
	const serverName = m?.status?.serverName || m?.server.name || '';
	const out: Evaluation = { intents: [], updates: [] };
	// One count per killer for the batch; the last of their kills in it is the one acted on.
	const byKiller = new Map<string, KillView>();
	for (const k of teamKills) byKiller.set(k.killer!.steamId, k);
	const counts = await teamKillsThisMatch(env, serverId, teamKills, [...byKiller.keys()]);
	for (const [steamId, k] of byKiller) {
		const count = counts.get(steamId) ?? 0;
		const v = {
			name: k.killer!.name,
			victim: k.victim.name,
			count,
			server: serverName,
			map: k.map
		};
		for (const row of rows) {
			const cfg = row.config as TeamKillConfig;
			const stage = teamKillStage(cfg, count);
			if (!stage) continue;
			const kick = stage === 'kick';
			const text = renderTemplate(kick ? cfg.kickReason : cfg.warnMessage, v);
			out.intents.push({
				trigger: row,
				action: kick ? 'kick' : 'whisper',
				params: kick ? { steamId, reason: text } : { steamId, message: text },
				target: steamId,
				okMessage: kick
					? `Kicked ${v.name} after ${count} team kill${count === 1 ? '' : 's'}`
					: `Whispered ${v.name} (${count} team kill${count === 1 ? '' : 's'})`,
				detail: { name: v.name, victim: v.victim, count, eventId: k.eventId },
				steamId,
				dedupeKey: [row.id, steamId, k.eventId].join(':')
			});
			out.updates.push({
				id: row.id,
				lastFiredAt: new Date(),
				lastResult: kick ? `Kicking ${v.name} (${count})` : `Whispering ${v.name} (${count})`
			});
		}
	}
	if (!out.intents.length) return;
	let queued = 0;
	await withOwnedTransaction(env, async (tx) => {
		queued = await enqueueIntents(tx, serverId, out.intents);
		await applyTriggerUpdates(tx, out.updates);
	});
	if (queued) wakeDelivery();
}

/**
 * The demo server's kills, fed through the same path as a real server's once its feed is turned
 * on (Config tab): the mock has no process of its own to post from, so the worker drains
 * its queue after each observation.
 */
export async function feedDemoKills(env: Env, server: ServerRow): Promise<void> {
	if (!isDemoServer(env, server)) return;
	const batch = drainMockFeed(server.id);
	if (!batch) return;
	const [row] = await env.db
		.select({ on: sql<boolean>`${servers.feedTokenHash} IS NOT NULL` })
		.from(servers)
		.where(eq(servers.id, server.id));
	if (!row?.on) return;
	const r = await ingestBatch(env, server.id, batch);
	if (r.kills.length) await onKillsIngested(env, server.id, r.kills);
}
