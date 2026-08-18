import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Prevent direct imports of internal modules — use @/lib/openclaw instead.
  {
    files: ["src/app/**/*.ts", "src/app/**/*.tsx", "src/components/**/*.ts", "src/components/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@/lib/openclaw-cli",
            message: "Import from '@/lib/openclaw' instead. openclaw-cli is an internal module used only by transports.",
          },
          {
            name: "@/lib/openclaw-client",
            message: "Import from '@/lib/openclaw' instead. openclaw-client is an internal module.",
          },
        ],
      }],
    },
  },
  // Ban bare console.* calls in server routes and server libraries (REL-01,
  // D-03 in .planning/phases/02-server-contract-hardening/02-CONTEXT.md).
  // Scope is server-only by design — client-component console.* calls are
  // deliberately out of scope this phase; do not add src/components here.
  // src/lib/logger.ts is exempt because it is the one legitimate writer the
  // shared pino logger sits behind (docs/API-CONTRACT.md's single-logger
  // contract).
  {
    files: ["src/app/api/**/*.ts", "src/lib/**/*.ts"],
    ignores: ["src/lib/logger.ts"],
    rules: {
      "no-console": "error",
    },
  },
]);

export default eslintConfig;
