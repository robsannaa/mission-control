# Mission Control Awareness

OpenClaw runtime bridge for Mission Control's durable Questions inbox.

It injects the provider-neutral awareness protocol into cron-driven model turns
and heartbeats. When a run ends with `NEEDS_INPUT:`, the question is sent to
Mission Control's authenticated machine intake endpoint.

- `MISSION_CONTROL_URL` defaults to `http://127.0.0.1:3100`.
- `MISSION_CONTROL_AWARENESS_TOKEN` is optional only for loopback local mode and
  required for hosted deployments.
- `MISSION_CONTROL_TENANT_ID` and `MISSION_CONTROL_USER_ID` scope hosted intake.

The plugin never reads or writes a memory provider. OpenClaw Memory, G-Brain,
hybrid, and no-memory deployments use the same workflow contract.

## Local development install

```bash
openclaw plugins install --link /absolute/path/to/openclaw-plugin/mission-control-awareness
# Both grants are required (see below). Set them, then restart to apply.
openclaw config set plugins.entries.mission-control-awareness.hooks.allowConversationAccess true
openclaw config set plugins.entries.mission-control-awareness.hooks.allowPromptInjection true
openclaw gateway restart
openclaw plugins inspect mission-control-awareness --runtime --json
```

Two grants are required, and OpenClaw **silently drops** the affected hook
registrations if either is missing:

- `allowConversationAccess` — the plugin inspects the final assistant message of
  a run for a trailing `NEEDS_INPUT:` marker. All conversation-reading hooks
  (`before_agent_finalize`, `llm_output`, `agent_end`) need this.
- `allowPromptInjection` — the plugin injects the awareness protocol at runtime
  via `before_prompt_build` (for cron jobs created outside the Mission Control
  UI) and `heartbeat_prompt_contribution`. Prompt-mutating hooks need this grant
  in addition to `allowConversationAccess`. **Without it, runtime protocol
  injection is dropped and only Mission-Control-created jobs stay covered.**

A healthy runtime inspection reports all five registered hooks:
`before_prompt_build`, `heartbeat_prompt_contribution`, `before_agent_finalize`,
`llm_output`, and `agent_end`.
