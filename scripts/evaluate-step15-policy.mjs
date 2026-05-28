#!/usr/bin/env node

import "dotenv/config";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { extractFeishuCellLink, normalizeAccountLabel } from "../src/daily-records.mjs";
import { parseExcelHistoryWorkbook } from "../src/excel-history-importer.mjs";
import { canonicalizeContentLink } from "../src/link-utils.mjs";
import {
  buildLogisticPolicyModel,
  classifyLogisticPolicy,
  evaluateLogisticPolicyPredictions
} from "../src/logistic-policy.mjs";
import {
  applyBatchPassQuota,
  calibrateStep15Decision,
  detectHistoricalFilterPriors,
  detectLocalFilterSignals
} from "../src/step15-filter-provider.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_XLSX_PATH = "/Users/tjk/Downloads/原生内容投稿 (1).xlsx";
const DEFAULT_START_DATE = "2026-05-01";
const DEFAULT_END_DATE = "2026-05-31";
const DEFAULT_PASS_RETENTION_TARGET = 0.98;
const STATUS_VALUES = ["pass", "reject", "review"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || process.cwd());
  const outputDir = path.resolve(root, args.outputDir || "output");
  const startDate = args.startDate || DEFAULT_START_DATE;
  const endDate = args.endDate || DEFAULT_END_DATE;
  const xlsxPath = path.resolve(args.xlsx || DEFAULT_XLSX_PATH);

  const cached = await readCachedPolicyDecisions({ root, outputDir, startDate, endDate });
  const historyLabels = await readDouyinHistoryLabels(xlsxPath, { startDate, endDate });
  const report = buildPolicyEvaluationReport({
    root,
    outputDir,
    xlsxPath,
    startDate,
    endDate,
    cached,
    historyLabels
  });
  const outPath = path.resolve(args.out || path.join(outputDir, `step15-policy-eval-${todayString()}.json`));
  const modelOutPath = path.resolve(args.modelOut || path.join(outputDir, `logistic-policy-model-${todayString()}.json`));
  if (report.logisticModel) {
    report.summary.model.modelPath = modelOutPath;
    await fs.mkdir(path.dirname(modelOutPath), { recursive: true });
    await fs.writeFile(modelOutPath, `${JSON.stringify(report.logisticModel, null, 2)}\n`, "utf8");
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(withoutPrivateModel(report), null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report.summary, outPath }, null, 2));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = argv[++index];
    if (arg === "--output-dir") args.outputDir = argv[++index];
    if (arg === "--xlsx") args.xlsx = argv[++index];
    if (arg === "--start-date") args.startDate = argv[++index];
    if (arg === "--end-date") args.endDate = argv[++index];
    if (arg === "--out") args.out = argv[++index];
    if (arg === "--model-out") args.modelOut = argv[++index];
  }
  return args;
}

async function readCachedPolicyDecisions({ root, outputDir, startDate, endDate }) {
  const fileNames = await fs.readdir(outputDir);
  const cacheFiles = fileNames
    .map((fileName) => {
      const match = fileName.match(/^step15_clean_(\d{4}-\d{2}-\d{2})\.json$/u);
      return match ? { fileName, date: match[1], filePath: path.join(outputDir, fileName) } : null;
    })
    .filter((file) => file && file.date >= startDate && file.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date));

  const entries = [];
  for (const cacheFile of cacheFiles) {
    const payload = await readJson(cacheFile.filePath, {});
    const dateDecisions = [];
    for (const detail of payload.details || []) {
      dateDecisions.push(await cachedDetailToDecision({ root, detail, targetDate: cacheFile.date }));
    }
    const quotaDecisions = applyBatchPassQuota(dateDecisions, process.env);
    for (const decision of quotaDecisions) {
      const calibrated = calibrateStep15Decision(decision);
      entries.push({
        date: cacheFile.date,
        decision,
        sourceRowNumber: decision.sourceRowNumber || decision.sourceRow?.sourceRowNumber || null,
        link: decision.sourceRow?.link || decision.link || "",
        title: fieldText(decision.sourceRow?.fields?.["标题"] || decision.assetBundle?.title || ""),
        account: fieldText(decision.sourceRow?.fields?.["账号"] || ""),
        contentType: fieldText(decision.sourceRow?.fields?.["内容类型"] || ""),
        preliminaryResult: decision.preliminaryResult,
        finalResult: calibrated.result,
        calibration: calibrated.calibration,
        localRisks: decision.localRisks || [],
        quota: decision.quota || null,
        assetDir: decision.assetBundle?.assetDir || ""
      });
    }
  }

  return { cacheFiles, entries };
}

