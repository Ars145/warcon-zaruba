// What the game takes in one chat line. Since WARDOGS update 0.1.2 (2026-09-30) the listener caps
// the text of a whisper (POST /v1/players/{id}/message) and of a broadcast (POST /v1/broadcast).
// Kick and ban reasons are not chat and keep their own cap.

/** The longest whisper or broadcast the game takes. */
export const MAX_CHAT = 256;
