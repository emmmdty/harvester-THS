# 作品链接采集器

本项目用于抓取指定小红书、抖音和 B 站账号的作品链接、TAG 词、内容类型/作品分类、账号名称等字段，并导出为 `.xls`、`.csv` 和 `.json`。也可以按指定日期执行三平台每日采集，并写入已有飞书普通电子表格的三个工作表。

小红书默认账号：

- 同花顺投资
- 同花顺理财
- 同顺股民社区（别名：同花顺股民社区）
- 同顺财经
- 问财（URL 先留空，可在 `accounts.json` 手动补主页）
- 喵懂投资
- 研习社（URL 先留空，可在 `accounts.json` 手动补主页）

抖音默认账号：

- 同花顺投资
- 同花顺股民社区
- 同花顺财富
- 同花顺财经
- 同花顺问财
- 喵懂投资
- 同花顺期货通

B 站默认账号：

- 同花顺投资（mid：1622777305）

## 使用

安装依赖：

```bash
npm install
```

中国大陆网络环境建议使用 npm 镜像：

```bash
npm ci --registry=https://registry.npmmirror.com
```

Playwright 已固定为 `1.59.1`，与 Docker 基础镜像 `mcr.microsoft.com/playwright:v1.59.1-noble` 保持一致。

### 方式一：本地面板

#### 本机启动

```bash
npm run ui
```

默认本机模式只监听 `127.0.0.1`，打开 `http://127.0.0.1:3000`，选择“小红书”“抖音”“B站”或“全渠道”，输入日期后点击开始爬取。页面会显示当前平台的实时日志和导出文件。采集模式默认是“保守提速”，会拦截图片、视频、字体等重资源，启用详情缓存和可靠列表时间预过滤；如遇平台页面兼容问题，可切到“兼容旧模式”回退到旧采集策略。

macOS 上也可以直接双击文件夹里的 `启动小红书爬取面板.command`。

Windows 上可以直接双击文件夹里的 `启动小红书爬取面板.cmd`。

#### 局域网启动

如果要把作品采集面板共享给局域网同事，监听局域网地址即可：

```bash
HOST=0.0.0.0 npm run ui
```

局域网同事访问 `http://<运行机器局域网IP>:3000`。默认不需要输入共享口令；如果确实需要保护面板，可以在 `.env` 中填写 `PANEL_PASSWORD=换成共享口令`，页面会先要求输入共享口令。

macOS 上也可以直接双击文件夹里的 `启动局域网作品采集面板.command`。

Windows 上可以直接双击文件夹里的 `启动局域网作品采集面板.cmd`。

首次使用或登录过期时，在面板选择对应平台后点击“打开登录”，登录成功并确认能正常访问平台页面后，关闭登录浏览器窗口，再点击“开始爬取”。小红书登录状态保存在本地 `.xhs-profile`，抖音登录状态保存在本地 `.douyin-profile`，B 站登录状态保存在本地 `.bilibili-profile`，这些目录不会上传到 GitHub。

面板里的“全渠道采集”会按目标日期顺序执行抖音、小红书和 B 站，并把结果写入飞书普通表格。定时时间可在面板里修改，默认建议 `11:30`；本地服务运行时才会触发定时任务，定时配置保存在 `.runtime/scheduler.json`，最近一次定时触发、跳过或退出结果会记录在 `.runtime/scheduler-runs.json`。

局域网生产使用前建议先检查本机运行条件：

```bash
npm run prod:check
```

该检查不会访问飞书 API 或启动采集，只会确认 `.env`、飞书必要配置、三个平台登录态目录、定时配置和端口可用性。当前生产口径是可信局域网免口令；`PANEL_PASSWORD` 只在需要临时保护面板时填写，不是必填项。运行面板的电脑不要睡眠，且不要同时打开多个复用同一 profile 的 Chromium 采集/登录窗口。

#### 复制给同事试用

如果只是给同事临时试用，可以复制一份干净项目目录，但不要复制 `.env`、`node_modules/`、`.xhs-profile/`、`.douyin-profile/`、`.bilibili-profile/`、`.runtime/`、`output/` 和 `.git/`。同事拿到后执行：

