CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_account_id_organization_id_pk" PRIMARY KEY("account_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_kv" (
	"organization_id" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "plugin_kv_organization_id_namespace_key_pk" PRIMARY KEY("organization_id","namespace","key")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"action" text NOT NULL,
	"match_tool_pattern" text,
	"match_source_id" text,
	"priority" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text,
	"encrypted_value" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"schema" jsonb NOT NULL,
	CONSTRAINT "tool_definitions_name_organization_id_pk" PRIMARY KEY("name","organization_id")
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"plugin_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"may_elicit" boolean,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_id_organization_id_pk" PRIMARY KEY("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;