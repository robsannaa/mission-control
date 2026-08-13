export type TopologyPeer = {
  kind: string;
  id: string;
};

export type AgentRouteBinding = {
  order: number;
  type: string;
  agentId: string;
  channel: string;
  accountId: string | null;
  peer?: TopologyPeer;
  guildId?: string;
  teamId?: string;
  roles?: string[];
  comment?: string;
};

export type ConfiguredChannelAccount = {
  id: string;
  name?: string;
  enabled: boolean;
  connected: boolean;
};

export type ConfiguredTopologyChannel = {
  channel: string;
  enabled: boolean;
  connected: boolean;
  defaultAccount: string;
  accounts: ConfiguredChannelAccount[];
};

export function routeBindingScope(binding: AgentRouteBinding): string {
  if (binding.peer) return `${binding.peer.kind}:${binding.peer.id}`;
  if (binding.guildId) return `guild:${binding.guildId}`;
  if (binding.teamId) return `team:${binding.teamId}`;
  if (binding.roles?.length) return `roles:${binding.roles.join(",")}`;
  if (binding.accountId === "*") return "all accounts";
  return binding.accountId || "default account";
}

export function routeBindingLabel(binding: AgentRouteBinding): string {
  const account =
    binding.accountId === "*" ? "all accounts" : binding.accountId || "default";
  const scope = routeBindingScope(binding);
  const hasNarrowerScope = Boolean(
    binding.peer || binding.guildId || binding.teamId || binding.roles?.length,
  );
  return `${binding.channel}/${account}${hasNarrowerScope ? ` · ${scope}` : ""}`;
}

export function compactAgentRouteLabel(
  bindings: AgentRouteBinding[],
  isDefault: boolean,
): string {
  if (bindings.length === 0) return isDefault ? "default fallback" : "runtime only";
  if (bindings.length === 1) return routeBindingLabel(bindings[0]);
  const channels = Array.from(new Set(bindings.map((binding) => binding.channel)));
  if (bindings.length === 2 && channels.length <= 2) {
    return bindings.map(routeBindingLabel).join(" · ");
  }
  return `${bindings.length} routes · ${channels.length} channel${channels.length === 1 ? "" : "s"}`;
}

export type DenseTopologyAgent = {
  id: string;
  workspace: string;
};

export type DenseTopologyPositionInput = {
  agents: DenseTopologyAgent[];
  channelNodeIds: string[];
  workspaceNodeIds: Array<{ id: string; workspace: string }>;
  gbrainNodeId?: string;
  maxRows?: number;
};

/**
 * A bounded-height topology layout for larger installations. Dagre correctly
 * layers small graphs, but puts every agent in one rank; at 50+ agents that
 * produces a several-thousand-pixel vertical column. This grid keeps the
 * routing direction left-to-right while preserving every real node and edge.
 */
export function buildDenseTopologyPositions(
  input: DenseTopologyPositionInput,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const maxRows = Math.max(4, input.maxRows ?? 8);
  const agentStartX = 260;
  const agentSpacingX = 300;
  const agentSpacingY = 150;
  const orderedAgents = [...input.agents].sort((a, b) => {
    const workspaceOrder = a.workspace.localeCompare(b.workspace);
    return workspaceOrder || a.id.localeCompare(b.id);
  });
  const rows = Math.min(maxRows, Math.max(1, orderedAgents.length));
  const columns = Math.max(1, Math.ceil(orderedAgents.length / rows));
  const graphHeight = Math.max(0, (rows - 1) * agentSpacingY);

  orderedAgents.forEach((agent, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    result.set(`agent-${agent.id}`, {
      x: agentStartX + column * agentSpacingX,
      y: row * agentSpacingY,
    });
  });

  result.set("gateway", { x: -80, y: graphHeight / 2 });

  const channelSpacing = 92;
  const channelHeight = Math.max(0, (input.channelNodeIds.length - 1) * channelSpacing);
  const channelStartY = graphHeight / 2 - channelHeight / 2;
  input.channelNodeIds.forEach((id, index) => {
    result.set(id, { x: -430, y: channelStartY + index * channelSpacing });
  });

  const workspaceX = agentStartX + columns * agentSpacingX + 90;
  const agentYByWorkspace = new Map<string, number[]>();
  for (const agent of orderedAgents) {
    const y = result.get(`agent-${agent.id}`)?.y;
    if (typeof y !== "number") continue;
    const values = agentYByWorkspace.get(agent.workspace) || [];
    values.push(y);
    agentYByWorkspace.set(agent.workspace, values);
  }

  const desiredWorkspaces = input.workspaceNodeIds
    .map(({ id, workspace }) => {
      const values = agentYByWorkspace.get(workspace) || [graphHeight / 2];
      return {
        id,
        y: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    })
    .sort((a, b) => a.y - b.y);

  let previousY = -Infinity;
  for (const workspace of desiredWorkspaces) {
    const y = Math.max(workspace.y, previousY + 100);
    result.set(workspace.id, { x: workspaceX, y });
    previousY = y;
  }

  if (input.gbrainNodeId) {
    result.set(input.gbrainNodeId, {
      x: workspaceX + 290,
      y: Math.max(graphHeight / 2, previousY === -Infinity ? 0 : previousY + 110),
    });
  }

  return result;
}
