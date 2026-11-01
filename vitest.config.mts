import angular from "@analogjs/vite-plugin-angular";
import { defineConfig } from "vitest/config";

/**
 * Component-DOM tests for the console (see docs/component-tests.md).
 *
 * These run in jsdom with the Angular TestBed. They exist to pin down component state machines
 * that E2E proves only end to end; the pure-logic suite (`apps/web/test`, node:test) stays
 * untouched and remains the fast check.
 */
export default defineConfig({
  plugins: [angular({ tsconfig: "apps/web/tsconfig.spec.json" })],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["apps/web/src/**/*.spec.ts"],
    setupFiles: ["apps/web/src/test-setup.ts"],
    reporters: ["default"],
  },
});
