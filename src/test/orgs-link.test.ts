// The header's Orgs link, worked out from what userOrgs gives each of the cast: it opens the one
// org someone is in only where that org's pages let them in, and otherwise stays on the list.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { userOrgs } from '$lib/server/access';
import { orgsLink } from '$lib/orgs';
import { hasTestDb, testEnv } from './db';
import { callLoad, stubGateway } from './call';
import { seedWorld, suspend, type PrincipalName, type World } from './world';

const ORGS = join(import.meta.dir, '..', 'routes', '(app)', 'orgs');

/** The org layout and the page an org path names, loaded as `who`: 'ok' or the refusal's status. */
async function opens(world: World, who: PrincipalName, href: string): Promise<(number | 'ok')[]> {
	const [, id, sub = ''] = href.match(/^\/orgs\/([^/]+)(\/[a-z]+)?$/)!;
	const answers: (number | 'ok')[] = [];
	for (const file of ['[id]/+layout.server.ts', `[id]${sub}/+page.server.ts`]) {
		const { load } = await import(join(ORGS, file));
		const res = await callLoad(load, world.users[who], { params: { id: decodeURIComponent(id) } });
		answers.push(res.status === 200 ? 'ok' : res.status);
	}
	return answers;
}

describe.skipIf(!hasTestDb)('the Orgs link', () => {
	let env: Env;
	let world: World;
	const linkOf = async (w: World, who: PrincipalName) => {
		const user = w.users[who]!;
		return orgsLink(await userOrgs(env, user), user.role === 'owner');
	};

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		world = await seedWorld(env);
	});

	test("opens someone's only org, on a page that lets them in", async () => {
		const org = `/orgs/${world.org.id}`;
		const want: Partial<Record<PrincipalName, string>> = {
			stranger: '/orgs',
			outsider: `/orgs/${world.otherOrg.id}`,
			member: '/orgs',
			viewer: '/orgs',
			operator: '/orgs',
			admin: `${org}/bans`,
			elsewhere: `${org}/bans`,
			orgBans: `${org}/bans`,
			orgSlots: `${org}/reserved`,
			owner: org,
			site: '/orgs'
		};
		const got: Partial<Record<PrincipalName, string>> = {};
		for (const who of Object.keys(want) as PrincipalName[]) got[who] = await linkOf(world, who);
		expect(got).toEqual(want);
		for (const [who, href] of Object.entries(got) as [PrincipalName, string][]) {
			if (href === '/orgs') continue;
			expect({ who, answers: await opens(world, who, href) }).toEqual({
				who,
				answers: ['ok', 'ok']
			});
		}
	});

	test('stays on the list when their only org is suspended', async () => {
		const w = await seedWorld(env);
		await suspend(env, w.org.id);
		// what the link would have opened refuses them
		expect(await opens(w, 'owner', `/orgs/${w.org.id}`)).toEqual([403, 403]);
		for (const who of ['owner', 'admin', 'orgBans', 'orgSlots'] as const)
			expect({ who, link: await linkOf(w, who) }).toEqual({ who, link: '/orgs' });
		expect(await linkOf(w, 'outsider')).toBe(`/orgs/${w.otherOrg.id}`);
	});
});
