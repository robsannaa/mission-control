import { expect, test } from "@playwright/test";
import {
  shortToolName,
  toolMatchesFilter,
  toServerView,
  type McpServerConfig,
} from "../src/lib/mcp-types";

// The core security invariant: a redacted view must never carry a secret VALUE.
test.describe("MCP secret redaction (toServerView)", () => {
  test("HTTP server: header values are stripped, only key names + presence survive", () => {
    const cfg: McpServerConfig = {
      url: "https://mcp.example.com/api",
      transport: "streamable-http",
      headers: { Authorization: "Bearer super-secret-token-xyz", "X-Env": "prod" },
    };
    const view = toServerView("remote", cfg, undefined, []);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("super-secret-token-xyz");
    expect(view.headerKeys).toEqual(["Authorization", "X-Env"]);
    expect(view.hasAuthHeader).toBe(true);
    expect(view.transport).toBe("streamable-http");
  });

  test("stdio server: env values are stripped, only key names survive", () => {
    const cfg: McpServerConfig = {
      command: "python3",
      args: ["server.py"],
      cwd: "/srv",
      env: { API_KEY: "sk-live-do-not-leak", DEBUG: "1" },
    };
    const view = toServerView("local", cfg, undefined, []);
    expect(JSON.stringify(view)).not.toContain("sk-live-do-not-leak");
    expect(view.envKeys).toEqual(["API_KEY", "DEBUG"]);
    expect(view.command).toBe("python3");
    expect(view.transport).toBe("stdio");
  });

  test("TLS material is reduced to presence booleans", () => {
    const cfg: McpServerConfig = {
      url: "https://mcp.example.com",
      transport: "streamable-http",
      clientCert: "-----BEGIN CERTIFICATE-----secret",
      clientKey: "-----BEGIN PRIVATE KEY-----secret",
    };
    const view = toServerView("mtls", cfg, undefined, []);
    expect(JSON.stringify(view)).not.toContain("BEGIN");
    expect(view.hasClientCert).toBe(true);
    expect(view.hasClientKey).toBe(true);
  });

  test("status + doctor merge: enabled/ok and issues flow through", () => {
    const cfg: McpServerConfig = { url: "https://x", transport: "streamable-http" };
    const view = toServerView(
      "svc",
      cfg,
      { name: "svc", configured: true, enabled: false, ok: false, transport: "streamable-http", launch: "https://x" },
      [{ level: "warning", message: "literal secret" }],
    );
    expect(view.enabled).toBe(false);
    expect(view.ok).toBe(false);
    expect(view.issues).toHaveLength(1);
  });

  test("disabled flag from config is honored when no status row", () => {
    const view = toServerView("d", { command: "x", disabled: true }, undefined, []);
    expect(view.enabled).toBe(false);
    expect(view.ok).toBeNull();
  });
});

test.describe("MCP tool filtering", () => {
  test("shortToolName strips the server prefix", () => {
    expect(shortToolName("versa-erp__erp_bank", "versa-erp")).toBe("erp_bank");
    expect(shortToolName("erp_bank", "versa-erp")).toBe("erp_bank");
  });

  test("exclude hides a tool; include allow-lists", () => {
    expect(toolMatchesFilter("erp_sql", [], ["erp_sql"])).toBe(false);
    expect(toolMatchesFilter("erp_bank", [], ["erp_sql"])).toBe(true);
    expect(toolMatchesFilter("erp_bank", ["erp_bank"], [])).toBe(true);
    expect(toolMatchesFilter("erp_sql", ["erp_bank"], [])).toBe(false);
  });

  test("glob '*' matches", () => {
    expect(toolMatchesFilter("erp_sql", [], ["erp_*"])).toBe(false);
    expect(toolMatchesFilter("prompts_get", [], ["erp_*"])).toBe(true);
  });

  test("exclude wins over include", () => {
    expect(toolMatchesFilter("erp_sql", ["erp_*"], ["erp_sql"])).toBe(false);
  });
});
