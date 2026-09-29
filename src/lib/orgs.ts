// Browser-side helpers for organisations as the signed-in person sees them.
import type { ListKind, OrgRole, OrgView } from './types';

/** An org as the header's list (OrgSummary) or a row of the Orgs page carries it. */
export interface OrgEntry {
	id: string;
	role: OrgRole;
	suspended: boolean | OrgView['suspended'];
	/** the org lists their roles open */
	listKinds: readonly ListKind[];
}

/**
 * The org page someone lands on: the overview for an owner, else the first list their roles
 * open; null when no page of it opens for them (a member without a list, or a suspended org).
 */
export function orgHome(org: OrgEntry, siteOwner: boolean): string | null {
	const base = `/orgs/${encodeURIComponent(org.id)}`;
	if (org.role === 'owner' && (!org.suspended || siteOwner)) return base;
	if (org.listKinds.includes('ban')) return `${base}/bans`;
	if (org.listKinds.includes('reserve')) return `${base}/reserved`;
	return null;
}

/**
 * Where the header's Orgs link goes: straight to the page of someone's only org, when one opens
 * for them, else the list. The site owner keeps the list, where orgs are made and suspended.
 */
export function orgsLink(orgs: readonly OrgEntry[], siteOwner: boolean): string {
	if (siteOwner || orgs.length !== 1) return '/orgs';
	return orgHome(orgs[0], false) ?? '/orgs';
}