```bash
npm ci --registry=https://registry.npmmirror.com
npx playwright install chromium
cp .env.example .env
npm run ui
```

同事需要自己填写 `.env` 中的飞书配置，并在面板中分别登录小红书、抖音和 B 站。需要局域网共享时，再使用上面的 `HOST=0.0.0.0 npm run ui` 或双击局域网启动脚本。

### 方式二：命令行

小红书账号配置在 `accounts.json`。抖音账号配置在 `douyin-accounts.json`。建议直接填写账号主页链接，准确率最高。

开始爬取：

```bash
npm run crawl -- 2026-04-15
```

也可以写成：

```bash
npm run crawl -- --since 2026-04-15
```

抖音命令行爬取：

```bash
npm run crawl:douyin -- 2026-04-15
```

B 站命令行爬取：

```bash
npm run crawl:bilibili -- 2026-04-15
```

三平台每日采集并写入飞书：

```bash
npm run collect:daily -- --target-date 2026-05-19
```

只采集本地文件、不写飞书：

```bash
npm run collect:daily -- --target-date 2026-05-19 --skip-feishu
```

日期支持 `YYYY-MM-DD`、`YYYY/M/D`、`M-D`、`M/D`。不传日期时，默认从 `2026-04-15` 开始。

小红书结果会输出到 `output/xhs_notes_起始日期_to_结束日期.xls`、同名 CSV 和 JSON。抖音结果会输出到 `output/douyin_notes_起始日期_to_结束日期.xls`、同名 CSV 和 JSON。B 站结果会输出到 `output/bilibili_videos_起始日期_to_结束日期.xls`、同名 CSV 和 JSON。`.xls` 是 Excel XML 格式。

### 飞书普通表格配置

代码只写入已有飞书电子表格，不自动创建表格。先复制配置模板：

```bash
cp .env.example .env
```

