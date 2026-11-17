import js from "@eslint/js";
import globals from "globals";

const commonJsFiles = ["src/**/*.js", "scripts/**/*.js"];

export default [
  { ignores: ["coverage/**", "node_modules/**"] },
  {
    files: commonJsFiles,
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // Sanitizers intentionally match control characters to remove or reject them.
      "no-control-regex": "off",
      // Existing test doubles and migration helpers intentionally retain some unused bindings.
      "no-unused-vars": "off",
    },
  },
  {
    files: ["public/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, module: "readonly" },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-control-regex": "off",
      "no-unused-vars": "off",
    },
  },
];
