<script lang="ts">
	// Sets or clears the expiry of one org-list or reserved-slot group entry. A list
	// keeps entries, so this is also the only place an expiry can be changed:
	// a slot written straight into a server's config document has no record to
	// expire.
	import { untrack } from 'svelte';
	import Modal from './Modal.svelte';
	import { api, errorMessage } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { describeSync, expiryIso, EXPIRY_OPTIONS } from '$lib/lists';
	import { fmtTime } from '$lib/format';
	import type { ListKind, ListSyncSummary } from '$lib/types';

	let {
		orgId,
		kind,
		groupId = null,
		steamId,
		name = null,
		expiresAt = null,
		onclose,
		onsaved
	}: {
		orgId: string;
		kind: ListKind;
		/** The reserved-slot group being edited; null for the org's default list. */
		groupId?: string | null;
		steamId: string;
		/** shown in the title when the player has been seen on a server */
		name?: string | null;
		/** the expiry in force now, ISO, null when the entry is permanent */
		expiresAt?: string | null;
		onclose: () => void;
		onsaved: () => Promise<void> | void;
	} = $props();

	/** An ISO timestamp as the local wall-clock value a datetime-local input wants. */
	function toLocalInput(iso: string): string {
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// The dialog is created fresh for each entry, so the expiry in force is read once here and the
	// form owns it from then on.
	const opened = untrack(() => expiresAt);
	let choice = $state(opened ? 'custom' : '0');
	let custom = $state(opened ? toLocalInput(opened) : '');
	let busy = $state(false);

	let label = $derived(name ? `${name} (${steamId})` : steamId);
	let path = $derived(
		groupId
			? `/api/orgs/${encodeURIComponent(orgId)}/slot-groups/${encodeURIComponent(groupId)}/entries/${encodeURIComponent(steamId)}`
			: `/api/orgs/${encodeURIComponent(orgId)}/lists/${kind}/entries/${encodeURIComponent(steamId)}`
	);

	async function save() {
		const next = expiryIso(choice, custom);
		busy = true;
		try {
			const res = await api<{ sync: ListSyncSummary }>('PATCH', path, { expiresAt: next });
			toast(
				describeSync(
					res.sync,
					next ? `${label} now runs until ${fmtTime(next)}.` : `${label} is now permanent.`
				),
				'ok',
				8000
			);
			onclose();
			await onsaved();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<Modal title="Expiry for {label}" {onclose}>
	<form
		class="space-y-3"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<label class="block"
			><span class="field-label">Expires</span><select class="input" bind:value={choice}>
				{#each EXPIRY_OPTIONS as [value, text] (value)}
					<option {value}>{text}</option>
				{/each}
			</select></label
		>
		{#if choice === 'custom'}
			<label class="block"
				><span class="field-label">Until (local time)</span><input
					class="input"
					type="datetime-local"
					bind:value={custom}
					required
				/></label
			>
		{/if}
		<p class="note">
			A term counts from now, not from the date in force. When it passes the panel withdraws the
			entry on every server it was applied to and keeps it in the history.
		</p>
		<div class="flex justify-end gap-2 pt-2">
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
		</div>
	</form>
</Modal>