然后在 `.env` 中填入：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_WIKI_TOKEN`，如果表格在 Wiki 里，填 `/wiki/` 后面的 token
- `FEISHU_SPREADSHEET_TOKEN`
- `FEISHU_SHEET_DOUYIN`
- `FEISHU_SHEET_XHS`
- `FEISHU_SHEET_BILIBILI`
- `FEISHU_SHEET_STEP15_FILTERED`，Step 1.5 筛选后输出工作表
- `FEISHU_OPEN_BASE_URL`，默认 `https://open.feishu.cn`
- `DEEPSEEK_BASE_URL`，默认 `https://api.deepseek.com`
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`
- `STEP15_FILTER_PROVIDER`，可填 `qwen`、`minimax` 或 `local`
- `STEP15_ASR_COMMAND`，可选，本地音频转写命令模板，支持 `{audio}` 和 `{output}` 占位符
- `STEP15_OCR_COMMAND`，可选，本地 OCR 命令模板，支持 `{image}` 和 `{output}` 占位符
- `QWEN_API_KEY`、`QWEN_MODEL`、`QWEN_BASE_URL`，用于 Step 1.5 Qwen 多模态筛选
- `MINIMAX_API_KEY`、`MINIMAX_IMAGE_UNDERSTANDING_ENDPOINT`，用于 Step 1.5 MiniMax 图像理解筛选
- `HOST`，可选；留空时默认本机 `127.0.0.1`，局域网共享时填 `0.0.0.0`
- `PANEL_PASSWORD`，可选；填写后面板会要求输入共享口令，不填写则直接进入面板

普通表格里需要提前建好三个采集工作表和一个 Step 1.5 输出工作表，并在每个工作表第 1 行按顺序写表头：

- 抖音：`编号`、`投稿时间`、`内容链接`、`标题`、`tag词`、`筛选状态`、`简短理由`、`账号`、`内容类型`、`内容类型标签审核`、`本地素材目录`
- 小红书：`编号`、`投稿时间`、`内容链接`、`笔记ID`、`账号`、`内容类型`、`内容类型标签审核`、`tag词`
- B站：`编号`、`投稿时间`、`内容链接`、`短链id`、`账号`、`标题`、`tag词`
- Step 1.5 输出表：`编号`、`投稿时间`、`内容链接`、`账号`、`内容类型`、`简短理由`、`是否投放成功`、`是否为爆款`、`供稿人`、`备注`

Step 1.5 会在原始抖音表 F/G/K 写回 `筛选状态`、`简短理由`、`本地素材目录`；`抖音筛选结果` 只写入可投放内容，`是否投放成功`、`是否为爆款`、`供稿人`、`备注` 留给人工填写。如果已有小红书工作表只配置到 `内容类型`，请在 G 列补 `内容类型标签审核`、H 列补 `tag词`；如果已有 B站工作表只配置到 `账号`，请在 F 列补 `标题`、G 列补 `tag词`。补完后运行 `npm run doctor` 或开始写入。

如果你的链接是 Wiki 形式：

```text
https://xxx.feishu.cn/wiki/YxQewsjm5iKw5Fk5PfgcdSqNnyc?sheet=d0de52
```

则填：

```env
FEISHU_WIKI_TOKEN=YxQewsjm5iKw5Fk5PfgcdSqNnyc
```

代码会通过 Wiki API 自动解析真实普通表格 token。此时 `FEISHU_SPREADSHEET_TOKEN` 可以留空，但应用需要额外开通 Wiki 节点读取权限。

如果你拿到的是普通表格真实链接，通常长这样：

```text
https://xxx.feishu.cn/sheets/shtcnxxxxxxxx?sheet=abc123
```

其中 `/sheets/` 后面的 `shtcnxxxxxxxx` 是：

```env
FEISHU_SPREADSHEET_TOKEN=shtcnxxxxxxxx
```

切换到“抖音 / 小红书 / B站”三个工作表时，URL 里的 `sheet=...` 会变化，分别填到：

```env
FEISHU_SHEET_DOUYIN=abc123
FEISHU_SHEET_XHS=def456
FEISHU_SHEET_BILIBILI=ghi789
FEISHU_SHEET_STEP15_FILTERED=jkl012
```

写入前可检查飞书配置和字段：

```bash
npm run doctor
```

如果要把现有飞书表格调整成投稿模板样式，先运行一次：

```bash
npm run feishu:template
```

该命令会把 `FEISHU_SHEET_STEP15_FILTERED` 对应工作表重命名为 `抖音筛选结果`，并给抖音、小红书、B站和抖音筛选结果工作表写入顶部目标/规则行、表头颜色、合并单元格和冻结行。命令是幂等的，重复运行不会重复插入顶部模板行。模板化后，抖音和抖音筛选结果的数据从第 5 行开始，小红书和 B站的数据从第 3 行开始，采集和清洗脚本会自动识别真实数据区。

如果已有历史数据需要补齐 `内容类型` 和 `内容类型标签审核`，先 dry-run 预览：

```bash
npm run repair:content-types
```

确认后写回抖音和小红书现有表：

```bash
npm run repair:content-types -- --apply
```

该修复只更新 `内容类型`、`内容类型标签审核` 两列；证据不足时会保留已有内容类型，并把 `内容类型标签审核` 标为 `需审核`。

每日写入会按日期倒序插入批次：例如表里已有 5 月 19 日，写入 5 月 20 日会插在 5 月 19 日上面，写入 5 月 18 日会插在 5 月 19 日下面。每个日期批次会先插入一条分隔行，例如 `投稿时间 = 0519 投稿视频`；素材行编号按平台内每日从 `1` 开始顺序排列，例如 `1`、`2`、`3`。如果同一天分隔行已存在，补写的新素材会插在该日期批次末尾，并在写入后重排该批次编号。写入前会按工作表实际行数分块读取目标工作表已有行，跳过重复分隔行和重复素材链接/ID，不会删除用户已有数据。`内容链接` 列会写成飞书可点击超链接，单元格显示原始 URL。

Step 1.5 内容清洗只读取抖音原始表；抖音会按本地规则和可配置多模态 provider 筛选，并把反馈写回原始抖音表 F/G/K，通过的抖音素材会写入 `抖音筛选结果`：

```bash
npm run clean:daily -- --target-date 2026-05-19
```

抖音素材会保存到 `output/step15-assets/YYYY-MM-DD/douyin/<awemeId>/`，包含 `source.json`、`manifest.json`、下载到的 `video.mp4` 或 `images/`、`frames/` 抽帧、`audio.wav`、`asr.txt`、`ocr.txt`。`manifest.json` 会记录素材来源行、文件路径和抽取状态；未配置本地 ASR/OCR 命令时，对应文本文件会保留为空并在 manifest 中标记为未配置。`reject` 和 `review` 的抖音内容不会进入筛选后输出表，但会保留在原始抖音表反馈列和 `output/step15_clean_YYYY-MM-DD.json` 明细中。未配置 `STEP15_FILTER_PROVIDER` 时，未命中本地硬规则的抖音内容会写为 `需人工复核`。

面板启动爬取时默认会弹出浏览器窗口，方便观察实际访问情况；如果想后台运行，可以用 `HEADLESS=1 npm run ui` 启动面板。

小红书和抖音默认启用随机停留，降低访问过快导致的加载不完整或访问限制风险。可以用环境变量调整：

```bash
XHS_DETAIL_READ_DELAY=2000-5000 \
XHS_DETAIL_GAP_DELAY=1500-4000 \
XHS_SCROLL_DELAY=1800-3500 \
DOUYIN_DETAIL_READ_DELAY=3000-7000 \
DOUYIN_DETAIL_GAP_DELAY=2000-5000 \
DOUYIN_SCROLL_DELAY=2000-4000 \
npm run ui
```

单位是毫秒，`3000-7000` 表示随机等待 3 到 7 秒；也可以写固定值，例如 `5000`。

默认采集模式为保守提速：

```bash
npm run crawl -- --since 2026-05-19 --until 2026-05-19 --mode conservative
npm run crawl:douyin -- --since 2026-05-19 --until 2026-05-19 --mode conservative
npm run crawl:bilibili -- --since 2026-05-19 --until 2026-05-19 --mode conservative
```

需要完全回退旧策略时使用：

```bash
npm run crawl -- --since 2026-05-19 --until 2026-05-19 --mode legacy
```

保守提速模式默认会把详情页识别结果缓存到 `.runtime/detail-cache/`，不会改变本次 `--since/--until` 的输出范围。可用这些环境变量控制：

```bash
CRAWL_DETAIL_CACHE=0 npm run crawl -- --since 2026-05-19 --until 2026-05-19
CRAWL_REFRESH_CACHE=1 npm run crawl -- --since 2026-05-19 --until 2026-05-19
DOUYIN_COPY_SHARE=1 npm run crawl:douyin -- --since 2026-05-19 --until 2026-05-19
```

- `CRAWL_DETAIL_CACHE=0`：关闭详情缓存。
- `CRAWL_REFRESH_CACHE=1`：忽略已有缓存，重新读取详情并覆盖缓存。
- `DOUYIN_COPY_SHARE=1`：抖音恢复点击分享并复制口令；兼容旧模式默认也会执行这一步。

如果本机运行产物占用空间较大，可以先预览可清理内容：

```bash
npm run cleanup:dry-run
```

该命令默认不删除文件，只列出可再生成的运行产物，例如旧飞书备份、Step 1.5 素材包、策略评估 JSON 和详情缓存。浏览器登录态目录 `.xhs-profile/`、`.douyin-profile/`、`.bilibili-profile/` 不会被列入清理，避免影响登录态。

### Docker

Docker 里没有桌面窗口，默认使用无头浏览器运行。先在本机完成一次登录，确认 `.xhs-profile` / `.douyin-profile` 目录存在并可用，再把它们作为 volume 挂进容器。

```bash
docker compose up --build
```

本机打开 `http://127.0.0.1:3000`；局域网同事访问 `http://<运行机器局域网IP>:3000`。Docker 默认监听 `0.0.0.0`，默认不需要输入共享口令；如果设置了 `PANEL_PASSWORD`，页面会先要求输入共享口令。Docker 环境里“打开登录”不能交互扫码登录；如果登录态过期，需要回到有桌面环境的机器上重新登录，再重启容器。

