-- Row-level security for the three stores added in tenancy phase 3, and an operator read context:
-- app.operator = 'on' (set only by withOperator(), for the operator screen) lets a connection read
-- every tenant's snapshots and observations without a tenant context. Writes stay tenant-bound.
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_records", "subscription_overrides", "history_points" TO "zecori_app";
--> statement-breakpoint
ALTER TABLE "journal_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "journal_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "journal_records_tenant" ON "journal_records" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "subscription_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subscription_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_overrides_tenant" ON "subscription_overrides" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "history_points" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "history_points" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "history_points_tenant" ON "history_points" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "snapshots_operator_read" ON "snapshots" FOR SELECT USING (current_setting('app.operator', true) = 'on');
--> statement-breakpoint
CREATE POLICY "quota_observations_operator_read" ON "quota_observations" FOR SELECT USING (current_setting('app.operator', true) = 'on');
