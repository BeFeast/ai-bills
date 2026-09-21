CREATE TABLE "history_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"runpod" double precision,
	"vast" double precision,
	"est_usd_today" double precision
);
--> statement-breakpoint
CREATE TABLE "journal_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"record_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_overrides" (
	"tenant_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"override" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "history_points" ADD CONSTRAINT "history_points_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_records" ADD CONSTRAINT "journal_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_overrides" ADD CONSTRAINT "subscription_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "history_points_tenant_at_idx" ON "history_points" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_records_tenant_record_idx" ON "journal_records" USING btree ("tenant_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_overrides_tenant_subscription_idx" ON "subscription_overrides" USING btree ("tenant_id","subscription_id");