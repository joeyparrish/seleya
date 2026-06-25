import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Server and tooling run in Node.
  {
    files: ["src/server/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: { globals: globals.node },
  },

  // Client runs in the browser; enforce the rules of hooks.
  {
    files: ["src/client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Tests use casts and ad-hoc shapes; allow `any` there.
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  // The GraphQL client maps external, untyped JSON responses.
  {
    files: ["src/server/github/client.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