不使用 compose 时也可以手动运行：

```bash
docker build -t rednote-harvest .
docker run --rm -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e HEADLESS=1 \
  -v "$PWD/output:/app/output" \
  -v "$PWD/.xhs-profile:/app/.xhs-profile" \
  -v "$PWD/.douyin-profile:/app/.douyin-profile" \
  -v "$PWD/.bilibili-profile:/app/.bilibili-profile" \
  -v "$PWD/.runtime:/app/.runtime" \
  --env-file .env \
  rednote-harvest
```

## 字段

小红书导出字段为：

- `账号名称`
- `发布时间`
- `作品链接`
- `笔记id`
- `TAG词`
- `内容类型`
- `内容类型标签审核`

抖音导出字段为：

- `账号名称`
- `发布时间`
- `作品链接`
- `标题`
- `作品分类`
- `内容类型标签审核`
- `TAG词`

B 站导出字段为：

- `账号名称`
- `发布时间`
- `作品链接`
- `短链id`
- `标题`
- `TAG词`

飞书普通表格按上方各平台表头顺序写入；`内容链接` 写入为可点击超链接，单元格显示原始 URL；小红书优先写入 `https://www.xiaohongshu.com/discovery/item/...` 分享链接，并保留 `source=webshare`、`xhsshare=pc_web`、`xsec_token`、`xsec_source=pc_share` 等打开所需参数，降低 404 风险；抖音和 B站标题写入 `标题`，TAG 写入 `tag词`。

