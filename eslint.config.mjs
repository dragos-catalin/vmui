// Minimal flat config — keeps `pnpm lint` working without extra deps.
// Add `eslint-plugin-next` rules later if you want stricter checks.
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "drizzle/**",
      "vmui.db*",
      "next-env.d.ts",
      "scripts/**",
      ".copilot-tmp/**",
      "**/dist/**",
      "**/src-tauri/target/**",
    ],
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
];

export default config;
