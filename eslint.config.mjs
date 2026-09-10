import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      // Owned by other workers / not application source.
      "research/**",
      "plan/**",
      "thread/**",
      // Gitignored diagnostic scratch. eslint 9's flat config does NOT read
      // .gitignore, so an ignored-by-git file is still linted, and a throwaway
      // query script turned the gate red for two workers who had not written
      // it and could not delete it. Three more have appeared at the repo root
      // since, from three different workers, so the pattern is matched too
      // rather than the incident being cleaned up one file at a time.
      ".scratch/**",
      "*.tmp.mjs",
      "*.tmp.js",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Money is integer cents. `==` and implicit coercion have no place here.
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    // The logger is the one module allowed to touch the process streams.
    files: ["src/lib/log.ts"],
    rules: { "no-console": "off" },
  },
  {
    // scripts/** are operator CLIs whose entire purpose is printing to a
    // terminal. Routing them through the structured JSON logger would make
    // `pnpm db:check` unreadable at exactly the moment it matters: live, in
    // front of the panel.
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    rules: { "no-console": "off" },
  },
];


export default config;
