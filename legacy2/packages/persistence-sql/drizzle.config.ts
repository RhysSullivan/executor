import { defineConfig } from "drizzle-kit";
import { readPersistenceSqlEnvironment } from "./src/config";

const sanitizePostgresUrl = (value: string): string => {
  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return value;
    }

    parsed.searchParams.delete("sslrootcert");
    parsed.searchParams.delete("sslcert");
    parsed.searchParams.delete("sslkey");
    parsed.searchParams.delete("sslcrl");
    parsed.searchParams.delete("max");
    parsed.searchParams.delete("idle_timeout");

    return parsed.toString();
  } catch {
    return value;
  }
};

const env = readPersistenceSqlEnvironment();
const databaseUrl = sanitizePostgresUrl(
  env.databaseUrl ?? "postgres://localhost:5432/executor_v2",
);

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
