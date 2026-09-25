import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { assertRate } from '$lib/server/ratelimit';
import { createJsonWebhook, listJsonWebhooks } from '$lib/server/json-webhooks';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, webhooks: await listJsonWebhooks(env, org.id) });
});

/** {label, url, events[], serverIds[]|null, enabled}; the answer carries the signing secret, once */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	// Each save of an address resolves it.
	assertRate(`json-webhook-save:${user.id}`, 20, 60_000);
	const body = await readJson(event.request);
	const made = await createJsonWebhook(env, event.request, user, org, body);
	return apiJson({ ok: true, ...made }, 201);
});
