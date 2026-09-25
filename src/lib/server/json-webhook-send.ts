// Sends one event to one JSON webhook: the signature and the POST, made to an address the host
// policy has just checked, with the socket pinned to what that check approved. The address and
// the signing secret are decrypted here and nowhere else. Nothing a receiver answers is kept but
// its status code, and a failure is told as one of a few fixed phrases, never the runtime's own
// text (which can quote the address). The records live in json-webhooks.ts, the events in
// json-webhook-events.ts, the queue that calls this in json-webhook-queue.ts.
import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { jsonWebhooks, type JsonWebhookRow } from './db/schema';
import { decryptSecret } from './crypto';
import { ApiError } from './http';
import { assertReachableTarget, normaliseHost, pinnedAddresses, type Resolved } from './hostpolicy';
import { forAuthority, neverOpened, reasonOf } from './transport';

/** How long a receiver has to answer. */
const TIMEOUT_MS = 5000;
/** How long the address check may take: a resolver that never answers is no answer too. */
const RESOLVE_MS = 3000;

class TimedOut extends Error {}

/** Address checks in flight at most, in this process: see sharedCheck. */
const MAX_CHECKS = 8;
const checking = new Map<string, Promise<Resolved[]>>();

/**
 * The address check for `host`, shared by every send that asks while one is running. A lookup
 * outlives our wait for it (the resolver's own timeout ends it), so a host whose resolver never
 * answers must not start a new one per attempt: one per host, and at most MAX_CHECKS in all, so
 * they never crowd out the lookups the game servers need. Past the cap a send fails as having no
 * answer, and is tried again later.
 */
export function sharedCheck(
	host: string,
	allowPrivate: boolean,
	check: (host: string, allowPrivate: boolean) => Promise<Resolved[]> = assertReachableTarget
): Promise<Resolved[]> {
	const key = `${allowPrivate ? 'p' : 'o'}:${host}`;
	const running = checking.get(key);
	if (running) return running;
	if (checking.size >= MAX_CHECKS) return Promise.reject(new TimedOut());
	const started = check(host, allowPrivate).finally(() => checking.delete(key));
	checking.set(key, started);
	return started;
}

/** `work`, or a TimedOut after `ms`; the work itself is left to finish on its own. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new TimedOut()), ms);
		})
	]).finally(() => clearTimeout(timer));
}

export interface Endpoint {
	/** canonical: https, the host as normaliseHost writes it, the port only when not 443 */
	url: string;
	host: string;
	port: number;
	/** path and query */
	path: string;
	/** what the panel shows instead of the address: host, and port when not 443 */
	hint: string;
}

/**
 * An address a JSON webhook may be saved with: https, no user name or password in it, a hostname
 * or an IP literal. The path may carry the receiver's own token, which is why only the host is
 * ever shown. Throws a 400 otherwise.
 */
export function parseEndpointUrl(raw: unknown): Endpoint {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (!text) throw new ApiError(400, 'The address is required.');
	if (text.length > 500)
		throw new ApiError(400, 'That address is too long (500 characters at most).');
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw new ApiError(400, 'That is not a URL.');
	}
	if (u.protocol !== 'https:')
		throw new ApiError(400, 'A JSON webhook address must start with https://.');
	if (u.username || u.password)
		throw new ApiError(400, 'Leave the user name and password out of the address.');
	const host = normaliseHost(u.hostname);
	const port = u.port ? Number(u.port) : 443;
	if (port === 0) throw new ApiError(400, 'That is not a port an address can use.');
	const path = (u.pathname || '/') + u.search;
	const shown = port === 443 ? host : `${host}:${port}`;
	return { url: `https://${shown}${path}`, host, port, path, hint: `${shown}/…` };
}

/** A new signing secret: shown once when it is made, then kept only as ciphertext. */
export const newSigningSecret = (): string => `whsec_${randomBytes(24).toString('hex')}`;

