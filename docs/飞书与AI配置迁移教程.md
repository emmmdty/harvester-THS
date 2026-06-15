# 飞书与 AI 配置迁移教程

这份教程用于给作品采集器完成首次配置、迁移到新的飞书表格，或者更换飞书和 AI 配置。读者不需要会写代码，但需要能登录飞书开放平台、目标飞书表格，以及 MiniMax、DeepSeek、阿里云百炼/DashScope 控制台。

请不要把 `App Secret`、`API Key`、`.env` 文件截图发到群里。需要找人协助时，只发报错文字、字段名和不包含密钥的链接。

## 1. 先准备这些账号和权限

开始前先确认手里有这些东西：

1. 一个可以管理目标飞书企业应用的飞书账号。
2. 一个目标飞书普通电子表格，不是多维表格 Base。
3. 目标表格的编辑权限。
4. 可以运行作品采集器的电脑。
5. MiniMax、DeepSeek、阿里云百炼/DashScope 的账号，或者由管理员创建好的 API Key。

常用网页入口：

| 用途 | 打开的网页 |
| --- | --- |
| 飞书开放平台 | <https://open.feishu.cn/> |
| 飞书电子表格 API 文档 | <https://open.feishu.cn/document/server-docs/docs/sheets-v3/overview?lang=zh-CN> |
| 飞书权限列表 | <https://open.feishu.cn/document/ukTMukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list?lang=zh-CN> |
| MiniMax 控制台 | <https://platform.minimaxi.com/> |
| MiniMax API Key 文档 | <https://platform.minimax.io/docs/guides/quickstart-preparation> |
| DeepSeek 平台 | <https://platform.deepseek.com/> |
| DeepSeek API Key 文档 | <https://api-docs.deepseek.com/zh-cn/api/deepseek-api> |
| 阿里云百炼 API Key 文档 | <https://help.aliyun.com/zh/model-studio/get-api-key> |

## 2. 创建或确认飞书自建应用

如果只是更换到同一个飞书企业里的另一张表，可以继续使用已有自建应用。只有迁移到新的飞书企业/租户时，才必须重新创建应用。

### 2.1 打开飞书开放平台

1. 打开 <https://open.feishu.cn/>。
2. 点击右上角登录，使用目标飞书企业账号登录。
3. 进入“开发者后台”或“控制台”。
4. 选择目标企业。

### 2.2 创建企业自建应用

1. 在应用列表里点击“创建应用”。
2. 应用类型选择“企业自建应用”。
3. 应用名称可以填：`作品采集器`。
4. 应用描述可以填：`用于作品采集器写入飞书普通电子表格`。
5. 创建完成后进入应用详情页。

### 2.3 获取 App ID 和 App Secret

1. 在应用详情里找到“凭证与基础信息”或“应用凭证”。
2. 复制 `App ID`，后面填到项目的 `App ID`。
3. 复制 `App Secret`，后面填到项目的 `App Secret`。

示例格式：

