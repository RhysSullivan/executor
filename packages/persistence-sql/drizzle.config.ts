import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle/sqlite",
  dbCredentials: {
    url: "./.executor-v2/control-plane.sqlite",
  },
  strict: true,
  verbose: true,
});