小红书飞书 `内容类型` 下拉选项为：`资讯`、`财商动画`、`励志语录`、`问财问句`、`盘点`、`股友说`、`社区话题`、`说唱`、`大佬采访`、`长视频`、`理财内容`、`常老师`、`图文`、`AI视频 虚拟人`、`段子`。

内容类型/作品分类规则：

- TAG 中存在 `#同花顺资讯`：`资讯`
- TAG 中存在 `#同花顺股友说`：`股友说`
- TAG 中存在 `#同顺图解`：`图文`
- TAG 中存在 `#同顺盘点`：`盘点`
- TAG 中存在 `#问财问句` 或 `#问财`：`问财问句`
- TAG 中存在 `#同顺深度财经`：`长视频`
- TAG 中存在 `#同顺财商`：`财商动画`
- TAG 中存在 `#同花顺股民话题`：`社区话题`
- 小红书 TAG 中存在 `#励志语录`、`#说唱`、`#大佬采访`、`#理财内容`、`#常老师`、`#AI视频`、`#AI虚拟人`、`#虚拟人`、`#段子` 时，会映射到对应的小红书内容类型。
- TAG 规则命中时，`内容类型标签审核` 写 `通过`。
- 其他或没有相关 TAG 时，如果 `.env` 配置了 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，抖音和小红书会调用 DeepSeek 根据平台、账号、标题、TAG 等已抓取内容兜底判断；DeepSeek 只能返回飞书下拉列表中的内容类型。
- DeepSeek 返回合法内容类型时写入该内容类型，并按模型结果写 `通过` 或 `需审核`；DeepSeek 未配置、接口失败、返回空值或返回非法类型时，写 `无` 和 `需审核`。
- B 站不做内容类型分类，也不新增 `内容类型标签审核` 字段。

小红书 `笔记id` 由代码直接从作品链接提取，不依赖 Excel 公式。抖音暂不导出作品 ID。

## 说明

- `node_modules/`、`.env`、`.xhs-profile/`、`.douyin-profile/`、`.bilibili-profile/`、`.runtime/`、`output/` 已加入 `.gitignore`，不会提交。
- 小红书、抖音和 B 站登录态都可能过期；如果日志提示登录失效，切换到对应平台后重新点击“打开登录”即可。
- 每次给同事使用前，建议先确认当前 Git 分支和变更范围；本地运行产物、登录态和 `.env` 不应提交。
- 该工具仅用于已登录后页面可见内容的整理导出。

## 跨平台说明

- Windows 没有 `lsof`，脚本会跳过本地 profile 占用检测；如果浏览器还开着，Playwright 会给出明确启动错误。
- Docker/Linux 无显示器环境会自动切到无头模式，并给 Chromium 添加 `--no-sandbox` 和 `--disable-dev-shm-usage`。
- Docker 访问面板时服务监听 `0.0.0.0`；本机访问使用 `http://127.0.0.1:3000`，局域网访问使用 `http://<运行机器局域网IP>:3000`。`PANEL_PASSWORD` 现在是可选项，只在需要共享口令保护时填写。
