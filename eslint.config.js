import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["coverage/**", "dist/**", "node_modules/**", "repo-kit/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        Headers: "readonly",
        RequestInit: "readonly",
        Response: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Buffer: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        getComputedStyle: "readonly",
        process: "readonly",
        URL: "readonly",
        window: "readonly",
      },
    },
  },
);