/** The X-Warcon-Signature value: HMAC-SHA256 of "<unix seconds>.<body>" under the secret. */
export function signature(secret: string, body: string, t: number): string {
	return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export interface SendResult {
	ok: boolean;
	/** the receiver's status code; null when none came back */
	status: number | null;
	/** '' when delivered, else one of a few fixed phrases */
	error: string;
	/** worth sending again later: no answer, a 429 or a 5xx */
	retry: boolean;
}

function answered(status: number): SendResult {
	if (status >= 200 && status < 300) return { ok: true, status, error: '', retry: false };
	if (status >= 300 && status < 400)
		return {
			ok: false,
			status,
			error: `Answered ${status}; redirects are not followed.`,
			retry: false
		};
	return {
		ok: false,
		status,
		error: `Answered ${status}.`,
		retry: status === 429 || status >= 500
	};
}

/**
 * POSTs one event to one JSON webhook. The address is checked again first, so a name that has
 * re-pointed at a private or link-local address is refused, and the socket opens only onto an
 * address that check approved (the host still travels as the Host header and the TLS name). No
 * redirect is followed and the reply's body is never read. At most RESOLVE_MS for the check and
 * TIMEOUT_MS for the answer. Never throws.
 */
export async function sendEvent(
	env: Env,
	hook: Pick<JsonWebhookRow, 'urlEnc' | 'secretEnc' | 'allowPrivate'>,
	event: string,
	id: string,
	body: string
): Promise<SendResult> {
	let endpoint: Endpoint;
	let secret: string;
	try {
		endpoint = parseEndpointUrl(decryptSecret(env, hook.urlEnc));
		secret = decryptSecret(env, hook.secretEnc);
	} catch {
		return { ok: false, status: null, error: 'The saved address cannot be read.', retry: false };
	}
	let addresses: string[];
	try {
		addresses = pinnedAddresses(
			endpoint.host,
			await within(sharedCheck(endpoint.host, hook.allowPrivate), RESOLVE_MS)
		);
	} catch (err) {
		if (err instanceof TimedOut)
			return { ok: false, status: null, error: 'The host did not resolve in time.', retry: true };
		if (err instanceof ApiError && err.code === 'unresolvable')
			return { ok: false, status: null, error: 'The host does not resolve.', retry: true };
		return {
			ok: false,
			status: null,
			error: 'The address is not one Warcon may send to.',
			retry: false
		};
	}
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'user-agent': 'Warcon-Webhook/1',
		'x-warcon-event': event,
		'x-warcon-delivery': id,
		'x-warcon-signature': signature(secret, body, Math.floor(Date.now() / 1000))
	};
	const bare = endpoint.host.replace(/^\[|\]$/g, '');
	const authority = endpoint.port === 443 ? endpoint.host : `${endpoint.host}:${endpoint.port}`;
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	for (let i = 0; i < addresses.length; i++) {
		// A pinned address is one that is not the host text itself: the hostname then goes as the
		// Host header and, over TLS, as the server name the certificate is checked against.
		const pinned = addresses[i] !== bare;
		const request: BunFetchRequestInit = {
			method: 'POST',
			headers: pinned ? { ...headers, host: authority } : headers,
			body,
			signal,
			redirect: 'manual'
		};
		if (pinned) request.tls = { serverName: bare };
		try {
			const res = await fetch(
				`https://${pinned ? forAuthority(addresses[i]) : endpoint.host}:${endpoint.port}${endpoint.path}`,
				request
			);
			await res.body?.cancel().catch(() => {});
			return answered(res.status);
		} catch (err) {
			// The next approved address only when this one never opened: a request that may have
			// reached the receiver is not sent again now, only by a later attempt it can dedupe.
			const name = (err as { name?: string }).name;
			const timedOut = signal.aborted || name === 'TimeoutError' || name === 'AbortError';
			if (timedOut || !neverOpened(err) || i === addresses.length - 1) {
				const why = reasonOf(err, timedOut);
				return {
					ok: false,
					status: null,
					error: why ? `Could not deliver (${why}).` : 'Could not deliver.',
					retry: true
				};
			}
		}
	}
	return { ok: false, status: null, error: 'Could not deliver.', retry: true };
}

/** Records the last send on the webhook for its owners: the status code, or the phrase. */
export async function noteResult(db: DbOrTx, webhookId: string, result: SendResult): Promise<void> {
	await db
		.update(jsonWebhooks)
		.set({
			lastSentAt: result.ok ? new Date() : undefined,
			lastStatus: result.status,
			lastError: result.ok ? '' : result.error
		})
		.where(eq(jsonWebhooks.id, webhookId));
}
