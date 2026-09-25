import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { assertRate } from '$lib/server/ratelimit';
import { deleteJsonWebhook, updateJsonWebhook } from '$lib/server/json-webhooks';

/** {label?, url?, events?, serverIds?, enabled?, signing?: "new"}; a new secret comes back once */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	// Each save of an address resolves it.
	assertRate(`json-webhook-save:${user.id}`, 20, 60_000);
	const body = await readJson(event.request);
	const updated = await updateJsonWebhook(
		env,
		event.request,
		user,
		org,
		param(event, 'webhookId'),
		body
	);
	return apiJson({ ok: true, ...updated });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteJsonWebhook(env, event.request, user, org, param(event, 'webhookId'));
	return apiJson({ ok: true });
});
