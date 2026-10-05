CREATE TABLE "widget_preferences" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "providers" jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "widget_preferences" TO "zecori_app";
--> statement-breakpoint
ALTER TABLE "widget_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "widget_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "widget_preferences_tenant" ON "widget_preferences" FOR ALL USING (tenant_id::text = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
