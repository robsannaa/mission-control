import { expect, test } from "@playwright/test";
import {
  buildDenseTopologyPositions,
  compactAgentRouteLabel,
  routeBindingScope,
  type AgentRouteBinding,
} from "../src/lib/agent-topology";
import { extractBindings, type ConfigData } from "../src/lib/gateway-config";

function binding(overrides: Partial<AgentRouteBinding> = {}): AgentRouteBinding {
  return {
    order: 0,
    type: "route",
    agentId: "main",
    channel: "telegram",
    accountId: "default",
    ...overrides,
  };
}

test.describe("agent topology routing truth", () => {
  test("preserves OpenClaw's peer, guild, team, and role match fields", () => {
    const configData: ConfigData = {
      parsed: {
        bindings: [
          {
            agentId: "support",
            type: "route",
            match: {
              channel: "discord",
              accountId: "work",
              peer: { kind: "channel", id: "123" },
              guildId: "guild-1",
              teamId: "team-1",
              roles: ["operator", "on-call"],
            },
          },
        ],
      },
      resolved: {},
      hash: "test",
    };

    expect(extractBindings(configData)).toEqual([
      expect.objectContaining({
        agentId: "support",
        match: {
          channel: "discord",
          accountId: "work",
          peer: { kind: "channel", id: "123" },
          guildId: "guild-1",
          teamId: "team-1",
          roles: ["operator", "on-call"],
        },
      }),
    ]);
  });

  test("labels account-wide, wildcard, and peer-specific bindings without ambiguity", () => {
    expect(routeBindingScope(binding({ accountId: null }))).toBe("default account");
    expect(routeBindingScope(binding({ accountId: "*" }))).toBe("all accounts");
    expect(
      routeBindingScope(
        binding({
          channel: "discord",
          accountId: "work",
          peer: { kind: "channel", id: "123" },
        }),
      ),
    ).toBe("channel:123");
    expect(compactAgentRouteLabel([binding()], false)).toBe("telegram/default");
    expect(
      compactAgentRouteLabel(
        [
          binding({
            channel: "discord",
            accountId: "work",
            peer: { kind: "channel", id: "123" },
          }),
        ],
        false,
      ),
    ).toBe("discord/work · channel:123");
    expect(
      compactAgentRouteLabel(
        [binding(), binding({ order: 1, channel: "whatsapp", accountId: "sales" })],
        false,
      ),
    ).toBe("telegram/default · whatsapp/sales");
    expect(compactAgentRouteLabel([], true)).toBe("default fallback");
    expect(compactAgentRouteLabel([], false)).toBe("runtime only");
  });
});

test.describe("agent topology scale layout", () => {
  test("lays out 50 agents in a bounded grid and keeps all real workspaces", () => {
    const agents = Array.from({ length: 50 }, (_, index) => ({
      id: `agent-${index + 1}`,
      workspace: `/workspace/${index % 5}`,
    }));
    const workspaceNodeIds = Array.from({ length: 5 }, (_, index) => ({
      id: `ws-${index}`,
      workspace: `/workspace/${index}`,
    }));
    const positions = buildDenseTopologyPositions({
      agents,
      channelNodeIds: [
        "ch-telegram-default",
        "ch-telegram-support",
        "ch-whatsapp-personal",
        "ch-whatsapp-business",
        "ch-discord-default",
      ],
      workspaceNodeIds,
      gbrainNodeId: "gbrain",
    });

    expect(positions.size).toBe(62); // 50 agents + 5 accounts + 5 workspaces + gateway + G-Brain
    const agentPositions = agents.map((agent) => positions.get(`agent-${agent.id}`));
    expect(agentPositions.every(Boolean)).toBe(true);
    expect(new Set(agentPositions.map((position) => `${position?.x}:${position?.y}`)).size).toBe(50);

    const agentYs = agentPositions.map((position) => position?.y || 0);
    expect(Math.max(...agentYs) - Math.min(...agentYs)).toBeLessThanOrEqual(1050);
    expect(new Set(agentPositions.map((position) => position?.x)).size).toBe(7);
    for (const workspace of workspaceNodeIds) {
      expect(positions.has(workspace.id)).toBe(true);
    }
  });
});
