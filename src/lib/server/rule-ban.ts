// A ban a rule places: the player goes on this server's own ban list, or the organisation's, as if
// an admin had added them there, and the panel's ban enforcement removes them from the server at
// its next look (kickBanned in lists-sync.ts). The rule sends nothing to the game itself; outbox.ts
// delivers the row. Any rule that bans uses this action, so what it needs of whoever saves the
// rule is the same as a ban by hand.
import type { Capability } from '$lib/capabilities';

/** The outbox action of a rule's ban: a panel action, nothing is sent to the game. */
export const PANEL_BAN = 'panel_ban';

/** Which ban list: this server's own, or the organisation's (every server). */
export type BanScope = 'server' | 'org';

export interface PanelBanParams {
	steamId: string;
	name: string;
	/** the ban's reason, as the ban list and the organisation's ban message show it */
	reason: string;
	/** how long the ban lasts; 0 is for good */
	days: number;
	scope: BanScope;
}

/** What a rule that bans needs of whoever saves it: what a ban by hand on that list needs. */
export const banNeeds = (scope: BanScope): [Capability, string] =>
	scope === 'org'
		? ['lists.ban', "edits the organisation's ban list"]
		: ['bans.manage', 'bans players on this server'];
