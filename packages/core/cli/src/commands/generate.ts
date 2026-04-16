import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { collectSchemas } from "@executor/sdk";
import { getConfig } from "../utils/get-config.js";
import { generateDrizzleSchema } from "../generators/drizzle.js";

async function generateAction(opts: {
  cwd: string;
  config?: string;
  output?: string;
}) {
  const cwd = path.resolve(opts.cwd);
  if (!existsSync(cwd)) {
    console.error(`The directory "${cwd}" does not exist.`);
    process.exit(1);
  }

  const config = await getConfig({ cwd, configPath: opts.config });
  if (!config) {
    console.error(
      "No configuration file found. Add an `executor.config.ts` file to " +
        "your project or pass the path using the `--config` flag.",
    );
    process.exit(1);
  }

  const schema = collectSchemas(config.plugins);

  const result = await generateDrizzleSchema({
    schema,
    dialect: config.dialect,
    file: opts.output,
  });

  if (!result.code) {
    console.log("Schema is already up to date.");
    process.exit(0);
  }

  const outPath = path.resolve(cwd, result.fileName);
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) {
    await fs.mkdir(outDir, { recursive: true });
  }

  await fs.writeFile(outPath, result.code);
  console.log(`Schema generated: ${path.relative(cwd, outPath)}`);
}

export const generate = new Command("generate")
  .description("Generate a drizzle schema file from the executor config")
  .option(
    "-c, --cwd <cwd>",
    "the working directory",
    process.cwd(),
  )
  .option(
    "--config <config>",
    "path to the executor config file",
  )
  .option(
    "--output <output>",
    "output file path for the generated schema",
  )
  .action(generateAction);