async function cachedDetailToDecision({ root, detail, targetDate }) {
  const assetDir = detail.assetDir || "";
  const sourceRow = await readSourceRow({ assetDir, detail });
  const assetBundle = await readAssetBundle({ root, assetDir, sourceRow, targetDate });
  const preliminaryResult = normalizeCachedResult(detail.preliminaryResult || detail.result);
  const localRisks = Array.isArray(detail.localRisks) && detail.localRisks.length
    ? detail.localRisks
    : [
        ...detectLocalFilterSignals(assetBundle.sourceText),
        ...detectHistoricalFilterPriors(sourceRow)
      ];
  const decisionSource = inferDecisionSource({ detail, assetBundle, localRisks, preliminaryResult });
  return {
    sourceRowNumber: detail.sourceRowNumber,
    sourceRow,
    assetBundle,
    localRisks,
    decisionSource,
    result: preliminaryResult
  };
}

async function readSourceRow({ assetDir, detail }) {
  const sourcePath = assetDir ? path.join(assetDir, "source.json") : "";
  const sourceRow = sourcePath ? await readJson(sourcePath, null) : null;
  const fallback = {
    platformId: "douyin",
    sourceRowNumber: detail.sourceRowNumber,
    fields: {},
    rawRow: [],
    link: detail.link || ""
  };
  return {
    ...fallback,
    ...(sourceRow || {}),
    platformId: "douyin",
    sourceRowNumber: sourceRow?.sourceRowNumber || detail.sourceRowNumber || null,
    link: sourceRow?.link || detail.link || ""
  };
}

async function readAssetBundle({ root, assetDir, sourceRow, targetDate }) {
  const manifestPath = assetDir ? path.join(assetDir, "manifest.json") : "";
  const manifest = manifestPath ? await readJson(manifestPath, {}) : {};
  const asrPath = manifest.asrPath || (assetDir ? path.join(assetDir, "asr.txt") : "");
  const ocrPath = manifest.ocrPath || (assetDir ? path.join(assetDir, "ocr.txt") : "");
  const asrText = asrPath ? await readText(asrPath) : "";
  const ocrText = ocrPath ? await readText(ocrPath) : "";
  const fields = sourceRow.fields || {};
  const sourceText = [
    fields["标题"],
    fields["tag词"],
    fields["TAG词"],
    manifest.title,
    asrText,
    ocrText
  ].filter(Boolean).join("\n");
  return {
    ...manifest,
    ok: manifest.ok !== false,
    platform: "douyin",
    targetDate: manifest.targetDate || targetDate,
    title: manifest.title || fieldText(fields["标题"] || ""),
    assetDir: manifest.assetDir || assetDir || path.join(root, "output", "step15-assets", targetDate, "douyin"),
    asrText,
    ocrText,
    sourceText
  };
}

function inferDecisionSource({ assetBundle, localRisks, preliminaryResult }) {
  if (localRisks.some((risk) => risk.action === "reject")) return "local-reject";
  const combined = [
    preliminaryResult.briefReason,
    ...(preliminaryResult.evidence || []),
    assetBundle.error
  ].filter(Boolean).join("\n");
  if (assetBundle.ok === false || /素材抽取失败/u.test(combined)) return "asset-error";
  if (/(模型筛选失败|Qwen API|MiniMax API|quota|insufficient|429|额度|接口失败)/iu.test(combined)) return "provider-error";
  return "provider";
}

async function readDouyinHistoryLabels(xlsxPath, { startDate, endDate }) {
  const recordsByPlatform = await parseExcelHistoryWorkbook(xlsxPath, { platforms: ["douyin"] });
  const expectedByRow = await readExpectedLabelsByRow(xlsxPath);
  return (recordsByPlatform.douyin || [])
    .map((record) => ({
      ...record,
      expected: expectedByRow.get(record.rowNumber) || ""
    }))
    .filter((record) => record.date >= startDate && record.date <= endDate && record.expected);
}

