export function resolveXhsPublishedAt({ detailPublishedAt, statePublishedAt, detailBlocked = false }) {
  if (detailBlocked) return null;
  return detailPublishedAt || statePublishedAt || null;
}

export function createXhsDetailRiskGuard({ stopAfter = 2 } = {}) {
  const limit = Math.max(1, Number(stopAfter) || 1);
  let consecutiveBlocked = 0;

  return {
    record(detail) {
      if (detail?.blocked) {
        consecutiveBlocked += 1;
      } else {
        consecutiveBlocked = 0;
      }

      return {
        consecutiveBlocked,
        shouldStop: consecutiveBlocked >= limit
      };
    }
  };
}
