# 作品链接采集器

本项目用于抓取指定小红书和抖音账号从起始日期到当天的作品链接、TAG 词、内容类型/作品分类、账号名称等字段，并导出为 `.xls` 和 `.csv`。

小红书默认账号：

- 同花顺投资
- 同花顺股民社区
- 同顺财经
- 同花顺新手福利官
- 同花顺理财
- 喵懂投资

抖音默认账号：

- 同花顺投资
- 同花顺财富
- 同花顺股民社区
- 同花顺财经
- 同花顺期货通
- 同花顺问财
- 喵懂投资

## 使用

安装依赖：

```bash
npm install
```

### 方式一：本地面板

启动面板：

```bash
npm run ui
```

打开 `http://127.0.0.1:3000`，选择“小红书”或“抖音”，输入起始日期后点击开始爬取。页面会显示当前平台的实时日志和导出文件。

macOS 上也可以直接双击文件夹里的 `启动小红书爬取面板.command`。

Windows 上可以直接双击文件夹里的 `启动小红书爬取面板.cmd`。

首次使用或登录过期时，在面板选择对应平台后点击“打开登录”，登录成功并确认能正常访问平台页面后，关闭登录浏览器窗口，再点击“开始爬取”。小红书登录状态保存在本地 `.xhs-profile`，抖音登录状态保存在本地 `.douyin-profile`，这两个目录不会上传到 GitHub。

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

日期支持 `YYYY-MM-DD`、`YYYY/M/D`、`M-D`、`M/D`。不传日期时，默认从 `2026-04-15` 开始。

小红书结果会输出到 `output/xhs_notes_起始日期_to_结束日期.xls` 和同名 CSV。抖音结果会输出到 `output/douyin_notes_起始日期_to_结束日期.xls` 和同名 CSV。`.xls` 是 Excel XML 格式。

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

### Docker

Docker 里没有桌面窗口，默认使用无头浏览器运行。先在本机完成一次登录，确认 `.xhs-profile` / `.douyin-profile` 目录存在并可用，再把它们作为 volume 挂进容器。

```bash
docker compose up --build
```

然后打开 `http://127.0.0.1:3000`。Docker 环境里“打开登录”不能交互扫码登录；如果登录态过期，需要回到有桌面环境的机器上重新登录，再重启容器。

不使用 compose 时也可以手动运行：

```bash
docker build -t rednote-harvest .
docker run --rm -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e HEADLESS=1 \
  -v "$PWD/output:/app/output" \
  -v "$PWD/.xhs-profile:/app/.xhs-profile" \
  -v "$PWD/.douyin-profile:/app/.douyin-profile" \
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

抖音导出字段为：

- `账号名称`
- `发布时间`
- `作品链接`
- `作品分类`
- `TAG词`

内容类型/作品分类规则：

- TAG 中存在 `#同花顺资讯`：`资讯`
- TAG 中存在 `#同花顺股友说`：`股友说`
- TAG 中存在 `#同顺图解`：`图文`
- TAG 中存在 `#同顺盘点`：`盘点`
- TAG 中存在 `#问财问句`：`问财`
- TAG 中存在 `#同顺深度财经`：`长视频`
- TAG 中存在 `#同顺财商`：`财商动画`
- TAG 中存在 `#同花顺股民话题`：`社区话题`
- 其他或没有相关 TAG：`无`

小红书 `笔记id` 按你的 Excel 公式生成：`=TEXTBEFORE(TEXTAFTER(C行号,"item/"),"?")`。抖音暂不导出作品 ID。

## 说明

- `node_modules/`、`.xhs-profile/`、`.douyin-profile/`、`output/` 已加入 `.gitignore`，不会提交。
- 小红书和抖音登录态都可能过期；如果日志提示登录失效，切换到对应平台后重新点击“打开登录”即可。
- 该工具仅用于已登录后页面可见内容的整理导出。

## 跨平台说明

- Windows 没有 `lsof`，脚本会跳过本地 profile 占用检测；如果浏览器还开着，Playwright 会给出明确启动错误。
- Docker/Linux 无显示器环境会自动切到无头模式，并给 Chromium 添加 `--no-sandbox` 和 `--disable-dev-shm-usage`。
- Docker 访问面板时服务监听 `0.0.0.0`，本机访问仍然使用 `http://127.0.0.1:3000`。