async function readExpectedLabelsByRow(xlsxPath) {
  const workbookXml = await unzipEntry(xlsxPath, "xl/workbook.xml");
  const relsXml = await unzipEntry(xlsxPath, "xl/_rels/workbook.xml.rels");
  const sharedXml = await unzipEntry(xlsxPath, "xl/sharedStrings.xml").catch(() => "");
  const sharedStrings = parseSharedStrings(sharedXml);
  const sheetPath = resolveSheetPath(workbookXml, relsXml, "抖音渠道");
  const sheetXml = await unzipEntry(xlsxPath, sheetPath);
  const rows = parseRows(sheetXml, sharedStrings);
  const labels = new Map();
  for (const row of rows) {
    const value = String(row.cells[5] || "").trim();
    if (value === "是") labels.set(row.rowNo, "pass");
    if (value === "否") labels.set(row.rowNo, "reject");
  }
  return labels;
}

function buildPolicyEvaluationReport({ root, outputDir, xlsxPath, startDate, endDate, cached, historyLabels }) {
  const historyIndex = buildHistoryIndex(historyLabels);
  const usedHistoryRows = new Set();
  const matchedEntries = cached.entries.map((entry) => {
    const history = matchHistoryLabel(entry, historyIndex, usedHistoryRows);
    if (history?.rowNumber) usedHistoryRows.add(history.rowNumber);
    return {
      ...entry,
      historyExpected: history?.expected || "",
      historyRowNumber: history?.rowNumber || null,
      historyMatchType: history?.matchType || ""
    };
  });
  const labeledExamples = matchedEntries
    .filter((entry) => entry.historyExpected === "pass" || entry.historyExpected === "reject")
    .map((entry) => ({ label: entry.historyExpected, item: entry.decision }));
  const logisticModel = labeledExamples.length
    ? buildLogisticPolicyModel(labeledExamples, { passRetentionTarget: DEFAULT_PASS_RETENTION_TARGET })
    : null;
  const crossValidation = evaluateLogisticPolicyByDate(matchedEntries, {
    passRetentionTarget: DEFAULT_PASS_RETENTION_TARGET
  });
  const entries = matchedEntries.map((entry) => {
    const logisticDecision = classifyLogisticPolicy(logisticModel, entry.decision);
    const calibrated = calibrateStep15Decision(entry.decision, { logisticModel });
    return {
      ...entry,
      preliminaryResult: entry.preliminaryResult,
      finalResult: calibrated.result,
      calibration: calibrated.calibration,
      logisticProbability: logisticDecision?.probability ?? null,
      logisticThreshold: logisticDecision?.threshold ?? null
    };
  });
  const matchedHistoryRows = new Set(entries.map((entry) => entry.historyRowNumber).filter(Boolean));
  const unmatchedHistory = historyLabels.filter((record) => !matchedHistoryRows.has(record.rowNumber));
  const matrix = emptyMatrix();
  for (const entry of entries) {
    if (!entry.historyExpected) continue;
    matrix[entry.historyExpected][entry.finalResult.status] += 1;
  }

  const currentSummary = countByStatus(entries.map((entry) => entry.finalResult.status));
  const historyPassTotal = matrix.pass.pass + matrix.pass.reject + matrix.pass.review;
  const historyRejectTotal = matrix.reject.pass + matrix.reject.reject + matrix.reject.review;
  const rates = {
    historicalPassRetention: safeRate(matrix.pass.pass, historyPassTotal),
    historicalRejectMispass: safeRate(matrix.reject.pass, historyRejectTotal),
    manualReview: safeRate(currentSummary.review, entries.length)
  };
  const benchmarks = {
    historicalPassRetentionAtLeast: DEFAULT_PASS_RETENTION_TARGET,
    manualReviewAtMost: 0.2
  };
  const summary = {
    ok: rates.historicalPassRetention >= benchmarks.historicalPassRetentionAtLeast
      && rates.manualReview <= benchmarks.manualReviewAtMost,
    generatedAt: new Date().toISOString(),
    scope: { startDate, endDate },
    source: {
      root,
      outputDir,
      historyExcel: xlsxPath,
      cacheFiles: cached.cacheFiles.length
    },
    currentRows: entries.length,
    currentSummary,
    historyLabels: {
      total: historyLabels.length,
      pass: historyLabels.filter((record) => record.expected === "pass").length,
      reject: historyLabels.filter((record) => record.expected === "reject").length,
      matchedToCurrent: entries.filter((entry) => entry.historyExpected).length,
      unmatchedHistory: unmatchedHistory.length
    },
    evaluationMatrix: matrix,
    rates,
    benchmarks,
    model: {
      kind: logisticModel?.kind || "",
      passRetentionTarget: logisticModel?.passRetentionTarget || DEFAULT_PASS_RETENTION_TARGET,
      threshold: logisticModel?.threshold ?? null,
      trainingSummary: logisticModel?.trainingSummary || null
    },
    crossValidation,
    leakageProtection: {
      historyLabelsUsedForTraining: Boolean(logisticModel),
      historyLabelsUsedForDirectDecision: false,
      decisionInputs: ["localRules", "cachedQwenPreliminaryResult", "assetExtractionStatus", "riskSignals", "batchQuotaMetadata", "logisticPolicyFeatures"]
    },
    byDate: buildByDate(entries)
  };

  return {
    summary,
    logisticModel,
    entries: entries.map((entry) => serializeEntry(entry)),
    unmatchedHistory: unmatchedHistory.map((record) => serializeHistory(record))
  };
}

