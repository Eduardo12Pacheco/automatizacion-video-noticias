import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      globals: {
        module: "readonly",
        require: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
