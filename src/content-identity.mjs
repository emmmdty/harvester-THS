import { formatDate } from "./date-utils.mjs";

export function publishedDateFromXhsNoteId(noteId) {
  const text = String(noteId || "").trim();
  const match = text.match(/^([0-9a-f]{8})[0-9a-f]*$/iu);
  if (!match) return "";
  const seconds = Number.parseInt(match[1], 16);
  return publishedDateFromUtcSeconds(seconds);
}

export function publishedDateFromDouyinItemId(itemId) {
  const text = String(itemId || "").trim();
  if (!/^\d{8,}$/u.test(text)) return "";
  const seconds = BigInt(text) >> 32n;
  if (seconds < 1_000_000_000n || seconds > 2_200_000_000n) return "";
  return publishedDateFromUtcSeconds(Number(seconds));
}

export function publishedDateFromBilibiliBv() {
  return "";
}

function publishedDateFromUtcSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return formatDate(new Date(seconds * 1000), "Asia/Shanghai");
}
