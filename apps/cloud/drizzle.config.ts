import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/services/schema.ts", "./src/services/executor-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
});
