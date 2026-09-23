CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_sha256_idx" ON "device_tokens" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "device_tokens_tenant_idx" ON "device_tokens" USING btree ("tenant_id");--> statement-breakpoint
-- Same access rules as ingest_tokens (0001_rls.sql): the application role may use the table, a presented
-- token is resolved to its tenant by digest before any tenant context exists, and rows are only ever
-- written inside their own tenant's context.
GRANT SELECT, INSERT, UPDATE, DELETE ON "device_tokens" TO "zecori_app";
--> statement-breakpoint
ALTER TABLE "device_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "device_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "device_tokens_read" ON "device_tokens" FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY "device_tokens_write" ON "device_tokens" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
