const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/executor_v3";

export default {
  dialect: "postgresql",
  schema: "./src/persistence/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
};