```text
App ID: cli_xxxxxxxxxxxxxxxx
App Secret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

不要把真实 `App Secret` 发到聊天群或截图里。

### 2.4 开通飞书表格权限

在应用详情里找到“权限管理”或“权限配置”，搜索并申请电子表格相关权限。这个项目需要读写和管理普通电子表格，不是只读。

至少要覆盖这些能力：

1. 读取电子表格信息和工作表列表。
2. 读取单元格内容。
3. 写入、追加、插入单元格和行。
4. 设置下拉选项、样式、冻结行、合并单元格。
5. 创建或重命名工作表。

如果目标表格在飞书知识库 Wiki 里，还需要开通 Wiki 节点读取权限。新手优先使用普通表格链接，不建议一开始使用 Wiki Token。

权限申请后，按飞书页面提示提交发布或管理员审核。权限没有生效前，项目检测会失败。

### 2.5 让应用能访问目标表格

打开目标飞书电子表格，确认应用或应用所在企业可以访问这张表。最稳的做法是：

1. 打开目标飞书表格。
2. 点击右上角“分享”或“权限”。
3. 确认表格对当前企业成员可编辑，或把应用/机器人加入可编辑协作者。
4. 如果企业安全策略较严格，让飞书管理员确认该自建应用可以访问这份文档。

如果权限不足，常见表现是：App ID 和 App Secret 正确，但检测配置时提示没有权限、找不到表格、找不到工作表，或者 API 返回 forbidden/permission denied。

## 3. 准备飞书普通电子表格

项目当前对接的是飞书普通电子表格，不是飞书多维表格 Base。不要把 Base 链接填进项目。

建议表格至少包含这些工作表：

1. `抖音渠道`
2. `小红书渠道`
3. `B站渠道`
4. `抖音筛选结果`
5. `抖音历史台账`
6. `小红书历史台账`
7. `B站历史台账`

前三个是面板必填工作表。后四个用于 Step 1.5 和历史台账；如果当前交付包已经带好 `.env`，这些可能已经填好。

## 4. 获取 Spreadsheet Token

`Spreadsheet Token` 是整张普通电子表格的 token。

1. 打开目标飞书普通电子表格。
2. 看浏览器地址栏。
3. 找到类似下面的链接：

```text
https://example.feishu.cn/sheets/shtcnxxxxxxxxxxxxxxxxxxxxxx
```

4. `/sheets/` 后面的这一段就是 `Spreadsheet Token`：

```text
shtcnxxxxxxxxxxxxxxxxxxxxxx
```

后面在采集器面板里填到 `Spreadsheet Token`。如果你看到的是知识库链接，例如 URL 中有 `/wiki/`，优先打开知识库里的原始电子表格链接；只有无法拿到普通表格链接时，才使用 `Wiki Token`。

## 5. 获取每个工作表的 Sheet ID

`Sheet ID` 是某个具体工作表页签的 ID，不是工作表名称，也不是整张表格的 token。

1. 打开目标飞书表格。
2. 点击底部页签，例如 `抖音渠道`。
3. 查看浏览器地址栏。
4. 常见地址会带有 `sheet=`、`gid=` 或类似片段。复制当前页签对应的 ID。

示例：

```text
https://example.feishu.cn/sheets/shtcnxxxxxxxxxxxx?sheet=1qb4UU
```

这里的 `1qb4UU` 就是这个页签的 `Sheet ID`。

需要记录这些值：

```text
抖音渠道 Sheet ID: 1xxxxx
小红书渠道 Sheet ID: 2xxxxx
B站渠道 Sheet ID: 3xxxxx
抖音筛选结果 Sheet ID: 4xxxxx
抖音历史台账 Sheet ID: 5xxxxx
小红书历史台账 Sheet ID: 6xxxxx
B站历史台账 Sheet ID: 7xxxxx
```

如果看不到明显的 `sheet=` 参数，可以把表格链接发给技术同事处理，但不要附带 App Secret 或 API Key。

## 6. 在采集器网页面板填写飞书配置

这个方法适合填写或更换面板已经支持的配置：飞书、MiniMax、DeepSeek。

### 6.1 打开本地采集器

1. 在项目文件夹里双击启动脚本。
2. macOS 双击：

```text
启动作品采集面板.command
```

3. Windows 双击：

```text
启动作品采集面板.cmd
```

4. 浏览器会自动打开：

```text
http://127.0.0.1:3000/
```

如果 3000 端口被占用，启动脚本可能会打开 3001 到 3010 之间的其它端口。以自动打开的网页为准。

### 6.2 打开设置

1. 在采集器网页里找到“设置”。
2. 进入“飞书”配置区域。
3. 按下面字段填写。

| 面板字段 | 填什么 |
| --- | --- |
| `App ID` | 飞书自建应用的 App ID，例如 `cli_xxx` |
| `App Secret` | 飞书自建应用的 App Secret |
| `Spreadsheet Token` | 普通飞书表格 token，例如 `shtcnxxx` |
| `Wiki Token` | 一般留空；只有知识库表格场景才填 |
| `抖音 Sheet ID` | `抖音渠道` 页签的 Sheet ID |
| `小红书 Sheet ID` | `小红书渠道` 页签的 Sheet ID |
| `B站 Sheet ID` | `B站渠道` 页签的 Sheet ID |

填完后点击“保存设置”。

### 6.3 检测飞书配置

1. 仍在设置页点击“检测配置”。
2. 看到类似“飞书配置可用，已读取到 X 个工作表”说明飞书配置基本可用。
3. 如果提示找不到某个 Sheet ID，回到第 5 节重新核对对应页签 ID。
4. 如果提示权限不足，回到第 2.4 和第 2.5 节检查应用权限和表格授权。

## 7. 配置 MiniMax API Key

MiniMax 在当前项目里主要用于多模态/内容分类，特别是需要结合视频抽帧、图片或页面截图判断内容类型的场景。

### 7.1 获取 MiniMax API Key

1. 打开 <https://platform.minimaxi.com/>。
2. 登录 MiniMax 账号。
3. 进入 API Key、密钥管理或开发者配置页面。
4. 创建新的 API Key。
5. 复制 API Key，只复制一次并妥善保存。

可以参考官方准备文档：<https://platform.minimax.io/docs/guides/quickstart-preparation>。

### 7.2 在采集器面板填写 MiniMax

打开采集器网页的“设置”区域，在“AI”配置里填写：

| 面板字段 | 推荐值 |
| --- | --- |
| `MiniMax API Key` | 你的 MiniMax API Key，例如 `sk-xxx` |
| `MiniMax Base URL` | `https://api.minimaxi.com/v1` |
| `MiniMax Model` | `MiniMax-M3` |