function evaluateLogisticPolicyByDate(entries = [], { passRetentionTarget = DEFAULT_PASS_RETENTION_TARGET } = {}) {
  const labeled = entries.filter((entry) => entry.historyExpected === "pass" || entry.historyExpected === "reject");
  const dates = [...new Set(labeled.map((entry) => entry.date))].sort();
  const aggregateMatrix = {
    pass: { pass: 0, reject: 0 },
    reject: { pass: 0, reject: 0 }
  };
  const byDate = {};
  for (const date of dates) {
    const trainingEntries = labeled.filter((entry) => entry.date !== date);
    const testEntries = labeled.filter((entry) => entry.date === date);
    if (!trainingEntries.some((entry) => entry.historyExpected === "pass")
      || !trainingEntries.some((entry) => entry.historyExpected === "reject")) {
      continue;
    }
    const model = buildLogisticPolicyModel(trainingEntries.map((entry) => ({
      label: entry.historyExpected,
      item: entry.decision
    })), { passRetentionTarget });
    const predictions = testEntries
      .map((entry) => {
        const decision = classifyLogisticPolicy(model, entry.decision);
        return decision ? {
          label: entry.historyExpected,
          probability: decision.probability
        } : null;
      })
      .filter(Boolean);
    const metrics = evaluateLogisticPolicyPredictions(predictions, model.threshold);
    addLogisticMatrix(aggregateMatrix, metrics.matrix);
    byDate[date] = {
      total: predictions.length,
      threshold: model.threshold,
      ...metrics
    };
  }
  return {
    folds: Object.keys(byDate).length,
    matrix: aggregateMatrix,
    rates: logisticRatesFromMatrix(aggregateMatrix),
    byDate
  };
}

function addLogisticMatrix(target, source) {
  for (const expected of ["pass", "reject"]) {
    for (const predicted of ["pass", "reject"]) {
      target[expected][predicted] += source?.[expected]?.[predicted] || 0;
    }
  }
}

function logisticRatesFromMatrix(matrix) {
  const passTotal = matrix.pass.pass + matrix.pass.reject;
  const rejectTotal = matrix.reject.pass + matrix.reject.reject;
  return {
    historicalPassRetention: safeRate(matrix.pass.pass, passTotal),
    historicalRejectMispass: safeRate(matrix.reject.pass, rejectTotal)
  };
}

function buildHistoryIndex(historyLabels) {
  const byLink = new Map();
  const byFallback = new Map();
  for (const record of historyLabels) {
    addIndexValue(byLink, linkKey(record.link), record);
    addIndexValue(byFallback, fallbackKey({
      date: record.date,
      title: record.title || record.rawText,
      account: record.accountName,
      contentType: record.contentType
    }), record);
  }
  return { byLink, byFallback };
}

