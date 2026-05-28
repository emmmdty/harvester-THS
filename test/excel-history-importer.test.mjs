import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyExcelHistoryRecords,
  historyRecordToPlatformItem
} from "../src/excel-history-importer.mjs";

test("classifyExcelHistoryRecords writes unique Douyin rows inside existing date blocks", () => {
  const result = classifyExcelHistoryRecords({
    recordsByPlatform: {
      douyin: [
        excelRecord("douyin", "2026-05-20", "https://v.douyin.com/a/", {
          rowNumber: 10,
          titleKey: "same-title",
          accountName: "投资号"
        }),
        excelRecord("douyin", "2026-05-20", "https://v.douyin.com/c/", {
          rowNumber: 13,
          titleKey: "new-title",
          accountName: "投资号"
        }),
        excelRecord("douyin", "2026-05-19", "https://v.douyin.com/b/", { rowNumber: 11 }),
        excelRecord("douyin", "2026-05-19", "https://v.douyin.com/b/", { rowNumber: 12 })
      ]
    },
    existingRecordsByPlatform: {
      douyin: [
        existingRecord("douyin", "2026-05-20", "https://www.douyin.com/video/123", {
          titleKey: "same-title",
          accountName: "投资号"
        })
      ]
    }
  });

  assert.equal(result.platforms.douyin.safeRecords.length, 2);
  assert.deepEqual(result.platforms.douyin.safeRecords.map((record) => record.rowNumber), [13, 11]);
  assert.equal(result.platforms.douyin.skippedExisting.length, 1);
  assert.equal(result.platforms.douyin.skippedExisting[0].reason, "same_date_same_title_account");
  assert.equal(result.platforms.douyin.needsReview.length, 0);
  assert.equal(result.platforms.douyin.excelDuplicateRows.length, 1);
});

test("classifyExcelHistoryRecords keeps the earliest XHS row for Excel cross-date duplicates", () => {
  const result = classifyExcelHistoryRecords({
    recordsByPlatform: {
      xhs: [
        excelRecord("xhs", "2026-05-19", "xhs-a", { rowNumber: 20 }),
        excelRecord("xhs", "2026-05-18", "xhs-a", { rowNumber: 21 }),
        excelRecord("xhs", "2026-05-22", "xhs-b", { rowNumber: 22 })
      ]
    },
    existingRecordsByPlatform: {
      xhs: [
        existingRecord("xhs", "2026-05-23", "xhs-b", { rowNumber: 6 })
      ]
    }
  });

  assert.equal(result.platforms.xhs.safeRecords.length, 1);
  assert.equal(result.platforms.xhs.safeRecords[0].date, "2026-05-18");
  assert.equal(result.platforms.xhs.safeRecords[0].rowNumber, 21);
  assert.equal(result.platforms.xhs.excelDuplicateRows.length, 1);
  assert.equal(result.platforms.xhs.excelDuplicateRows[0].reason, "excel_duplicate_key_later_date");
  assert.equal(result.platforms.xhs.dateConflicts.length, 1);
  assert.deepEqual(result.platforms.xhs.dateConflicts[0].existingDates, ["2026-05-23"]);
});

test("classifyExcelHistoryRecords skips out-of-scope Bilibili history and maps safe rows to platform items", () => {
  const result = classifyExcelHistoryRecords({
    recordsByPlatform: {
      bilibili: [
        excelRecord("bilibili", "2023-06-13", "BVold2023", { rowNumber: 30 }),
        excelRecord("bilibili", "2026-05-22", "BVexists", { rowNumber: 31 }),
        excelRecord("bilibili", "2026-05-15", "BVnew12345", { rowNumber: 32 }),
        excelRecord("bilibili", "2026-05-14", "BVnew12345", { rowNumber: 33 })
      ]
    },
    existingRecordsByPlatform: {
      bilibili: [
        existingRecord("bilibili", "2026-05-22", "BVexists", { rowNumber: 4 })
      ]
    }
  });

  assert.equal(result.platforms.bilibili.outOfScope.length, 1);
  assert.equal(result.platforms.bilibili.skippedExisting.length, 1);
  assert.equal(result.platforms.bilibili.safeRecords.length, 1);
  assert.equal(result.platforms.bilibili.safeRecords[0].date, "2026-05-14");
  assert.equal(result.platforms.bilibili.excelDuplicateRows.length, 1);

  const item = historyRecordToPlatformItem(result.platforms.bilibili.safeRecords[0]);
  assert.equal(item.link, "https://www.bilibili.com/video/BVnew12345/");
  assert.equal(item.bvid, "BVnew12345");
  assert.equal(item.accountName, "投资号");
  assert.equal(item.publishedAt, "2026-05-14");
});

function excelRecord(platformId, date, key, overrides = {}) {
  return {
    platformId,
    date,
    key,
    link: key,
    accountName: "投资号",
    contentType: "图文",
    rowNumber: 1,
    ...overrides
  };
}

function existingRecord(platformId, date, key, overrides = {}) {
  return {
    platformId,
    date,
    key,
    rowNumber: 1,
    accountName: "投资号",
    titleKey: "",
    ...overrides
  };
}
