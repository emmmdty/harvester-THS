# 小红书账号作品链接爬取

本项目用于抓取指定小红书账号从起始日期到当天的笔记/视频链接、TAG 词、内容类型、账号名称和笔记 ID，并导出为 `.xls` 和 `.csv`。

默认账号：

- 同花顺投资
- 同花顺股民社区
- 同顺财经
- 同花顺新手福利官
- 同花顺理财
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

打开 `http://127.0.0.1:3000`，输入起始日期后点击开始爬取。页面会显示实时日志和导出文件。

macOS 上也可以直接双击文件夹里的 `启动小红书爬取面板.command`。

Windows 上可以直接双击文件夹里的 `启动小红书爬取面板.cmd`。

首次使用或登录过期时，在面板点击“打开登录”，登录成功并确认能正常访问小红书后，关闭登录浏览器窗口，再点击“开始爬取”。登录状态会保存在本地 `.xhs-profile` 目录里，该目录不会上传到 GitHub。

### 方式二：命令行

账号配置已经放在 `accounts.json`。如果你已经有 6 个账号主页链接，建议填到 `url` 字段里，准确率最高。没有填链接时，脚本会尝试用账号名称搜索。

开始爬取：

```bash
npm run crawl -- 2026-04-15
```

也可以写成：

```bash
npm run crawl -- --since 2026-04-15
```

日期支持 `YYYY-MM-DD`、`YYYY/M/D`、`M-D`、`M/D`。不传日期时，默认从 `2026-04-15` 开始。

结果会输出到 `output/xhs_notes_起始日期_to_结束日期.xls` 和同名 CSV。`.xls` 是 Excel XML 格式，能直接保留公式。

面板启动爬取时默认会弹出浏览器窗口，方便观察实际访问情况；如果想后台运行，可以用 `HEADLESS=1 npm run ui` 启动面板。

### Docker

Docker 里没有桌面窗口，默认使用无头浏览器运行。先在本机完成一次登录，确认 `.xhs-profile` 目录存在并可用，再把它作为 volume 挂进容器。

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
  rednote-harvest
```

## 字段

导出字段为：

- `账号名称`
- `发布时间`
- `作品链接`
- `笔记id`
- `TAG词`
- `内容类型`

内容类型规则：

- TAG 中存在 `#同花顺资讯`：`资讯`
- TAG 中存在 `#同花顺股友说`：`股友说`
- 其他或没有相关 TAG：`无`

`笔记id` 按你的 Excel 公式生成：`=TEXTBEFORE(TEXTAFTER(C行号,"item/"),"?")`。

## 说明

- `node_modules/`、`.xhs-profile/`、`output/` 已加入 `.gitignore`，不会提交。
- 小红书登录态可能过期；如果日志提示登录失效，重新点击“打开登录”即可。
- 该工具仅用于已登录后页面可见内容的整理导出。

## 跨平台说明

- Windows 没有 `lsof`，脚本会跳过本地 profile 占用检测；如果浏览器还开着，Playwright 会给出明确启动错误。
- Docker/Linux 无显示器环境会自动切到无头模式，并给 Chromium 添加 `--no-sandbox` 和 `--disable-dev-shm-usage`。
- Docker 访问面板时服务监听 `0.0.0.0`，本机访问仍然使用 `http://127.0.0.1:3000`。
