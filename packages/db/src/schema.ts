import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";
import { jobStatuses, launchProtocols, liquidityProtocols, migrationStates } from "@cabalfinder/shared";

export const launchProtocolEnum = pgEnum("launch_protocol", launchProtocols);
export const liquidityProtocolEnum = pgEnum("liquidity_protocol", liquidityProtocols);
export const migrationStateEnum = pgEnum("migration_state", migrationStates);
export const jobStatusEnum = pgEnum("job_status", jobStatuses);

export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    symbol: varchar("symbol", { length: 32 }),
    name: varchar("name", { length: 128 }),
    decimals: integer("decimals"),
    currentMarketCapUsd: doublePrecision("current_market_cap_usd"),
    athUsd: doublePrecision("ath_usd"),
    liquidityUsd: doublePrecision("liquidity_usd"),
    circulatingSupply: doublePrecision("circulating_supply"),
    totalSupply: doublePrecision("total_supply"),
    primaryQuoteToken: varchar("primary_quote_token", { length: 64 }),
    launchProtocol: launchProtocolEnum("launch_protocol").default("unknown").notNull(),
    migrationState: migrationStateEnum("migration_state").default("unknown").notNull(),
    liquidityProtocols: jsonb("liquidity_protocols").$type<Array<(typeof liquidityProtocols)[number]>>().default([]).notNull(),
    riskFlags: jsonb("risk_flags").$type<string[]>().default([]).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    mintUnique: uniqueIndex("tokens_mint_unique").on(table.mint)
  })
);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    address: varchar("address", { length: 64 }).notNull(),
    labels: jsonb("labels").$type<string[]>().default([]).notNull(),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    qualityFlags: jsonb("quality_flags").$type<string[]>().default([]).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    addressUnique: uniqueIndex("wallets_address_unique").on(table.address)
  })
);

export const walletPositions = pgTable(
  "wallet_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id")
      .references(() => wallets.id, { onDelete: "cascade" })
      .notNull(),
    tokenId: uuid("token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    balance: doublePrecision("balance").notNull(),
    usdValue: doublePrecision("usd_value"),
    source: varchar("source", { length: 32 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    walletObservedIdx: index("wallet_positions_wallet_observed_idx").on(table.walletId, table.observedAt),
    tokenObservedIdx: index("wallet_positions_token_observed_idx").on(table.tokenId, table.observedAt)
  })
);

export const holderSnapshots = pgTable(
  "holder_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenId: uuid("token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    walletId: uuid("wallet_id")
      .references(() => wallets.id, { onDelete: "cascade" })
      .notNull(),
    snapshotTime: timestamp("snapshot_time", { withTimezone: true }).notNull(),
    holderRank: integer("holder_rank").notNull(),
    amount: doublePrecision("amount").notNull(),
    shareOfSupply: doublePrecision("share_of_supply").notNull()
  },
  (table) => ({
    tokenSnapshotIdx: index("holder_snapshots_token_snapshot_idx").on(table.tokenId, table.snapshotTime),
    uniqueSnapshotHolder: uniqueIndex("holder_snapshots_unique_row").on(table.tokenId, table.walletId, table.snapshotTime)
  })
);

export const controlEdges = pgTable(
  "control_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceTokenId: uuid("source_token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    targetTokenId: uuid("target_token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    snapshotTime: timestamp("snapshot_time", { withTimezone: true }).notNull(),
    overlapWalletCount: integer("overlap_wallet_count").notNull(),
    totalUnitsHeld: doublePrecision("total_units_held").notNull(),
    totalUsdHeld: doublePrecision("total_usd_held").notNull(),
    supplyControlPct: doublePrecision("supply_control_pct").notNull(),
    weightedScore: doublePrecision("weighted_score")
  },
  (table) => ({
    sourceTargetIdx: index("control_edges_source_target_idx").on(table.sourceTokenId, table.targetTokenId, table.snapshotTime)
  })
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceTokenId: uuid("source_token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    targetTokenId: uuid("target_token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).defaultNow().notNull(),
    previousControlPct: doublePrecision("previous_control_pct").notNull(),
    supplyControlPct: doublePrecision("supply_control_pct").notNull(),
    overlapWalletCount: integer("overlap_wallet_count").notNull(),
    totalUsdHeld: doublePrecision("total_usd_held").notNull(),
    topContributors: jsonb("top_contributors").$type<Array<{ wallet: string; amount: number }>>().default([]).notNull(),
    telegramDelivered: boolean("telegram_delivered").default(false).notNull(),
    cooldownKey: varchar("cooldown_key", { length: 256 }).notNull()
  },
  (table) => ({
    cooldownIdx: index("alerts_cooldown_idx").on(table.cooldownKey, table.triggeredAt)
  })
);

export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inputMint: varchar("input_mint", { length: 64 }).notNull(),
    status: jobStatusEnum("status").default("pending").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    snapshotVersion: varchar("snapshot_version", { length: 128 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull()
  },
  (table) => ({
    statusIdx: index("scan_runs_status_idx").on(table.status, table.startedAt)
  })
);

export const scanResults = pgTable(
  "scan_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scanRunId: uuid("scan_run_id")
      .references(() => scanRuns.id, { onDelete: "cascade" })
      .notNull(),
    tokenId: uuid("token_id")
      .references(() => tokens.id, { onDelete: "cascade" })
      .notNull(),
    resultRank: integer("result_rank").notNull(),
    overlapWalletCount: integer("overlap_wallet_count").notNull(),
    totalUsdHeld: doublePrecision("total_usd_held").notNull(),
    supplyControlPct: doublePrecision("supply_control_pct").notNull(),
    marketCapUsd: doublePrecision("market_cap_usd").notNull(),
    athUsd: doublePrecision("ath_usd"),
    weightedScore: doublePrecision("weighted_score").notNull()
  },
  (table) => ({
    runRankUnique: uniqueIndex("scan_results_run_rank_unique").on(table.scanRunId, table.resultRank)
  })
);

export const tokensRelations = relations(tokens, ({ many }) => ({
  holderSnapshots: many(holderSnapshots),
  walletPositions: many(walletPositions)
}));

export const walletsRelations = relations(wallets, ({ many }) => ({
  holderSnapshots: many(holderSnapshots),
  walletPositions: many(walletPositions)
}));
