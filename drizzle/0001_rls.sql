-- Row-level security: a connection sees only the tenant named by app.tenant_id, which
-- withTenant() sets per transaction. FORCE applies the policies to the table owner too, so a
-- forgotten WHERE in application code cannot leak across tenants even in tests that run as
-- the owner. The application role is created NOLOGIN here; production gives it LOGIN and a
-- password in the database init script (infra-stacks), migrations run as the owner.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zecori_app') THEN CREATE ROLE "zecori_app" NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "zecori_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenants", "memberships", "ingest_tokens", "snapshots", "quota_observations" TO "zecori_app";
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tenants are looked up by slug and by membership before any tenant context exists, so reading
-- them is open to the application role; rows may only be created outside a tenant context.
CREATE POLICY "tenants_read" ON "tenants" FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY "tenants_insert" ON "tenants" FOR INSERT WITH CHECK (current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '');
--> statement-breakpoint
CREATE POLICY "tenants_update_self" ON "tenants" FOR UPDATE USING (id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Membership resolves which tenant a signed-in user may enter, so it is readable before the context is set.
CREATE POLICY "memberships_read" ON "memberships" FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY "memberships_write" ON "memberships" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "ingest_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ingest_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A presented token is resolved to its tenant by digest before the context exists.
CREATE POLICY "ingest_tokens_read" ON "ingest_tokens" FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY "ingest_tokens_write" ON "ingest_tokens" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "snapshots_tenant" ON "snapshots" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "quota_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quota_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "quota_observations_tenant" ON "quota_observations" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
