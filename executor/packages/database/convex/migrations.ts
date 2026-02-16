import { Migrations } from "@convex-dev/migrations";
import type { DataModel } from "./_generated/dataModel.d.ts";
import { components } from "./_generated/api";

const migrations = new Migrations<DataModel>(components.migrations);

export const run = migrations.runner();
