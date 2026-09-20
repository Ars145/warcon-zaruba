// The Discord message the `card` style sends: a Components V2 container holding the banner and
// the two rendered pictures, the join code as a copyable block and a footer.
//
// Three things about this format, all established against the live webhook rather than assumed:
//   * a plain incoming webhook needs `with_components=true` in the query, or Discord ignores
//     `components` entirely and answers "Cannot send an empty message";
//   * under the Components V2 flag an uploaded file never appears in the message's `attachments`;
//     it is consumed into the component that named it, and its id comes back as `media.id`;
//   * a picture cannot be carried from one edit to the next. Not by attachment id (400), and not
//     by handing back the CDN url either: that answers 200 and returns a fresh media id, but the
//     edit which dropped the old attachment took the file with it, so the url 404s and the reader
//     sees a broken frame. Every picture goes up on every edit, which is why they are kept small.
import type { StatusCard } from './data';

/** IS_COMPONENTS_V2. With it set, `content` and `embeds` are refused. */
export const COMPONENTS_V2 = 32768;

const CONTAINER = 17;
const MEDIA_GALLERY = 12;
const TEXT_DISPLAY = 10;
const SEPARATOR = 14;

/** The orange the cards are drawn in, as the stripe down the container's left edge. */
const ACCENT = 0xff7d00;

export const SCORES_FILE = 'scores.webp';
export const TOP_FILE = 'top.webp';
export const BANNER_FILE = 'banner.webp';

/** Discord renders `<t:…:R>` itself, in each reader's own language, so the text never goes stale. */
const ago = (epochSeconds: number): string => `<t:${epochSeconds}:R>`;

export function statusPayload(card: StatusCard): Record<string, unknown> {
	// One gallery per picture, not one gallery of three: Discord tiles a gallery's items into a
	// grid, which puts the banner down the left at full height and squeezes the other two into
	// thumbnails beside it. A gallery holding a single item draws it across the whole message.
	const body: Array<Record<string, unknown>> = [BANNER_FILE, SCORES_FILE, TOP_FILE].map((file) => ({
		type: MEDIA_GALLERY,
		items: [{ media: { url: `attachment://${file}` } }]
	}));
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

/** The three files that go up with this message, and the `attachments` list naming them. */
export function statusFiles(
	pictures: { scores: Uint8Array<ArrayBuffer>; top: Uint8Array<ArrayBuffer> },
	bannerBytes: Uint8Array<ArrayBuffer>
): {
	files: Array<{ name: string; bytes: Uint8Array<ArrayBuffer>; type: string }>;
	attachments: Array<Record<string, unknown>>;
} {
	const files = [
		{ name: BANNER_FILE, bytes: bannerBytes, type: 'image/webp' },
		{ name: SCORES_FILE, bytes: pictures.scores, type: 'image/webp' },
		{ name: TOP_FILE, bytes: pictures.top, type: 'image/webp' }
	];
	return {
		files,
		attachments: files.map((f, id) => ({ id, filename: f.name }))
	};
}