填完后点击“保存设置”，再点“检测配置”。检测成功会提示 MiniMax key 可用；余额仍以 MiniMax 控制台为准。

## 8. 配置 DeepSeek API Key

DeepSeek 在当前项目里主要用于文本兜底分类。当 MiniMax 不可用或只需要文本判断时，会使用 DeepSeek 相关配置。

### 8.1 获取 DeepSeek API Key

1. 打开 <https://platform.deepseek.com/>。
2. 登录 DeepSeek 账号。
3. 进入 API Keys 或 API 密钥页面。
4. 创建新的 API Key。
5. 复制 API Key，并确认账号余额可用。

可以参考官方文档：<https://api-docs.deepseek.com/zh-cn/api/deepseek-api>。

### 8.2 在采集器面板填写 DeepSeek

打开采集器网页的“设置”区域，在“AI”配置里填写：

| 面板字段 | 推荐值 |
| --- | --- |
| `DeepSeek API Key` | 你的 DeepSeek API Key，例如 `sk-xxx` |
| `DeepSeek Base URL` | `https://api.deepseek.com` |
| `DeepSeek Model` | `deepseek-v4-flash` |

填完后点击“保存设置”，再点“检测配置”。检测成功会提示 DeepSeek 可用；如果提示余额不可用，需要去 DeepSeek 控制台充值或更换 Key。

## 9. 配置 Qwen/DashScope API Key

Qwen/DashScope 用于 Step 1.5 抖音内容初筛。当前网页面板不提供 Qwen 字段，需要修改项目根目录里的 `.env` 文件。

### 9.1 获取 Qwen/DashScope API Key

1. 打开阿里云百炼 API Key 文档：<https://help.aliyun.com/zh/model-studio/get-api-key>。
2. 按文档进入阿里云百炼或 DashScope 控制台。
3. 登录阿里云账号。
4. 开通百炼/模型服务。
5. 创建 API Key。
6. 复制 API Key，并确认服务可调用、账号余额或额度可用。

### 9.2 修改 `.env`

1. 打开项目根目录。
2. 找到 `.env` 文件。
3. 如果没有 `.env`，复制 `.env.example` 并重命名为 `.env`。
4. 用文本编辑器打开 `.env`。
5. 找到下面几行：

```dotenv
FILTER_PROVIDER=qwen
QWEN_API_KEY=
QWEN_MODEL=qwen3-vl-plus
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1
```

6. 把 `QWEN_API_KEY=` 后面填上你的 Key：

