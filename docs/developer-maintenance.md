# 维护说明

> 这份文档只放长期保留的维护入口。

## 历史抓取

- `npm run history:crawl:douyin`
- `npm run history:crawl:xhs`
- `npm run history:crawl:bilibili`

## 内容分类

- `npm run classify:douyin-channel-types`
- `PLAYWRIGHT_HEADLESS=1 npm run classify:douyin-multimodal-tags -- --write`

## 说明

- 历史抓取和分类维护都属于独立入口，不走每日采集的 `collect:daily`。
- 一次性渠道同步/重建入口已从正式脚本中移除。
