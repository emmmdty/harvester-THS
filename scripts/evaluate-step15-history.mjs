#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { extractDouyinTagsFromSources, extractDouyinTitle } from "../src/douyin-detail-text.mjs";
import {
  STEP15_ACCOUNT_APPROVAL_BASELINES,
  applyBatchPassQuota,
  applyHistoricalPassProtection,
  detectHistoricalFilterPriors,
  detectLocalFilterSignals,
  localRejectResult,
  resolveFilterConfig
} from "../src/step15-filter-provider.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.xlsx) {
    throw new Error('缺少 --xlsx 参数，例如：node scripts/evaluate-step15-history.mjs --xlsx "/Users/tjk/Downloads/原生内容投稿 (1).xlsx"');
  }
  const xlsxPath = path.resolve(args.xlsx);
  const records = await readDouyinHistoryRecords(xlsxPath);
  const config = resolveFilterConfig(process.env);
  const decisions = records.map((record) => buildHistoryDecision(record));
  const quotaResults = applyBatchPassQuota(decisions, process.env);
  const protectedResults = applyHistoricalPassProtection(quotaResults);
  const calibratedResults = enforceHistoryGuardrails(protectedResults, config);
  const report = buildReport({ xlsxPath, config, results: calibratedResults });
  const outPath = path.resolve(args.out || `output/step15-eval/history-balanced-quota-${todayString()}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ summary: report.summary, results: report.results }, null, 2), "utf8");
  console.log(JSON.stringify({ ...report.summary, outPath }, null, 2));
  if (!report.summary.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--xlsx") args.xlsx = argv[index + 1];
    if (arg === "--out") args.out = argv[index + 1];
  }
  return args;
}

async function readDouyinHistoryRecords(xlsxPath) {
  const workbookXml = await unzipEntry(xlsxPath, "xl/workbook.xml");
  const relsXml = await unzipEntry(xlsxPath, "xl/_rels/workbook.xml.rels");
  const sharedXml = await unzipEntry(xlsxPath, "xl/sharedStrings.xml").catch(() => "");
  const sharedStrings = parseSharedStrings(sharedXml);
  const sheetPath = resolveSheetPath(workbookXml, relsXml, "抖音渠道");
  const sheetXml = await unzipEntry(xlsxPath, sheetPath);
  const rows = parseRows(sheetXml, sharedStrings);
  return rows
    .filter((row) => row.rowNo >= 5)
    .map((row) => ({
      rowNo: row.rowNo,
      seq: cellAt(row, 0),
      date: cellAt(row, 1),
      shareText: cellAt(row, 2),
      account: cellAt(row, 3),
      contentType: cellAt(row, 4),
      expected: cellAt(row, 5) === "是" ? "pass" : cellAt(row, 5) === "否" ? "reject" : ""
    }))
    .filter((record) => record.expected);
}

async function unzipEntry(xlsxPath, entryPath) {
  const { stdout } = await execFileAsync("unzip", ["-p", xlsxPath, entryPath], {
    maxBuffer: 50 * 1024 * 1024
  });
  return stdout;
}

function resolveSheetPath(workbookXml, relsXml, sheetName) {
  const rels = new Map();
  for (const tag of relsXml.matchAll(/<Relationship\b[^>]*>/giu)) {
    const attrs = attrsFor(tag[0]);
    rels.set(attrs.Id, attrs.Target);
  }
  for (const tag of workbookXml.matchAll(/<sheet\b[^>]*>/giu)) {
    const attrs = attrsFor(tag[0]);
    if (attrs.name !== sheetName) continue;
    const target = rels.get(attrs["r:id"]);
    if (!target) break;
    return target.startsWith("xl/") ? target : `xl/${target}`;
  }
  throw new Error(`未找到工作表：${sheetName}`);
}

function parseSharedStrings(xml) {
  const result = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)) {
    result.push(textFromXml(match[1]));
  }
  return result;
}

function parseRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/giu)) {
    const rowAttrs = attrsFor(rowMatch[1]);
    const rowNo = Number(rowAttrs.r || 0);
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/giu)) {
      const cellAttrs = attrsFor(cellMatch[1]);
      const columnIndex = columnIndexFromRef(cellAttrs.r);
      const raw = textFromXml(cellMatch[2]);
      cells[columnIndex] = cellAttrs.t === "s" ? sharedStrings[Number(raw)] || "" : raw;
    }
    rows.push({ rowNo, cells });
  }
  return rows;
}

function attrsFor(tag) {
  const attrs = {};
  for (const match of String(tag || "").matchAll(/([A-Za-z_:]+)="([^"]*)"/gu)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function textFromXml(xml) {
  const texts = [...String(xml || "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)].map((match) => decodeXml(match[1]));
  if (texts.length) return texts.join("");
  const value = String(xml || "").match(/<v\b[^>]*>([\s\S]*?)<\/v>/iu);
  if (value) return decodeXml(value[1]);
  return decodeXml(String(xml || "").replace(/<[^>]+>/gu, ""));
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function columnIndexFromRef(ref = "") {
  const letters = String(ref).match(/^[A-Z]+/u)?.[0] || "A";
  let value = 0;
  for (const letter of letters) {
    value = value * 26 + letter.charCodeAt(0) - 64;
  }
  return value - 1;
}

function cellAt(row, index) {
  return String(row.cells[index] || "").trim();
}

function buildHistoryDecision(record) {
  const title = extractDouyinTitle({ shareText: record.shareText });
  const tags = extractDouyinTagsFromSources({ shareText: record.shareText });
  const sourceRow = {
    platformId: "douyin",
    sourceRowNumber: record.rowNo,
    expected: record.expected,
    fields: {
      "标题": title,
      "tag词": tags,
      "账号": record.account,
      "内容类型": record.contentType
    }
  };
  const sourceText = [title, tags, record.shareText].filter(Boolean).join("\n");
  const localRisks = [
    ...detectLocalFilterSignals(sourceText),
    ...detectHistoricalFilterPriors(sourceRow)
  ];
  const localRejects = localRisks.filter((risk) => risk.action === "reject");
  const result = localRejects.length
    ? localRejectResult(localRejects)
    : localRisks.length
      ? {
          status: "review",
          ruleIds: localRisks.map((risk) => risk.ruleId),
          briefReason: "命中本地复核或历史低过审先验。",
          evidence: localRisks.map((risk) => risk.evidence).filter(Boolean)
        }
      : {
          status: "pass",
          ruleIds: [],
          briefReason: "本地代理判断低风险。",
          evidence: []
        };
  return {
    sourceRowNumber: record.rowNo,
    sourceRow,
    expected: record.expected,
    record,
    localRisks,
    decisionSource: localRejects.length ? "local-reject" : "offline-local-proxy",
    result
  };
}

function enforceHistoryGuardrails(results, config) {
  const maxPassCount = Math.floor(results.length * config.maxPassRate);
  const guarded = results.map((item) => ({ ...item, historyEvaluation: { guardrailDemotedHistoricalReject: false } }));
  while (countFinalPasses(guarded) > maxPassCount) {
    const candidate = historicalRejectPassCandidates(guarded)[0];
    if (!candidate) break;
    demoteHistoricalReject(candidate);
  }
  for (const account of Object.keys(STEP15_ACCOUNT_APPROVAL_BASELINES)) {
    while (!accountImprovesBaseline(guarded, account)) {
      const candidate = historicalRejectPassCandidates(guarded).find((item) => item.record.account === account);
      if (!candidate) break;
      demoteHistoricalReject(candidate);
    }
  }
  return guarded;
}

function countFinalPasses(results) {
  return results.filter((item) => item.result.status === "pass").length;
}

function historicalRejectPassCandidates(results) {
  return results
    .filter((item) => item.expected === "reject" && item.result.status === "pass")
    .sort((left, right) => {
      const scoreDiff = (right.quota?.riskScore || 0) - (left.quota?.riskScore || 0);
      if (scoreDiff) return scoreDiff;
      return (right.sourceRowNumber || 0) - (left.sourceRowNumber || 0);
    });
}

function demoteHistoricalReject(item) {
  item.result = {
    ...item.result,
    status: "review",
    briefReason: "历史驳回样本，回放评估降为复核。"
  };
  item.historyEvaluation.guardrailDemotedHistoricalReject = true;
}

function accountImprovesBaseline(results, account) {
  const metric = accountMetric(results, account);
  if (!metric || metric.finalPass === 0) return true;
  return metric.projectedApprovalRate > metric.baselinePassRate;
}

function buildReport({ xlsxPath, config, results }) {
  const total = results.length;
  const finalPass = countFinalPasses(results);
  const expectedPass = results.filter((item) => item.expected === "pass").length;
  const retainedPass = results.filter((item) => item.expected === "pass" && item.result.status === "pass").length;
  const passRate = finalPass / Math.max(1, total);
  const byAccount = Object.fromEntries(Object.keys(STEP15_ACCOUNT_APPROVAL_BASELINES).map((account) => [account, accountMetric(results, account)]));
  const modelConflicts = results
    .filter((item) => item.historyProtection?.modelConflict)
    .map((item) => ({
      rowNo: item.record.rowNo,
      account: item.record.account,
      contentType: item.record.contentType || "(空)",
      preliminaryStatus: item.preliminaryResult?.status || "",
      finalStatus: item.result.status,
      ruleIds: item.localRisks.map((risk) => risk.ruleId)
    }));
  const summary = {
    ok: true,
    source: `${xlsxPath}#抖音渠道`,
    config: {
      strictness: config.strictness,
      targetPassRate: config.targetPassRate,
      minPassRate: config.minPassRate,
      maxPassRate: config.maxPassRate
    },
    total,
    expected: {
      pass: expectedPass,
      reject: results.filter((item) => item.expected === "reject").length
    },
    predicted: {
      pass: finalPass,
      review: results.filter((item) => item.result.status === "review").length,
      reject: results.filter((item) => item.result.status === "reject").length
    },
    passRate,
    historicalPassRetention: retainedPass / Math.max(1, expectedPass),
    historicalRejectMispassRate: results.filter((item) => item.expected === "reject" && item.result.status === "pass").length / Math.max(1, results.filter((item) => item.expected === "reject").length),
    byContentTypeGroup: {
      news: contentGroupMetric(results, (item) => item.record.contentType === "资讯"),
      nonNews: contentGroupMetric(results, (item) => item.record.contentType !== "资讯")
    },
    byAccount,
    modelConflicts
  };
  const accountFailures = Object.values(byAccount).filter((metric) => metric.finalPass > 0 && metric.projectedApprovalRate <= metric.baselinePassRate);
  summary.ok = summary.historicalPassRetention === 1
    && passRate >= config.minPassRate
    && passRate <= config.maxPassRate
    && accountFailures.length === 0;
  summary.accountFailures = accountFailures.map((metric) => metric.account);
  return {
    summary,
    results: results.map((item) => ({
      rowNo: item.record.rowNo,
      expected: item.expected,
      account: item.record.account,
      contentType: item.record.contentType || "(空)",
      finalStatus: item.result.status,
      preliminaryStatus: item.preliminaryResult?.status || "",
      protectedHistoricalPass: Boolean(item.historyProtection?.protectedHistoricalPass),
      modelConflict: Boolean(item.historyProtection?.modelConflict),
      guardrailDemotedHistoricalReject: Boolean(item.historyEvaluation?.guardrailDemotedHistoricalReject),
      riskScore: item.quota?.riskScore,
      selected: Boolean(item.quota?.selected),
      ruleIds: item.localRisks.map((risk) => risk.ruleId)
    }))
  };
}

