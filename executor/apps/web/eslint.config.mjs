import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    ".next/**",
    ".output/**",
    ".nitro/**",
    ".vinxi/**",
    ".tanstack/**",
    "build/**",
    "dist/**",
  ]),
]);
