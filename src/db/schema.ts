import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Tenancy schema (spec: Dev/Areas/ai-bills/specs/2026-09-21-multi-tenancy.md). Every table that
 * holds tenant data carries `tenant_id`; the RLS policies in drizzle/*_rls.sql restrict each
 * connection to the tenant named by `app.tenant_id` (set per transaction by withTenant()).
 *
 * `clerk_org_id` stays null until a tenant needs a team; membership is our own table so the
 * identity provider's plan never decides who a tenant is.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  clerkOrgId: text('clerk_org_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('tenants_slug_idx').on(table.slug)]);

export const memberships = pgTable('memberships', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  clerkUserId: text('clerk_user_id').notNull(),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('memberships_tenant_user_idx').on(table.tenantId, table.clerkUserId), index('memberships_user_idx').on(table.clerkUserId)]);

/** Only the SHA-256 of a token is stored; the collector holds the plaintext. */
export const ingestTokens = pgTable('ingest_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sha256: text('sha256').notNull(),
  label: text('label').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [uniqueIndex('ingest_tokens_sha256_idx').on(table.sha256), index('ingest_tokens_tenant_idx').on(table.tenantId)]);

/**
 * Read-only tokens for devices (a desktop widget, a status bar): they may call `GET /api/widget` and
 * nothing else — never ingest, never a browser mutation. Same storage rule as ingest tokens: only the
 * SHA-256 is kept, the device holds the plaintext; a revoked row stops working at once.
 */
export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sha256: text('sha256').notNull(),
  label: text('label').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [uniqueIndex('device_tokens_sha256_idx').on(table.sha256), index('device_tokens_tenant_idx').on(table.tenantId)]);

/** Whole collector snapshots as received; retention is the last SNAPSHOT_RETENTION per tenant (see snapshot-store). */
export const snapshots = pgTable('snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  bytes: integer('bytes').notNull(),
  body: jsonb('body').notNull(),
}, table => [index('snapshots_tenant_received_idx').on(table.tenantId, table.receivedAt)]);

/**
 * One row per quota observation the collector reported (claude_usage / codex_usage entries),
 * kept indefinitely: the first quota history the product has. `source` and `direct` carry the
 * fallback provenance introduced in PR #55; `windows` is the provider payload as observed.
 */
export const quotaObservations = pgTable('quota_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  snapshotId: uuid('snapshot_id').references(() => snapshots.id, { onDelete: 'set null' }),
  provider: text('provider', { enum: ['claude', 'codex'] }).notNull(),
  accountKey: text('account_key').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  ok: boolean('ok').notNull(),
  status: integer('status'),
  source: text('source', { enum: ['direct', 'proxy_headers', 'retained'] }).notNull().default('direct'),
  error: text('error'),
  direct: jsonb('direct'),
  windows: jsonb('windows'),
}, table => [
  index('quota_observations_tenant_account_idx').on(table.tenantId, table.provider, table.accountKey, table.observedAt),
  // The same observation arrives with every snapshot until the collector observes again; store it once.
  uniqueIndex('quota_observations_unique_idx').on(table.tenantId, table.provider, table.accountKey, table.observedAt, table.source),
]);

/** Operator-entered financial records (formerly journal.jsonl); `record_id` is the record's own deduplication id. */
export const journalRecords = pgTable('journal_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  recordId: text('record_id').notNull(),
  record: jsonb('record').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('journal_records_tenant_record_idx').on(table.tenantId, table.recordId)]);

/** Operator edits to subscriptions (formerly subscription-overrides.json), one row per subscription. */
export const subscriptionOverrides = pgTable('subscription_overrides', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  subscriptionId: text('subscription_id').notNull(),
  override: jsonb('override').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('subscription_overrides_tenant_subscription_idx').on(table.tenantId, table.subscriptionId)]);

/** Balance/spend samples for the sparklines (formerly history.jsonl). */
export const historyPoints = pgTable('history_points', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull(),
  runpod: doublePrecision('runpod'),
  vast: doublePrecision('vast'),
  estUsdToday: doublePrecision('est_usd_today'),
}, table => [index('history_points_tenant_at_idx').on(table.tenantId, table.at)]);

export const schema = { tenants, memberships, ingestTokens, deviceTokens, snapshots, quotaObservations, journalRecords, subscriptionOverrides, historyPoints };
