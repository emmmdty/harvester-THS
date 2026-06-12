export const DEFAULT_MATERIAL_FAILURE_RATE_THRESHOLD = 0.3;
export const DEFAULT_MATERIAL_CONSECUTIVE_FAILURE_THRESHOLD = 10;
export const DEFAULT_MATERIAL_FAILURE_RATE_MIN_TOTAL = 10;

export function shouldBlockFeishuWriteback({
  total = 0,
  failed = 0,
  consecutiveFailures = 0,
  failureRateThreshold = DEFAULT_MATERIAL_FAILURE_RATE_THRESHOLD,
  consecutiveFailureThreshold = DEFAULT_MATERIAL_CONSECUTIVE_FAILURE_THRESHOLD,
  failureRateMinTotal = DEFAULT_MATERIAL_FAILURE_RATE_MIN_TOTAL
} = {}) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  const normalizedFailed = Math.max(0, Number(failed) || 0);
  const normalizedConsecutive = Math.max(0, Number(consecutiveFailures) || 0);
  const failureRate = normalizedTotal > 0 ? normalizedFailed / normalizedTotal : 0;
  const blockedByRate = normalizedTotal >= Number(failureRateMinTotal) && failureRate >= Number(failureRateThreshold);
  const blockedByConsecutive = normalizedConsecutive >= Number(consecutiveFailureThreshold);
  const blocked = blockedByRate || blockedByConsecutive;
  const reason = blockedByRate
    ? `素材获取失败率达到阈值：${normalizedFailed}/${normalizedTotal}，优先处理素材获取。`
    : blockedByConsecutive
      ? `素材连续获取失败达到阈值：${normalizedConsecutive} 条，优先处理素材获取。`
      : "";
  return {
    blocked,
    reason,
    failureRate,
    total: normalizedTotal,
    failed: normalizedFailed,
    consecutiveFailures: normalizedConsecutive
  };
}
