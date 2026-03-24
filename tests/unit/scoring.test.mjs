/**
 * Unit tests for the shared scoring formula and Solana mint validation.
 * Run with: node --test tests/unit/scoring.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Inline the scoring logic from packages/shared to avoid build step ───────

const v2Weights = { controlPct: 0.4, usdHeld: 0.35, overlapCount: 0.25 };

function clamp01(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalize(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp01(value / max);
}

function calculateActiveScanScore(input) {
  const normalizedControlPct = normalize(input.controlPct, input.maxControlPct);
  const normalizedTotalUsdHeld = normalize(input.totalUsdHeld, input.maxTotalUsdHeld);
  const normalizedOverlapCount = normalize(input.overlapCount, input.maxOverlapCount);

  const finalScore =
    normalizedControlPct * v2Weights.controlPct +
    normalizedTotalUsdHeld * v2Weights.usdHeld +
    normalizedOverlapCount * v2Weights.overlapCount;

  return {
    normalizedControlPct,
    normalizedTotalUsdHeld,
    normalizedOverlapCount,
    finalScore: Number(finalScore.toFixed(6))
  };
}

// ─── Inline the mint validation from apps/api/src/lib/solana.ts ──────────────

function base58Decode(str) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const alphabetMap = new Map(ALPHABET.split("").map((c, i) => [c, BigInt(i)]));
  let n = BigInt(0);
  for (const char of str) {
    const digit = alphabetMap.get(char);
    if (digit === undefined) throw new Error("Invalid base58 character");
    n = n * BigInt(58) + digit;
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  for (const char of str) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function assertValidSolanaMint(mint) {
  const trimmed = mint.trim();
  try {
    const decoded = base58Decode(trimmed);
    if (decoded.length !== 32) throw new Error("Invalid address length");
  } catch {
    throw new Error("mint must be a valid 32-byte Solana address.");
  }
  return trimmed;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("calculateActiveScanScore", () => {
  test("scores maximum possible values as 1.0", () => {
    const result = calculateActiveScanScore({
      controlPct: 1,
      totalUsdHeld: 1000,
      overlapCount: 50,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });

    assert.equal(result.normalizedControlPct, 1);
    assert.equal(result.normalizedTotalUsdHeld, 1);
    assert.equal(result.normalizedOverlapCount, 1);
    assert.equal(result.finalScore, 1);
  });

  test("scores all zeros as 0.0", () => {
    const result = calculateActiveScanScore({
      controlPct: 0,
      totalUsdHeld: 0,
      overlapCount: 0,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });

    assert.equal(result.normalizedControlPct, 0);
    assert.equal(result.normalizedTotalUsdHeld, 0);
    assert.equal(result.normalizedOverlapCount, 0);
    assert.equal(result.finalScore, 0);
  });

  test("applies correct weight distribution (0.4 / 0.35 / 0.25)", () => {
    // Only control at 100%, others zero
    const controlOnly = calculateActiveScanScore({
      controlPct: 1,
      totalUsdHeld: 0,
      overlapCount: 0,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });
    assert.equal(controlOnly.finalScore, 0.4);

    // Only USD at 100%, others zero
    const usdOnly = calculateActiveScanScore({
      controlPct: 0,
      totalUsdHeld: 1000,
      overlapCount: 0,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });
    assert.equal(usdOnly.finalScore, 0.35);

    // Only overlap at 100%, others zero
    const overlapOnly = calculateActiveScanScore({
      controlPct: 0,
      totalUsdHeld: 0,
      overlapCount: 50,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });
    assert.equal(overlapOnly.finalScore, 0.25);
  });

  test("clamps scores above max to 1.0", () => {
    const result = calculateActiveScanScore({
      controlPct: 2,
      totalUsdHeld: 5000,
      overlapCount: 200,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });

    assert.equal(result.normalizedControlPct, 1);
    assert.equal(result.normalizedTotalUsdHeld, 1);
    assert.equal(result.normalizedOverlapCount, 1);
    assert.equal(result.finalScore, 1);
  });

  test("returns finalScore with 6 decimal precision", () => {
    const result = calculateActiveScanScore({
      controlPct: 0.5,
      totalUsdHeld: 500,
      overlapCount: 25,
      maxControlPct: 1,
      maxTotalUsdHeld: 1000,
      maxOverlapCount: 50
    });

    // All components at 0.5, so finalScore = 0.5
    assert.equal(result.finalScore, 0.5);
    assert.equal(result.normalizedControlPct, 0.5);
  });

  test("handles non-finite max values gracefully", () => {
    const result = calculateActiveScanScore({
      controlPct: 0.5,
      totalUsdHeld: 500,
      overlapCount: 25,
      maxControlPct: 0,
      maxTotalUsdHeld: 0,
      maxOverlapCount: 0
    });

    assert.equal(result.normalizedControlPct, 0);
    assert.equal(result.normalizedTotalUsdHeld, 0);
    assert.equal(result.normalizedOverlapCount, 0);
    assert.equal(result.finalScore, 0);
  });

  test("partial scores rank tokens correctly", () => {
    const highControl = calculateActiveScanScore({
      controlPct: 0.8,
      totalUsdHeld: 100,
      overlapCount: 5,
      maxControlPct: 1,
      maxTotalUsdHeld: 10000,
      maxOverlapCount: 50
    });

    const highOverlap = calculateActiveScanScore({
      controlPct: 0.1,
      totalUsdHeld: 100,
      overlapCount: 45,
      maxControlPct: 1,
      maxTotalUsdHeld: 10000,
      maxOverlapCount: 50
    });

    // highControl has 0.8 on the 0.4-weighted dimension; highOverlap has 0.9 on 0.25-weighted
    // highControl.finalScore = 0.4*0.8 + 0.35*0.01 + 0.25*0.1
    // highOverlap.finalScore = 0.4*0.1 + 0.35*0.01 + 0.25*0.9
    assert.ok(highControl.finalScore > highOverlap.finalScore, "high-control token should score above high-overlap token");
  });
});

describe("assertValidSolanaMint", () => {
  test("accepts a valid Solana mint address", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const result = assertValidSolanaMint(mint);
    assert.equal(result, mint);
  });

  test("trims surrounding whitespace", () => {
    const mint = "  So11111111111111111111111111111111111111112  ";
    const result = assertValidSolanaMint(mint);
    assert.equal(result, "So11111111111111111111111111111111111111112");
  });

  test("rejects a too-short address", () => {
    assert.throws(() => assertValidSolanaMint("short"), /valid 32-byte Solana address/);
  });

  test("rejects an empty string", () => {
    assert.throws(() => assertValidSolanaMint(""), /valid 32-byte Solana address/);
  });

  test("rejects an address with invalid characters", () => {
    assert.throws(
      () => assertValidSolanaMint("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0O"),
      /valid 32-byte Solana address/
    );
  });
});

describe("infrastructure wallet filter", () => {
  const INFRA_WALLETS = [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "Vote111111111111111111111111111111111111111",
    "Sysvar1111111111111111111111111111111111111"
  ];

  function isLikelyInfrastructureWallet(address) {
    return INFRA_WALLETS.includes(address);
  }

  test("marks system program as infrastructure", () => {
    assert.ok(isLikelyInfrastructureWallet("11111111111111111111111111111111"));
  });

  test("marks token program as infrastructure", () => {
    assert.ok(isLikelyInfrastructureWallet("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  });

  test("does not mark a regular wallet as infrastructure", () => {
    assert.ok(!isLikelyInfrastructureWallet("So11111111111111111111111111111111111111112"));
  });
});
