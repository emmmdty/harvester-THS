export function detectXhsMaterialKind(item = {}, manifest = {}) {
  const values = [
    item.materialKind,
    item.assetType,
    item.mediaType,
    item.itemType,
    item.type,
    item.noteType,
    manifest.materialKind,
    manifest.mediaType
  ].map((value) => String(value || "").trim().toLowerCase());

  if (values.some((value) => /video|视频|mp4|mov|m3u8/u.test(value))) return "视频";
  if (hasVideoAsset(item) || hasVideoAsset(manifest)) return "视频";
  return "图文";
}

function hasVideoAsset(value = {}) {
  if (!value || typeof value !== "object") return false;
  if (value.videoPath || value.videoUrl) return true;
  if (Array.isArray(value.videoUrls) && value.videoUrls.length > 0) return true;
  const assets = Array.isArray(value.assets) ? value.assets : [];
  return assets.some((asset) => {
    const kind = String(asset?.kind || asset?.type || asset?.mediaType || "").toLowerCase();
    const assetPath = String(asset?.path || asset?.url || "").toLowerCase();
    return /video|mp4|mov|m3u8/u.test(`${kind} ${assetPath}`);
  });
}
