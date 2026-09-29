// A short fingerprint of a rule's settings, the same whatever order their keys come in (the
// database's jsonb keeps its own). The rows a rule queues carry the one they were decided under, so
// delivery can tell a row decided before the settings changed (outbox.ts).
import { createHash } from 'node:crypto';

/** A value as JSON with every object's keys in order. */
const stable = (v: unknown): string =>
	Array.isArray(v)
		? `[${v.map(stable).join(',')}]`
		: v && typeof v === 'object'
			? `{${Object.keys(v)
					.sort()
					.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
					.join(',')}}`
			: JSON.stringify(v);

export const settingsFingerprint = (settings: unknown): string =>
	createHash('sha256').update(stable(settings)).digest('base64url').slice(0, 16);
