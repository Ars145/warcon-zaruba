// AFK protection (kind `afk_protection`), the pure part. While a server seeds, the game's own idle
// kick removes anyone who has given no input for a few minutes, the seeding phase included, so the
// players a server needs to start a match drift away. Killing everyone on it every few minutes keeps
// them in: server admins who run this report that it works; nothing the game documents says why.
// RCON cannot tell an idle player from an active one, so a round kills everyone on.
//
// A round in a live match would kill everyone mid-fight, so the rule acts only while no side has
// scored and fewer than its count are on (the admin's number: set at or below where the server
// starts a match). It turns itself off the moment a side scores or the count is reached, and stays
// off until the server has sat empty for a while or the game has restarted; never on a dip below the
// count, and never on the empty list of a map change. No database, no game server: triggers.ts runs
// the step on each look and keeps the state on the rule's row, written as it changes; outbox.ts
// delivers each round.
import { settingsFingerprint } from './fingerprint';
import { int, str } from './http';
import { MAX_CHAT } from '$lib/chat';

/** The outbox action of one round of kills. Not in ACTIONS, so no route can run it. */
export const AFK_ROUND = 'afk_round';
export const AFK_DEFAULT_MINUTES = 3;
export const AFK_MIN_MINUTES = 2;
export const AFK_MAX_MINUTES = 10;
export const AFK_DEFAULT_STOP_AT = 20;
/** Empty for this long, the server seeds from nothing next time: the rule turns back on. */
export const AFK_REARM_EMPTY_MS = 10 * 60_000;
/** A round goes within this long of being decided, or not at all. */
export const AFK_ROUND_MAX_AGE_MS = 30_000;
/** A round's kills stop after this long in the server's lane; whoever it did not reach is in the next. */
export const AFK_ROUND_MAX_MS = 10_000;
/** The most players one round names. */
export const AFK_ROUND_MAX_PLAYERS = 100;
/**
 * A game start this much later than the one the rule last saw is a restart. A restart moves it by
 * the old uptime (hours); a slow read of /v1/health can move it by seconds.
 */
const RESTART_JUMP_MS = 60_000;

export interface AfkProtectionConfig {
	/** minutes between rounds */
	everyMinutes: number;
	/** off from this many players on */
	stopAt: number;
	/** broadcast after each round; '' for none */
	message: string;
	/** broadcast once, when a match goes live after the rule kept seeders on; '' for none */
	doneMessage: string;
}

export function validateAfkProtection(c: Record<string, unknown>): AfkProtectionConfig {
	return {
		everyMinutes: int(c.everyMinutes, AFK_DEFAULT_MINUTES, AFK_MIN_MINUTES, AFK_MAX_MINUTES),
		stopAt: int(c.stopAt, AFK_DEFAULT_STOP_AT, 2, 1000),
		message: str(c.message, MAX_CHAT),
		doneMessage: str(c.doneMessage, MAX_CHAT)
	};
}

/** The fingerprint a rule's rows carry: a row decided under other settings is not sent. */
export const afkSettingsKey = (cfg: AfkProtectionConfig): string => settingsFingerprint(cfg);

export interface AfkProtectionState {
	/** acting while the server seeds; false once a match was seen live, until an empty server or a restart */
	on: boolean;
	/** when `on` last changed */
	since: number;
	/** when the game started (from its uptime) as of the last change, 0 when unknown: a later start is a restart */
	startedAt: number;
	/** the first look of this stretch with anyone on; 0 while nobody is */
	seedingSince: number;
	/** the last round; 0 for none */
	roundAt: number;
	/** why it turned off ('a side scored', 'reached 20 (21 on)'); '' while on */
	why: string;
}

/** A state the rule wrote, or null for anything else (a rule switched on again has none). */
export function afkState(v: unknown): AfkProtectionState | null {
	if (!v || typeof v !== 'object') return null;
	const s = v as Record<string, unknown>;
	if (typeof s.on !== 'boolean') return null;
	const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
	return {
		on: s.on,
		since: n(s.since),
		startedAt: n(s.startedAt),
		seedingSince: n(s.seedingSince),
		roundAt: n(s.roundAt),
		why: typeof s.why === 'string' ? s.why : ''
	};
}

export interface AfkLook {
	now: number;
	/** players on: the most the status or the player list says */
	count: number;
	/** a side has scored */
	scored: boolean;
	/** when the game started, 0 when unknown */
	startedAt: number;
	/** this look took the player list, which a round needs */
	listed: boolean;
	/** the first look after the server was out of reach */
	recovered: boolean;
	/** how long the server has been seen empty; 0 while anyone is on */
	emptyFor: number;
}

export interface AfkStep {
	state: AfkProtectionState;
	/** a round of kills is due */
	round: boolean;
	/** the rule just turned off for a match going live after it kept seeders on: the thank-you */
	done: boolean;
	/** why the rule just turned off ('' when it did not) */
	off: string;
	/** the rule just turned back on */
	rearmed: boolean;
}

