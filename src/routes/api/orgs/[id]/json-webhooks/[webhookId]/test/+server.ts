import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { assertRate } from '$lib/server/ratelimit';
import { testJsonWebhook } from '$lib/server/json-webhooks';

export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	assertRate(`json-webhook-test:${user.id}`, 10, 60_000);
	const result = await testJsonWebhook(env, event.request, user, org, param(event, 'webhookId'));
	return apiJson({ ok: result.ok, result }, result.ok ? 200 : 502);
});