function matchHistoryLabel(entry, index, usedHistoryRows = new Set()) {
  const linkMatches = uniqueMatches(index.byLink.get(linkKey(entry.link)), usedHistoryRows);
  if (linkMatches.length === 1) return { ...linkMatches[0], matchType: "link" };
  const fallbackMatches = uniqueMatches(index.byFallback.get(fallbackKey(entry)), usedHistoryRows);
  if (fallbackMatches.length === 1) return { ...fallbackMatches[0], matchType: "date_title_account_type" };
  return null;
}

function serializeEntry(entry) {
  return {
    date: entry.date,
    sourceRowNumber: entry.sourceRowNumber,
    link: entry.link,
    title: entry.title,
    account: entry.account,
    contentType: entry.contentType,
    preliminaryStatus: entry.preliminaryResult.status,
    finalStatus: entry.finalResult.status,
    briefReason: entry.finalResult.briefReason,
    calibrationSource: entry.calibration.source,
    calibrationReason: entry.calibration.reason,
    calibrationSignals: entry.calibration.signals,
    logisticProbability: entry.logisticProbability,
    logisticThreshold: entry.logisticThreshold,
    localRuleIds: entry.localRisks.map((risk) => risk.ruleId).filter(Boolean),
    quota: entry.quota,
    historyExpected: entry.historyExpected,
    historyRowNumber: entry.historyRowNumber,
    historyMatchType: entry.historyMatchType,
    assetDir: entry.assetDir
  };
}

function serializeHistory(record) {
  return {
    rowNumber: record.rowNumber,
    date: record.date,
    link: record.link,
    title: record.title,
    account: record.accountName,
    contentType: record.contentType,
    expected: record.expected
  };
}

function buildByDate(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.date) || {
      total: 0,
      pass: 0,
      reject: 0,
      review: 0,
      historyMatched: 0
    };
    group.total += 1;
    group[entry.finalResult.status] += 1;
    if (entry.historyExpected) group.historyMatched += 1;
    groups.set(entry.date, group);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function countByStatus(statuses) {
  const counts = Object.fromEntries(STATUS_VALUES.map((status) => [status, 0]));
  for (const status of statuses) {
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  }
  return counts;
}

function emptyMatrix() {
  return {
    pass: { pass: 0, reject: 0, review: 0 },
    reject: { pass: 0, reject: 0, review: 0 }
  };
}

function normalizeCachedResult(result = {}) {
  const status = STATUS_VALUES.includes(result.status) ? result.status : "review";
  return {
    status,
    ruleIds: Array.isArray(result.ruleIds) ? result.ruleIds.filter(Boolean) : [],
    briefReason: String(result.briefReason || "").trim() || (status === "pass" ? "未发现不投放风险。" : "需要人工复核。"),
    evidence: Array.isArray(result.evidence) ? result.evidence : []
  };
}

function addIndexValue(map, key, value) {
  if (!key) return;
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function uniqueMatches(matches = [], usedHistoryRows = new Set()) {
  const byRow = new Map();
  for (const match of matches) {
    if (usedHistoryRows.has(match.rowNumber)) continue;
    byRow.set(match.rowNumber, match);
  }
  return [...byRow.values()];
}

function linkKey(value) {
  return canonicalizeContentLink("douyin", extractFeishuCellLink(value) || String(value || "")).replace(/\/+$/u, "");
}

function fallbackKey({ date, title, account, contentType }) {
  const titleKey = normalizeTitleKey(title);
  if (!date || !titleKey) return "";
  return [
    date,
    titleKey,
    normalizeAccountLabel("douyin", fieldText(account || "")),
    fieldText(contentType || "")
  ].join("\t");
}

function normalizeTitleKey(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+.*$/su, "")
    .replace(/#[^#]+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 80);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readText(filePath) {
  return await fs.readFile(filePath, "utf8").catch(() => "");
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
    if (target.startsWith("/")) return target.slice(1);
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

function safeRate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function fieldText(value) {
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    if (Array.isArray(value.values)) return value.values.map((item) => fieldText(item)).filter(Boolean).join("、");
    return String(value.text || value.link || value.url || "");
  }
  return String(value || "");
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function withoutPrivateModel(report) {
  const { logisticModel, ...rest } = report;
  return rest;
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