/**
 * One look at the server. A rule with no state (new, or switched on again) starts from what the look
 * shows. Off, it turns back on after AFK_REARM_EMPTY_MS empty or at a later game start, and only on
 * a look that shows no match on: a restart first seen with a match on is spent, so the empty list of
 * a later map change cannot turn it on. On, a score or the count reaching the goal turns it off;
 * otherwise, with anyone on, a round is due once `everyMinutes` have passed since the last round or
 * since this stretch began (the first player on, or the first look back after an outage), and only
 * on a look that took the player list.
 */
export function afkStep(
	cfg: Pick<AfkProtectionConfig, 'everyMinutes'>,
	prev: AfkProtectionState | null,
	look: AfkLook,
	goal: number
): AfkStep {
	const live = look.scored || look.count >= goal;
	const why = look.scored ? 'a side scored' : `reached ${goal} (${look.count} on)`;
	const off = (s: AfkProtectionState | null): AfkStep => ({
		state: {
			on: false,
			since: look.now,
			startedAt: look.startedAt,
			seedingSince: 0,
			roundAt: 0,
			why
		},
		round: false,
		// thanks only for a seed it kept going; back from an outage, nobody knows what happened
		done: !!s && s.on && s.roundAt > 0 && !look.recovered,
		off: why,
		rearmed: false
	});
	const keep = (state: AfkProtectionState, rearmed = false): AfkStep => ({
		state,
		round: false,
		done: false,
		off: '',
		rearmed
	});
	if (!prev) {
		if (live) return off(null);
		return keep({
			on: true,
			since: look.now,
			startedAt: look.startedAt,
			seedingSince: look.count > 0 ? look.now : 0,
			roundAt: 0,
			why: ''
		});
	}
	let s = prev;
	let rearmed = false;
	if (!s.on) {
		const restarted =
			look.startedAt > 0 && s.startedAt > 0 && look.startedAt - s.startedAt > RESTART_JUMP_MS;
		// A start first read after the rule turned off is kept, so a later restart is seen; one seen
		// with a match on is kept the same way, and turns nothing on.
		const learn = (restarted || !s.startedAt) && look.startedAt > 0;
		if (live || (!restarted && look.emptyFor < AFK_REARM_EMPTY_MS))
			return keep(learn ? { ...s, startedAt: look.startedAt } : s);
		s = {
			on: true,
			since: look.now,
			startedAt: look.startedAt,
			seedingSince: 0,
			roundAt: 0,
			why: ''
		};
		rearmed = true;
	}
	if (live) return off(s);
	if (look.count === 0) return keep(s.seedingSince ? { ...s, seedingSince: 0 } : s, rearmed);
	if (!s.seedingSince || look.recovered) s = { ...s, seedingSince: look.now };
	const due = look.now - Math.max(s.seedingSince, s.roundAt) >= cfg.everyMinutes * 60_000;
	if (!due || !look.listed) return keep(s, rearmed);
	return { state: { ...s, roundAt: look.now }, round: true, done: false, off: '', rearmed };
}

/** A sample, as the dry run replays it. */
export interface AfkSample {
	ts: number;
	ok: boolean;
	count: number;
	scores: { score: number }[];
}

export interface AfkReplayItem {
	at: number;
	/** a round (with the players on), or the rule turning off or back on */
	kind: 'round' | 'off' | 'on';
	count: number;
	why: string;
}

/**
 * The step over a run of samples, as if the rule had been switched on at the first. The samples
 * carry no game start, so only an empty stretch turns it back on; a failed sample is a look the
 * server was out of reach for.
 */
export function afkReplay(
	cfg: Pick<AfkProtectionConfig, 'everyMinutes'>,
	samples: AfkSample[],
	goal: number
): AfkReplayItem[] {
	const out: AfkReplayItem[] = [];
	let state: AfkProtectionState | null = null;
	let emptySince: number | null = null;
	let failed = false;
	for (const r of samples) {
		if (!r.ok) {
			failed = true;
			emptySince = null;
			continue;
		}
		if (r.count > 0) emptySince = null;
		else emptySince ??= r.ts;
		const step = afkStep(
			cfg,
			state,
			{
				now: r.ts,
				count: r.count,
				scored: r.scores.some((s) => s.score > 0),
				startedAt: 0,
				listed: true,
				recovered: failed,
				emptyFor: emptySince === null ? 0 : r.ts - emptySince
			},
			goal
		);
		failed = false;
		if (step.off) out.push({ at: r.ts, kind: 'off', count: r.count, why: step.off });
		if (step.rearmed) out.push({ at: r.ts, kind: 'on', count: r.count, why: '' });
		if (step.round) out.push({ at: r.ts, kind: 'round', count: r.count, why: '' });
		state = step.state;
	}
	return out;
}
