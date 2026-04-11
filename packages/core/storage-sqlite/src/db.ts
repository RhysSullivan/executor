import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = BaseSQLiteDatabase<"sync" | "async", any, any, any>;
