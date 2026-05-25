import "dotenv/config";

import { applyFeishuSubmissionTemplate } from "./feishu-template.mjs";

async function main() {
  const result = await applyFeishuSubmissionTemplate();
  console.log(`飞书投稿模板已应用，Step 1.5 工作表名称：抖音筛选结果`);
  console.log(`插入模板行：${JSON.stringify(result.inserted)}`);
  console.log(`重命名筛选表：${result.renamedStep15 ? "是" : "否"}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