```dotenv
FILTER_PROVIDER=qwen
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxx
QWEN_MODEL=qwen3-vl-plus
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1
```

7. 保存 `.env`。
8. 关闭并重新启动采集器，让新配置生效。

如果你的阿里云账号使用的是兼容 OpenAI 的 DashScope 地址，可以按管理员给出的地址填写，例如：

```dotenv
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.6-flash
```

没有明确要求时，使用项目默认值：

```dotenv
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1
QWEN_MODEL=qwen3-vl-plus
```

Step 1.5 的通过率和严格程度参数一般保持默认，不会配置时不要改：

```dotenv
FILTER_STRICTNESS=balanced
FILTER_TARGET_PASS_RATE=0.4
FILTER_MIN_PASS_RATE=0.33
FILTER_MAX_PASS_RATE=0.5
STEP15_ASR_COMMAND=
STEP15_OCR_COMMAND=
```

`STEP15_ASR_COMMAND` 和 `STEP15_OCR_COMMAND` 默认留空。当前交付版本不要求新手配置本地 ASR/OCR 命令。

## 10. 完整 `.env` 关键字段参考

下面只展示需要迁移或经常更换的关键字段，不要把真实文件发到群里。

```dotenv
# 飞书应用凭证
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 飞书表格信息：普通表格优先填 FEISHU_SPREADSHEET_TOKEN
FEISHU_WIKI_TOKEN=
FEISHU_SPREADSHEET_TOKEN=shtcnxxxxxxxxxxxxxxxxxxxxxx

# 三个平台和 Step 1.5 / 历史台账 Sheet ID
FEISHU_SHEET_DOUYIN=1xxxxx
FEISHU_SHEET_XHS=2xxxxx
FEISHU_SHEET_BILIBILI=3xxxxx
FEISHU_SHEET_STEP15_FILTERED=4xxxxx
FEISHU_SHEET_DOUYIN_HISTORY=5xxxxx
FEISHU_SHEET_XHS_HISTORY=6xxxxx
FEISHU_SHEET_BILIBILI_HISTORY=7xxxxx
FEISHU_OPEN_BASE_URL=https://open.feishu.cn

# DeepSeek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_MODEL=deepseek-v4-flash

# MiniMax
MINIMAX_API_KEY=sk-xxxxxxxxxxxxxxxx
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M3
MINIMAX_IMAGE_UNDERSTANDING_ENDPOINT=

# Step 1.5 Qwen/DashScope
FILTER_PROVIDER=qwen
FILTER_STRICTNESS=balanced
FILTER_TARGET_PASS_RATE=0.4
FILTER_MIN_PASS_RATE=0.33
FILTER_MAX_PASS_RATE=0.5
STEP15_ASR_COMMAND=
STEP15_OCR_COMMAND=
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxx
QWEN_MODEL=qwen3-vl-plus
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1
```

## 11. 更换配置怎么做

### 11.1 只换飞书表格，不换飞书企业

适用场景：仍在同一个飞书企业里，只是换了一张新表。

1. 不需要重新创建飞书自建应用。
2. 打开新表格，获取新的 `Spreadsheet Token`。
3. 获取新表格里 `抖音渠道`、`小红书渠道`、`B站渠道` 的 Sheet ID。
4. 如果使用 Step 1.5 或历史台账，也获取对应历史页签 Sheet ID。
5. 打开采集器网页设置。
6. 替换 `Spreadsheet Token` 和对应 Sheet ID。
7. `App ID`、`App Secret` 保持不变。
8. 保存设置并检测配置。

### 11.2 换飞书企业或租户

适用场景：从一个公司/租户迁移到另一个公司/租户。

1. 在新飞书企业里重新创建企业自建应用。
2. 重新开通电子表格读写管理权限。
3. 重新获取新的 `App ID` 和 `App Secret`。
4. 在新企业里创建或复制目标普通电子表格。
5. 重新获取 `Spreadsheet Token` 和所有 Sheet ID。
6. 确认新应用可以访问新表格。
7. 打开采集器网页设置。
8. 替换 `App ID`、`App Secret`、`Spreadsheet Token` 和所有 Sheet ID。
9. 保存设置并检测配置。

