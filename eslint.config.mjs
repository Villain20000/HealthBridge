// Flat ESLint config for the HealthBridge OS monorepo.
//
// Deliberately pragmatic: it runs without a build (no type-aware `project`
// service) and keeps rules that the current codebase can satisfy. Type-aware
// rules can be layered on later per workspace once the baseline is clean.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    name: "healthbridge/ignores",
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.angular/**",
      "**/coverage/**",
      "apps/web/dist/**",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
      "apps/web/e2e/.objects/**",
      "**/*.d.ts",
      "**/*.tsbuildinfo",
      "datasets/**",
      ".scratch/**",
      ".verify/**",
      "tmp-*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "healthbridge/typescript",
    files: [
      "packages/*/src/**/*.ts",
      "apps/*/src/**/*.ts",
      "packages/*/test/**/*.ts",
      "apps/*/test/**/*.ts",
      "scenarios/**/*.ts",
      "apps/web/e2e/**/*.ts",
      "apps/web/playwright.config.ts",
      "examples/**/*.ts",
      "**/*.mts",
      "**/*.cts",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The codebase intentionally uses `any` at adapter/format boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      // Surface dead code without blocking the build on it yet.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Superseded by TypeScript and the typescript-eslint variants above.
      "no-unused-vars": "off",
      "no-undef": "off",
      // Diagnostics and CLI tooling legitimately print to stdout/stderr.
      "no-console": "off",
      // Parsers for HL7/DICOM/CSV fixtures match control characters on purpose.
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    name: "healthbridge/web",
    files: ["apps/web/src/**/*.ts", "apps/web/test/**/*.ts", "apps/web/e2e/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    name: "healthbridge/scripts",
    files: ["scripts/**/*.mjs", "apps/web/**/*.mjs", "eslint.config.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);
