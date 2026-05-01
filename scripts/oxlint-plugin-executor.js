import noConditionalTests from "./oxlint-plugin-executor/rules/no-conditional-tests.js";
import noCrossPackageRelativeImports from "./oxlint-plugin-executor/rules/no-cross-package-relative-imports.js";
import noDoubleCast from "./oxlint-plugin-executor/rules/no-double-cast.js";
import noEffectInternalTags from "./oxlint-plugin-executor/rules/no-effect-internal-tags.js";
import noTsNocheck from "./oxlint-plugin-executor/rules/no-ts-nocheck.js";
import noVitestImport from "./oxlint-plugin-executor/rules/no-vitest-import.js";
import requireReactivityKeys from "./oxlint-plugin-executor/rules/require-reactivity-keys.js";

export default {
  meta: {
    name: "executor",
  },
  rules: {
    "no-vitest-import": noVitestImport,
    "no-conditional-tests": noConditionalTests,
    "no-double-cast": noDoubleCast,
    "no-cross-package-relative-imports": noCrossPackageRelativeImports,
    "require-reactivity-keys": requireReactivityKeys,
    "no-effect-internal-tags": noEffectInternalTags,
    "no-ts-nocheck": noTsNocheck,
  },
};