旧企业的 App ID、App Secret、表格 token 和 Sheet ID 不能直接用于新企业。

### 11.3 只换 MiniMax 或 DeepSeek Key

适用场景：AI Key 过期、泄露、余额归属变化，或者换成另一个账号。

1. 打开对应平台控制台。
2. 创建新的 API Key。
3. 打开采集器网页设置。
4. 在 `MiniMax API Key` 或 `DeepSeek API Key` 填入新 Key。
5. 其它 Base URL 和 Model 没有特别要求时保持推荐值。
6. 点击“保存设置”。
7. 点击“检测配置”。
8. 确认新 Key 可用后，到平台控制台删除或禁用旧 Key。

如果输入框显示“留空保持不变”，说明不填不会清空旧 Key。要更换时必须输入新的 Key。

### 11.4 只换 Qwen/DashScope Key

1. 打开阿里云百炼或 DashScope 控制台。
2. 创建新的 API Key。
3. 打开项目根目录里的 `.env`。
4. 替换 `QWEN_API_KEY=` 后面的值。
5. 保存 `.env`。
6. 重新启动采集器。
7. 确认 Step 1.5 相关任务不再提示未配置 Qwen API Key。
8. 确认新 Key 可用后，在阿里云控制台禁用旧 Key。

## 12. 最终验证

完成配置后，建议按这个顺序验收：

1. 打开采集器网页。
2. 进入“设置”。
3. 点击“检测配置”。
4. 确认飞书、MiniMax、DeepSeek 没有失败项。
5. 如果使用 Step 1.5，确认 `.env` 已配置 `QWEN_API_KEY` 并重启过采集器。
6. 用一个较小日期范围或少量账号跑一次采集。
7. 打开飞书表格，确认对应渠道页签有新增或更新数据。
8. 如果写入失败，先不要重复跑全量任务，先看运行日志和飞书表格实际内容。

## 13. 常见问题

### 检测提示缺少飞书配置

检查这些字段是否已填写：

```text
App ID
App Secret
Spreadsheet Token 或 Wiki Token
抖音 Sheet ID
小红书 Sheet ID
B站 Sheet ID
```

### 飞书配置可访问，但找不到 Sheet ID

通常是 Sheet ID 填错，或者填成了工作表名称。重新打开对应页签，从浏览器 URL 里复制页签 ID。

### 飞书提示权限不足

按顺序检查：

1. 飞书自建应用是否属于目标企业。
2. 应用是否开通电子表格读写管理权限。
3. 权限是否已经发布/审核通过。
4. 应用是否能访问目标表格。
5. 目标表格是不是普通电子表格，而不是 Base。

### App Secret 输入框为空

这是正常的。为了安全，面板不会回显完整 Secret。输入框显示“留空保持不变”时：

1. 不想改 Secret，就留空保存。
2. 要更换 Secret，就输入新的 Secret 后保存。

### MiniMax 或 DeepSeek 检测失败

检查：

1. API Key 是否复制完整。
2. Key 是否已经被禁用。
3. 账号是否有余额或额度。
4. Base URL 是否保持推荐值。
5. 当前电脑网络是否能访问对应平台。

### Qwen 配置后还是提示未配置

检查：

1. 修改的是项目根目录里的 `.env`，不是 `.env.example`。
2. `QWEN_API_KEY=` 后面有真实 Key。
3. 保存 `.env` 后已经重启采集器。
4. `FILTER_PROVIDER=qwen` 没有被改成其它值。

### 不知道该填 Spreadsheet Token 还是 Wiki Token

优先填 `Spreadsheet Token`，并让 `Wiki Token` 留空。只有表格只能通过知识库 Wiki 链接访问、拿不到普通表格链接时，才填 `Wiki Token`。

### 换配置后是否需要重新登录小红书、抖音、B站

只换飞书或 AI Key，一般不需要重新登录三个平台。迁移到新电脑、删除了 `.xhs-profile`、`.douyin-profile`、`.bilibili-profile`，或者登录检测失败时，才需要重新扫码登录。
