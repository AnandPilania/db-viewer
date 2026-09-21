import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
    {
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/public/**",
            "**/*.d.ts",
            "**/.data/**",
            "**/coverage/**",
            "pnpm-lock.yaml",
            // Committed, published build output (root `server/` mirrors apps/server's
            // compiled dist/ for npm packaging) — not hand-written source.
            "server/**",
        ],
    },

    js.configs.recommended,

    {
        files: ["**/*.{ts,tsx}"],
        plugins: { "@typescript-eslint": tsPlugin },
        languageOptions: {
            parser: tsParser,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            "@typescript-eslint/no-explicit-any": "off", // used deliberately at driver/DB boundaries
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "no-unused-vars": "off", // superseded by the TS-aware rule above
            // `no-undef` only knows JS runtime globals, not TS's own ambient/lib types
            // (RequestInit, the JSX `React` global, etc.) or type-only names — it
            // false-positives on those, and tsc already catches genuine undefined
            // names far more accurately.
            "no-undef": "off",
        },
    },

    // Node packages: server, drivers, driver-interface, bin, scripts.
    {
        files: ["apps/server/**/*.ts", "packages/**/*.ts", "bin/**/*.js", "scripts/**/*.mjs", "tests/**/*.ts"],
        languageOptions: {
            globals: { ...globals.node },
        },
    },

    // Web app: React + browser globals.
    {
        files: ["apps/web/**/*.{ts,tsx}"],
        plugins: {
            react,
            "react-hooks": reactHooks,
            "react-refresh": reactRefresh,
        },
        languageOptions: {
            globals: { ...globals.browser },
            parserOptions: { ecmaFeatures: { jsx: true } },
        },
        settings: { react: { version: "detect" } },
        rules: {
            ...react.configs.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            "react/react-in-jsx-scope": "off", // React 19 automatic JSX runtime
            "react/prop-types": "off", // typed with TypeScript instead
            "react-refresh/only-export-components": "warn",
            // React-Compiler-readiness diagnostic — this project doesn't run the
            // Compiler (no babel-plugin-react-compiler), so "can't be memoized by
            // the Compiler" is not applicable here.
            "react-hooks/incompatible-library": "off",
        },
    },

    // Entry point: mounts the app, has no exports, and is never Fast-Refreshed.
    { files: ["apps/web/src/main.tsx"], rules: { "react-refresh/only-export-components": "off" } },

    // Always last: turns off stylistic rules that would fight Prettier.
    eslintConfigPrettier,
];
