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
];

export default config;
