/**
 * Unit tests for V2 API route query/body validation schemas.
 * Tests are inline (no build step required) and mirror the Zod schemas
 * used in apps/api/src/routes/*.
 *
 * Run with: node --test tests/unit/routes.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Inline alert/universe pagination schema ──────────────────────────────────

function parseAlertsQuery(raw) {
  const limit = raw.limit !== undefined ? Number(raw.limit) : 25;
  const offset = raw.offset !== undefined ? Number(raw.offset) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  return { limit, offset };
}

function parseUniverseQuery(raw) {
  const limit = raw.limit !== undefined ? Number(raw.limit) : 50;
  const offset = raw.offset !== undefined ? Number(raw.offset) : 0;
  const minMarketCap = raw.minMarketCap !== undefined ? Number(raw.minMarketCap) : 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  if (!Number.isFinite(minMarketCap) || minMarketCap < 0) {
    throw new Error("minMarketCap must be a non-negative number");
  }
  return { limit, offset, minMarketCap };
}

// ─── Inline job-trigger body schemas ─────────────────────────────────────────

function parseUniverseRefreshBody(raw) {
  if (!Array.isArray(raw.mints) || raw.mints.length === 0) {
    throw new Error("mints must be a non-empty array");
  }
  if (raw.mints.some((m) => typeof m !== "string" || m.trim() === "")) {
    throw new Error("each mint must be a non-empty string");
  }
  return { mints: raw.mints };
}

function parseHolderSnapshotBody(raw) {
  if (typeof raw.mint !== "string" || raw.mint.trim() === "") {
    throw new Error("mint must be a non-empty string");
  }
  return { mint: raw.mint.trim() };
}

function parseControlComputationBody(raw) {
  if (typeof raw.sourceMint !== "string" || raw.sourceMint.trim() === "") {
    throw new Error("sourceMint must be a non-empty string");
  }
  if (raw.targetMints !== undefined) {
    if (!Array.isArray(raw.targetMints)) {
      throw new Error("targetMints must be an array when provided");
    }
  }
  return {
    sourceMint: raw.sourceMint.trim(),
    targetMints: raw.targetMints ?? undefined
  };
}

// ─── Tests: /v1/alerts query ──────────────────────────────────────────────────

describe("GET /v1/alerts query schema", () => {
  test("accepts default parameters", () => {
    const result = parseAlertsQuery({});
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 0);
  });

  test("accepts explicit limit and offset", () => {
    const result = parseAlertsQuery({ limit: "10", offset: "20" });
    assert.equal(result.limit, 10);
    assert.equal(result.offset, 20);
  });

  test("rejects limit below 1", () => {
    assert.throws(() => parseAlertsQuery({ limit: "0" }), /limit must be an integer/);
  });

  test("rejects limit above 100", () => {
    assert.throws(() => parseAlertsQuery({ limit: "101" }), /limit must be an integer/);
  });

  test("rejects negative offset", () => {
    assert.throws(() => parseAlertsQuery({ offset: "-1" }), /offset must be a non-negative integer/);
  });

  test("accepts boundary values: limit=1 offset=0", () => {
    const result = parseAlertsQuery({ limit: "1", offset: "0" });
    assert.equal(result.limit, 1);
    assert.equal(result.offset, 0);
  });

  test("accepts boundary values: limit=100", () => {
    const result = parseAlertsQuery({ limit: "100" });
    assert.equal(result.limit, 100);
  });
});

// ─── Tests: /v1/universe query ────────────────────────────────────────────────

describe("GET /v1/universe query schema", () => {
  test("accepts default parameters", () => {
    const result = parseUniverseQuery({});
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);
    assert.equal(result.minMarketCap, 0);
  });

  test("accepts minMarketCap override", () => {
    const result = parseUniverseQuery({ minMarketCap: "10000" });
    assert.equal(result.minMarketCap, 10_000);
  });

  test("rejects negative minMarketCap", () => {
    assert.throws(() => parseUniverseQuery({ minMarketCap: "-1" }), /minMarketCap must be a non-negative number/);
  });

  test("rejects limit above 100", () => {
    assert.throws(() => parseUniverseQuery({ limit: "200" }), /limit must be an integer/);
  });

  test("accepts float minMarketCap", () => {
    const result = parseUniverseQuery({ minMarketCap: "5000.5" });
    assert.ok(result.minMarketCap === 5000.5);
  });
});

// ─── Tests: POST /v1/jobs/universe-refresh body ───────────────────────────────

describe("POST /v1/jobs/universe-refresh body schema", () => {
  test("accepts a non-empty mints array", () => {
    const result = parseUniverseRefreshBody({ mints: ["So11111111111111111111111111111111111111112"] });
    assert.deepEqual(result.mints, ["So11111111111111111111111111111111111111112"]);
  });

  test("accepts multiple mints", () => {
    const mints = [
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    ];
    const result = parseUniverseRefreshBody({ mints });
    assert.equal(result.mints.length, 2);
  });

  test("rejects empty mints array", () => {
    assert.throws(() => parseUniverseRefreshBody({ mints: [] }), /non-empty array/);
  });

  test("rejects missing mints field", () => {
    assert.throws(() => parseUniverseRefreshBody({}), /non-empty array/);
  });

  test("rejects array containing empty strings", () => {
    assert.throws(() => parseUniverseRefreshBody({ mints: [""] }), /non-empty string/);
  });
});

// ─── Tests: POST /v1/jobs/holder-snapshot body ────────────────────────────────

describe("POST /v1/jobs/holder-snapshot body schema", () => {
  test("accepts a valid mint", () => {
    const result = parseHolderSnapshotBody({ mint: "So11111111111111111111111111111111111111112" });
    assert.equal(result.mint, "So11111111111111111111111111111111111111112");
  });

  test("trims surrounding whitespace", () => {
    const result = parseHolderSnapshotBody({ mint: "  So11111111111111111111111111111111111111112  " });
    assert.equal(result.mint, "So11111111111111111111111111111111111111112");
  });

  test("rejects empty mint", () => {
    assert.throws(() => parseHolderSnapshotBody({ mint: "" }), /non-empty string/);
  });

  test("rejects missing mint", () => {
    assert.throws(() => parseHolderSnapshotBody({}), /non-empty string/);
  });
});

// ─── Tests: POST /v1/jobs/control-computation body ───────────────────────────

describe("POST /v1/jobs/control-computation body schema", () => {
  test("accepts sourceMint only", () => {
    const result = parseControlComputationBody({ sourceMint: "So11111111111111111111111111111111111111112" });
    assert.equal(result.sourceMint, "So11111111111111111111111111111111111111112");
    assert.equal(result.targetMints, undefined);
  });

  test("accepts sourceMint with targetMints array", () => {
    const result = parseControlComputationBody({
      sourceMint: "So11111111111111111111111111111111111111112",
      targetMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
    });
    assert.ok(Array.isArray(result.targetMints));
    assert.equal(result.targetMints?.length, 1);
  });

  test("rejects empty sourceMint", () => {
    assert.throws(() => parseControlComputationBody({ sourceMint: "" }), /non-empty string/);
  });

  test("rejects targetMints as non-array", () => {
    assert.throws(
      () => parseControlComputationBody({ sourceMint: "So11111111111111111111111111111111111111112", targetMints: "bad" }),
      /array/
    );
  });
});
