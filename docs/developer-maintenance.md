# 维护说明

> 这份文档只放长期保留的维护入口。

## 历史抓取

- `npm run history:crawl:douyin`
- `npm run history:crawl:xhs`
- `npm run history:crawl:bilibili`

## 内容分类

- `npm run classify:douyin-channel-types`
- `PLAYWRIGHT_HEADLESS=1 npm run classify:douyin-multimodal-tags -- --write`

## 素材缓存

- 每日采集会把素材缓存到 `output/<日期>/<平台>/<作品ID>/manifest.json`。
- 视频素材优先走 `yt-dlp`；抖音/小红书图文优先走浏览器素材/页面截图兜底。
- 登录浏览器保持可见，普通采集和素材兜底默认后台运行；需要调试采集窗口时改 `CRAWL_BROWSER_HEADLESS=0`，需要调试浏览器兜底时改 `MATERIAL_BROWSER_FALLBACK_HEADLESS=0`。
- 默认不会因为素材失败阻断飞书基础数据写入；素材失败会记录在 manifest 和每日汇总中。需要严格阻断时设置 `STRICT_MATERIAL_GATE=1`。
- 小红书采集入口或素材兜底遇到登录页、验证码、安全验证、`website-login/error`、`website-login/captcha` 时会停止对应访问；面板日常采集会打开可见登录窗口，处理后再重跑。
- 小红书图文失败时先检查 `.xhs-profile` 登录态和页面风控日志，再重跑对应日期采集。

## 说明

- 历史抓取和分类维护都属于独立入口，不走每日采集的 `collect:daily`。
- 一次性渠道同步/重建入口已从正式脚本中移除。
