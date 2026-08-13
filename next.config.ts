import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

// The package.json version is always available at build time — unlike git,
// which is absent in container/VPC builds (AgentBay), leaving the sidebar
// version chip blank. Use it as the reliable fallback so the version always
// shows, hosted or not.
const pkgVersion = (() => {
  try {
    return `v${JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf-8")).version}`;
  } catch {
    return "";
  }
})();

const nextConfig: NextConfig = {
  turbopack: {},
  env: {
    NEXT_PUBLIC_APP_VERSION: git("describe --tags --always") || pkgVersion || "dev",
    NEXT_PUBLIC_COMMIT_HASH: git("rev-parse --short HEAD") || pkgVersion || "",
    AGENTBAY_HOSTED: process.env.AGENTBAY_HOSTED || "false",
    NEXT_PUBLIC_AGENTBAY_HOSTED: process.env.NEXT_PUBLIC_AGENTBAY_HOSTED || process.env.AGENTBAY_HOSTED || "false",
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
  ],
  // Ensure modules resolve from project root (avoids HOME being used as context)
  webpack: (config, { dir }) => {
    config.resolve.modules = [
      path.join(dir, "node_modules"),
      ...(Array.isArray(config.resolve.modules) ? config.resolve.modules : ["node_modules"]),
    ];
    return config;
  },
};

export default nextConfig;
