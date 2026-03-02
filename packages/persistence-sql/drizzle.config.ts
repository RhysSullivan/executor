import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/executor_v2";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
