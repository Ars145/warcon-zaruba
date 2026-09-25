-- JSON webhooks: an org owner's HTTPS address that Warcon POSTs signed JSON to for each event it
-- takes, and the queue of those POSTs, apart from the outbox so a receiver that is down never
-- holds up a game action. The address and the signing secret are stored encrypted.
CREATE TABLE "json_webhook_posts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"server_id" text,
	"kind" text NOT NULL,
	"event_id" text NOT NULL,
	"body" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"outcome" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "json_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"url_enc" text NOT NULL,
	"url_hint" text DEFAULT '' NOT NULL,
	"secret_enc" text NOT NULL,
	"events" jsonb NOT NULL,
	"server_ids" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_private" boolean DEFAULT false NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "json_webhook_posts" ADD CONSTRAINT "json_webhook_posts_webhook_id_json_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."json_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "json_webhooks" ADD CONSTRAINT "json_webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "json_webhook_posts_event_idx" ON "json_webhook_posts" USING btree ("webhook_id","event_id");--> statement-breakpoint
CREATE INDEX "json_webhook_posts_next_idx" ON "json_webhook_posts" USING btree ("webhook_id","id") WHERE "json_webhook_posts"."state" in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "json_webhook_posts_open_idx" ON "json_webhook_posts" USING btree ("state") WHERE "json_webhook_posts"."state" in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "json_webhooks_org_idx" ON "json_webhooks" USING btree ("org_id");