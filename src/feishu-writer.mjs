import fs from "node:fs/promises";
import { FeishuSheetsClient, loadFeishuConfig, writeDailyPlatformRecords } from "./feishu-sheets.mjs";
import { getPlatformConfig, outputJsonPath } from "./platform-config.mjs";
import { enumerateDateStrings } from "./date-utils.mjs";

export async function readPlatformItems(platformId, sinceDate, root = process.cwd(), untilDate = sinceDate, { accountName = "" } = {}) {
  const filePath = outputJsonPath(platformId, sinceDate, root, untilDate, { accountName });
  const text = await fs.readFile(filePath, "utf8").catch((error) => {
    throw new Error(`未找到 ${getPlatformConfig(platformId).label} JSON 输出：${filePath}。原始错误：${error.message}`);
  });
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.items)) {
    throw new Error(`${filePath} 缺少 items 数组。`);
  }
  return parsed.items;
}

export async function writePlatformJsonToFeishu({
  platformId,
  targetDate = "",
  sinceDate = targetDate,
  untilDate = targetDate || sinceDate,
  accountName = "",
  root = process.cwd(),
  client = null,
  items: providedItems = null
}) {
  const items = Array.isArray(providedItems)
    ? providedItems
    : await readPlatformItems(platformId, sinceDate, root, untilDate, { accountName });
  const writer = client || new FeishuSheetsClient(loadFeishuConfig());
  const warnings = [];
  await configureDropdownsIfAvailable(writer, platformId, warnings);
  const byDate = [];
  let total = 0;
  let created = 0;
  let skipped = 0;
  let updated = 0;

  for (const date of enumerateDateStrings(sinceDate, untilDate)) {
    const dateItems = items.filter((item) => item.publishedAt === date);
    const result = await writeDailyPlatformRecords({
      platformId,
      targetDate: date,
      items: dateItems,
      client: writer
    });
    total += result.total;
    created += result.created;
    skipped += result.skipped;
    updated += result.updated || 0;
    byDate.push({ date, collected: dateItems.length, ...result });
  }
  if (created > 0) {
    await configureDropdownsIfAvailable(writer, platformId, warnings);
  }

  return {
    collected: items.length,
    feishu: {
      total,
      created,
      skipped,
      updated,
      byDate,
      warnings
    }
  };
}

async function configureDropdownsIfAvailable(writer, platformId, warnings) {
  if (typeof writer.configurePlatformDropdowns !== "function") return;
  try {
    await writer.configurePlatformDropdowns(platformId);
  } catch (error) {
    warnings.push(`下拉选项配置失败，已跳过：${error.message || String(error)}`);
  }
}
