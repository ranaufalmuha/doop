ALTER TABLE "model_accounts" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN "vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_accounts" ADD COLUMN "max_output_tokens" integer DEFAULT 8192 NOT NULL;