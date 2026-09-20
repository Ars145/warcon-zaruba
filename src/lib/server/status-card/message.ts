// The Discord message the `card` style sends: a Components V2 container holding the banner and
// the two rendered pictures, the join code as a copyable block and a footer.
//
// Three things about this format, all established against the live webhook rather than assumed:
//   * a plain incoming webhook needs `with_components=true` in the query, or Discord ignores
//     `components` entirely and answers "Cannot send an empty message";
//   * under the Components V2 flag an uploaded file never appears in the message's `attachments`;
//     it is consumed into the component that named it, and its id comes back as `media.id`;
//   * an attachment cannot be kept across an edit by its id (400). It can be kept by passing the
//     CDN url it was given back as the media url: Discord fetches it and re-hosts it. That is how
//     the banner is uploaded once and carried from edit to edit instead of every minute.
import type { StatusCard } from './data';

/** IS_COMPONENTS_V2. With it set, `content` and `embeds` are refused. */
export const COMPONENTS_V2 = 32768;

const CONTAINER = 17;
const MEDIA_GALLERY = 12;
const TEXT_DISPLAY = 10;
const SEPARATOR = 14;

/** The orange the cards are drawn in, as the stripe down the container's left edge. */
const ACCENT = 0xff7d00;

export const SCORES_FILE = 'scores.png';
export const TOP_FILE = 'top.png';
export const BANNER_FILE = 'banner.webp';

export interface MessagePieces {
	/** the banner's CDN url from a previous message, or null to upload it afresh */
	bannerUrl: string | null;
}

/** Discord renders `<t:…:R>` itself, in each reader's own language, so the text never goes stale. */
const ago = (epochSeconds: number): string => `<t:${epochSeconds}:R>`;

export function statusPayload(card: StatusCard, pieces: MessagePieces): Record<string, unknown> {
	// One gallery per picture, not one gallery of three: Discord tiles a gallery's items into a
	// grid, which puts the banner down the left at full height and squeezes the other two into
	// thumbnails beside it. A gallery holding a single item draws it across the whole message.
	const body: Array<Record<string, unknown>> = [
		pieces.bannerUrl ?? `attachment://${BANNER_FILE}`,
		`attachment://${SCORES_FILE}`,
		`attachment://${TOP_FILE}`
	].map((url) => ({ type: MEDIA_GALLERY, items: [{ media: { url } }] }));
	if (card.joinCode)
		body.push({
			type: TEXT_DISPLAY,
			content: `Код входа\n\`\`\`\n${card.joinCode}\n\`\`\``
		});
	body.push({ type: SEPARATOR, divider: true, spacing: 1 });
	const footer = [
		card.startedAt === null ? null : `Сервер поднят ${ago(card.startedAt)}`,
		`Топ ${card.rows.length} из ${card.playersTotal} · обновлено ${ago(card.observedAt)}`
	].filter(Boolean);
	body.push({ type: TEXT_DISPLAY, content: footer.join('\n') });

	return {
		flags: COMPONENTS_V2,
		allowed_mentions: { parse: [] },
		components: [{ type: CONTAINER, accent_color: ACCENT, components: body }]
	};
}

/**
 * Which files go up with this message, and the `attachments` list naming them. The banner is in
 * both only while it has no url to be carried by.
 */
export function statusFiles(
	pictures: { scores: Uint8Array<ArrayBuffer>; top: Uint8Array<ArrayBuffer> },
	bannerBytes: Uint8Array<ArrayBuffer> | null
): {
	files: Array<{ name: string; bytes: Uint8Array<ArrayBuffer>; type: string }>;
	attachments: Array<Record<string, unknown>>;
} {
	const files = [
		...(bannerBytes ? [{ name: BANNER_FILE, bytes: bannerBytes, type: 'image/webp' }] : []),
		{ name: SCORES_FILE, bytes: pictures.scores, type: 'image/png' },
		{ name: TOP_FILE, bytes: pictures.top, type: 'image/png' }
	];
	return {
		files,
		attachments: files.map((f, id) => ({ id, filename: f.name }))
	};
}

/** The banner's url in a message Discord has just handed back, or null when it is not there. */
export function bannerUrlOf(message: unknown): string | null {
	const container = (message as { components?: Array<{ components?: unknown[] }> })
		?.components?.[0];
	// The banner is the first gallery's only item; the scores and the top follow in their own.
	const gallery = container?.components?.[0] as
		{ items?: Array<{ media?: { url?: string } }> } | undefined;
	return gallery?.items?.[0]?.media?.url ?? null;
}
