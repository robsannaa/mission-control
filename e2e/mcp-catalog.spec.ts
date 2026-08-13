import { expect, test } from "@playwright/test";
import {
  domainFromUrl,
  faviconUrl,
  FEATURED_CONNECTORS,
  monogram,
  normalizeRegistryServer,
  recipeToPreset,
  type RegistryServerRaw,
} from "../src/lib/mcp-catalog";

test.describe("MCP catalog — featured shelf", () => {
  test("every featured connector has a usable recipe and unique id", () => {
    const ids = new Set<string>();
    for (const c of FEATURED_CONNECTORS) {
      expect(c.id).toBeTruthy();
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(["stdio", "http", "managed"]).toContain(c.recipe.kind);
    }
  });

  test("the managed Google Calendar card is self-hosted only (hidden in hosted VPC)", () => {
    const gcal = FEATURED_CONNECTORS.find((c) => c.id === "google-calendar")!;
    expect(gcal.recipe.kind).toBe("managed");
    expect(gcal.selfHostedOnly).toBe(true);
    // No other featured connector should be gated unless it also needs a self-hosted surface.
    const hostedVisible = FEATURED_CONNECTORS.filter((c) => !c.selfHostedOnly);
    expect(hostedVisible.length).toBeGreaterThan(5);
  });

  test("recipeToPreset seeds form fields for stdio and http, null for managed", () => {
    const gcal = FEATURED_CONNECTORS.find((c) => c.id === "google-calendar")!;
    expect(recipeToPreset(gcal.name, gcal.title, gcal.recipe)).toBeNull();

    const ctx = FEATURED_CONNECTORS.find((c) => c.id === "context7")!;
    const p = recipeToPreset(ctx.name, ctx.title, ctx.recipe);
    expect(p?.transport).toBe("stdio");
    expect(p?.command).toBe("npx");

    const gh = FEATURED_CONNECTORS.find((c) => c.id === "github")!;
    const hp = recipeToPreset(gh.name, gh.title, gh.recipe);
    expect(hp?.transport).toBe("streamable-http");
    expect(hp?.oauth).toBe(true);
  });
});

test.describe("MCP catalog — registry normalization", () => {
  test("maps a remote http server with a secret header", () => {
    const raw: RegistryServerRaw = {
      server: {
        name: "ai.calendarmcp/server",
        title: "CalendarMCP",
        description: "Hosted Google Calendar MCP",
        websiteUrl: "https://calendarmcp.ai",
        remotes: [
          {
            type: "streamable-http",
            url: "https://calendarmcp.ai/api/mcp",
            headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
          },
        ],
      },
    };
    const c = normalizeRegistryServer(raw)!;
    expect(c.id).toBe("server");
    expect(c.installable).toBe(true);
    expect(c.recipe?.kind).toBe("http");
    if (c.recipe?.kind === "http") {
      expect(c.recipe.url).toBe("https://calendarmcp.ai/api/mcp");
      expect(c.recipe.headers?.[0]?.key).toBe("Authorization");
    }
  });

  test("maps an npm package server to a stdio recipe", () => {
    const raw: RegistryServerRaw = {
      server: {
        name: "io.github.acme/widget",
        description: "A widget server",
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/widget-mcp",
            runtimeHint: "npx",
            environmentVariables: [{ name: "WIDGET_KEY", isRequired: true, isSecret: true }],
          },
        ],
      },
    };
    const c = normalizeRegistryServer(raw)!;
    expect(c.recipe?.kind).toBe("stdio");
    if (c.recipe?.kind === "stdio") {
      expect(c.recipe.command).toBe("npx");
      expect(c.recipe.args).toEqual(["-y", "@acme/widget-mcp"]);
      expect(c.recipe.env?.[0]?.key).toBe("WIDGET_KEY");
    }
  });

  test("a server with neither remote nor package is not installable", () => {
    const c = normalizeRegistryServer({ server: { name: "x/y", description: "docs only" } })!;
    expect(c.installable).toBe(false);
    expect(c.recipe).toBeNull();
  });
});

test.describe("MCP catalog — icon helpers", () => {
  test("domainFromUrl strips scheme and www", () => {
    expect(domainFromUrl("https://www.notion.so/foo")).toBe("notion.so");
    expect(domainFromUrl("linear.app")).toBe("linear.app");
    expect(domainFromUrl(undefined)).toBeUndefined();
  });

  test("faviconUrl builds a service URL or null", () => {
    expect(faviconUrl("stripe.com")).toContain("stripe.com");
    expect(faviconUrl(undefined)).toBeNull();
  });

  test("monogram takes up to two initials", () => {
    expect(monogram("Google Calendar")).toBe("GC");
    expect(monogram("Notion")).toBe("NO");
  });
});
