CREATE TABLE "ingest_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"provider" text NOT NULL,
	"account_key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"status" integer,
	"source" text DEFAULT 'direct' NOT NULL,
	"error" text,
	"direct" jsonb,
	"windows" jsonb
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bytes" integer NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"clerk_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_observations" ADD CONSTRAINT "quota_observations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_observations" ADD CONSTRAINT "quota_observations_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_tokens_sha256_idx" ON "ingest_tokens" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "ingest_tokens_tenant_idx" ON "ingest_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_idx" ON "memberships" USING btree ("tenant_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "quota_observations_tenant_account_idx" ON "quota_observations" USING btree ("tenant_id","provider","account_key","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_observations_unique_idx" ON "quota_observations" USING btree ("tenant_id","provider","account_key","observed_at","source");--> statement-breakpoint
CREATE INDEX "snapshots_tenant_received_idx" ON "snapshots" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");