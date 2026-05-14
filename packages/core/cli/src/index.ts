#!/usr/bin/env node

import { Command } from "commander";

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const program = new Command("executor")
  .version("0.0.1")
  .description("Executor CLI")
  .action(() => program.help());

program.parse();
