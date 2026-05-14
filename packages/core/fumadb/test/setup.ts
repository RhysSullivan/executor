import { afterAll } from "vitest";
import { cleanupFiles } from "./shared";

afterAll(() => {
  cleanupFiles();
});
