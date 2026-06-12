import { extractXhsNoteId } from "../../link-utils.mjs";
import { detectXhsMaterialKind } from "./material-kind.mjs";

export function normalizeXhsItem(item = {}) {
  const link = item.link || item.noteUrl || item.itemUrl || "";
  return {
    ...item,
    platformId: "xhs",
    id: item.id || item.noteId || extractXhsNoteId(link) || "",
    link,
    title: item.title || "",
    tags: item.tags || "",
    publishedAt: item.publishedAt || "",
    materialKind: detectXhsMaterialKind(item)
  };
}
