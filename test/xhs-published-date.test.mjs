import test from "node:test";
import assert from "node:assert/strict";
import { createXhsDetailRiskGuard, resolveXhsPublishedAt } from "../src/xhs-published-date.mjs";

test("XHS publish date resolution prefers the detail page publish date", () => {
  const detailPublishedAt = new Date(2026, 4, 19);
  const statePublishedAt = new Date(2026, 4, 20);

  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt, statePublishedAt }),
    detailPublishedAt
  );
});

test("XHS publish date resolution falls back to the state publish date", () => {
  const statePublishedAt = new Date(2026, 4, 20);

  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt: null, statePublishedAt }),
    statePublishedAt
  );
});

test("XHS blocked details do not fall back to state publish dates", () => {
  const statePublishedAt = new Date(2026, 4, 24);

  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt: null, statePublishedAt, detailBlocked: true }),
    null
  );
});

test("XHS detail risk guard stops after consecutive blocked details", () => {
  const guard = createXhsDetailRiskGuard({ stopAfter: 2 });

  assert.deepEqual(guard.record({ blocked: true }), {
    consecutiveBlocked: 1,
    shouldStop: false
  });
  assert.deepEqual(guard.record({ publishedAt: new Date(2026, 4, 24) }), {
    consecutiveBlocked: 0,
    shouldStop: false
  });
  assert.deepEqual(guard.record({ blocked: true }), {
    consecutiveBlocked: 1,
    shouldStop: false
  });
  assert.deepEqual(guard.record({ blocked: true }), {
    consecutiveBlocked: 2,
    shouldStop: true
  });
});

test("XHS publish date resolution returns null when no publish date is available", () => {
  assert.equal(
    resolveXhsPublishedAt({ detailPublishedAt: null, statePublishedAt: null }),
    null
  );
});