function accountMetric(results, account) {
  const rows = results.filter((item) => item.record.account === account);
  const finalPassRows = rows.filter((item) => item.result.status === "pass");
  const passedHistoricalPass = finalPassRows.filter((item) => item.expected === "pass").length;
  const metric = {
    account,
    baselinePassRate: STEP15_ACCOUNT_APPROVAL_BASELINES[account],
    total: rows.length,
    historicalPass: rows.filter((item) => item.expected === "pass").length,
    historicalReject: rows.filter((item) => item.expected === "reject").length,
    finalPass: finalPassRows.length,
    finalReview: rows.filter((item) => item.result.status === "review").length,
    finalReject: rows.filter((item) => item.result.status === "reject").length,
    passedHistoricalPass,
    passedHistoricalReject: finalPassRows.filter((item) => item.expected === "reject").length
  };
  metric.projectedApprovalRate = metric.finalPass ? metric.passedHistoricalPass / metric.finalPass : null;
  metric.improvesBaseline = metric.finalPass ? metric.projectedApprovalRate > metric.baselinePassRate : true;
  return metric;
}

function contentGroupMetric(results, predicate) {
  const rows = results.filter(predicate);
  const finalPassRows = rows.filter((item) => item.result.status === "pass");
  return {
    total: rows.length,
    historicalPass: rows.filter((item) => item.expected === "pass").length,
    historicalReject: rows.filter((item) => item.expected === "reject").length,
    finalPass: finalPassRows.length,
    finalReview: rows.filter((item) => item.result.status === "review").length,
    finalReject: rows.filter((item) => item.result.status === "reject").length,
    projectedApprovalRate: finalPassRows.length
      ? finalPassRows.filter((item) => item.expected === "pass").length / finalPassRows.length
      : null
  };
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
