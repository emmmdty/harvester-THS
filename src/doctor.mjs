import "dotenv/config";
import { FeishuSheetsClient, loadFeishuConfig, validateFeishuConfig } from "./feishu-sheets.mjs";
import { DAILY_PLATFORM_IDS, getPlatformConfig } from "./platform-config.mjs";
import { runConfigChecks } from "./config-checks.mjs";

async function main() {
  const validation = validateFeishuConfig();
  if (!validation.ok) {
    console.error(validation.message);
    process.exitCode = 1;
    return;
  }

  const client = new FeishuSheetsClient(loadFeishuConfig());
  await client.getTenantAccessToken();
  console.log("飞书 tenant_access_token 获取成功。");

  let hasMissingHeaders = false;
  for (const platformId of DAILY_PLATFORM_IDS) {
    const config = getPlatformConfig(platformId);
    const result = await client.verifySheet(platformId);
    if (result.ok) {
      console.log(`${config.label} 工作表和表头检查通过。`);
    } else {
      hasMissingHeaders = true;
      if (!result.sheetExists) {
        console.error(`${config.label} 工作表不存在，请检查对应 FEISHU_SHEET_* 的 sheet_id。`);
      } else {
        console.error(`${config.label} 表头不匹配，缺少或顺序错误：${result.missingHeaders.join("、")}`);
      }
    }
  }

  if (hasMissingHeaders) process.exitCode = 1;

  const configChecks = await runConfigChecks();
  for (const check of configChecks.checks) {
    const line = `配置检测 ${check.id}：${check.message}`;
    if (check.status === "ok") console.log(line);
    else if (check.status === "warn") console.warn(line);
    else console.error(line);
  }
  if (!configChecks.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
