import noConditionalTests from "./oxlint-plugin-executor/rules/no-conditional-tests.js";
import noCrossPackageRelativeImports from "./oxlint-plugin-executor/rules/no-cross-package-relative-imports.js";
import noDoubleCast from "./oxlint-plugin-executor/rules/no-double-cast.js";
import noEffectInternalTags from "./oxlint-plugin-executor/rules/no-effect-internal-tags.js";
import noInlineObjectTypeAssertion from "./oxlint-plugin-executor/rules/no-inline-object-type-assertion.js";
import noInstanceofTaggedError from "./oxlint-plugin-executor/rules/no-instanceof-tagged-error.js";
import noManualTagCheck from "./oxlint-plugin-executor/rules/no-manual-tag-check.js";
import noPromiseClientSurface from "./oxlint-plugin-executor/rules/no-promise-client-surface.js";
import noRawErrorThrow from "./oxlint-plugin-executor/rules/no-raw-error-throw.js";
import noRedundantErrorFactory from "./oxlint-plugin-executor/rules/no-redundant-error-factory.js";
import noTsNocheck from "./oxlint-plugin-executor/rules/no-ts-nocheck.js";
import noUnknownShapeProbing from "./oxlint-plugin-executor/rules/no-unknown-shape-probing.js";
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
    "no-inline-object-type-assertion": noInlineObjectTypeAssertion,
    "no-instanceof-tagged-error": noInstanceofTaggedError,
    "no-manual-tag-check": noManualTagCheck,
    "no-promise-client-surface": noPromiseClientSurface,
    "no-raw-error-throw": noRawErrorThrow,
    "no-redundant-error-factory": noRedundantErrorFactory,
    "no-unknown-shape-probing": noUnknownShapeProbing,
  },
};
