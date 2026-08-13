# Mission Control awareness loop

## Goal

Background work should feel attentive without becoming noisy. A task, cron job,
or future integration may pause when a missing fact materially affects the
result, ask one useful question, preserve its checkpoint, and continue after the
answer. The workflow contract is independent of OpenClaw Memory, G-Brain, a
hybrid setup, or no configured memory provider.

## Runtime flow

1. Mission Control injects the versioned awareness protocol into model-backed
   cron payloads. The OpenClaw plugin also injects it at runtime, covering jobs
   created outside the UI and heartbeat turns.
2. The agent searches whatever context tools are available. If uncertainty is
   material, it ends with exactly one trailing `NEEDS_INPUT:` control line.
3. The plugin converts that control line into a tenant-scoped, idempotent,
   durable interaction request. Once the run ends, it pauses the originating
   cron schedule so the same unresolved question is not generated again.
4. Mission Control shows the request in **Questions** and in notifications.
   Selecting the notification opens Chat with the question in context.
5. The user replies through the normal Chat composer. The first valid answer
   wins transactionally. If the source has an OpenClaw
   session, Mission Control resumes that same session with the accepted answer
   and re-enables its cron schedule.
6. Admission leaves the request in `resuming`; the OpenClaw `agent_end` hook
   marks it `completed` or `failed` only after the resumed turn actually ends.
   A second material uncertainty creates a new question.

## Deployment contract

- Local installations default to a SQLite WAL store under the OpenClaw home
  directory and allow machine intake only over loopback while auth is off.
- Hosted installations must set `MISSION_CONTROL_AWARENESS_TOKEN` and scope
  runtime intake with `MISSION_CONTROL_TENANT_ID` and
  `MISSION_CONTROL_USER_ID`.
- `MISSION_CONTROL_INTERACTION_DB` can relocate the local store. A hosted
  database adapter can replace the repository interface without changing the
  protocol, UI, or OpenClaw plugin.
- The OpenClaw plugin needs the narrow
  `hooks.allowConversationAccess=true` grant to inspect final assistant output.

## Acceptance criteria

### Asking and persistence

- [x] Model-backed cron jobs receive the awareness protocol; command and system
  jobs do not.
- [x] Runtime hooks cover existing cron jobs and heartbeat prompts.
- [x] Only an exact trailing `NEEDS_INPUT:` line creates a question.
- [x] Questions have durable status, source, tenant, user, run, session, and
  idempotency metadata.
- [x] A source can have only one active question; repeated scheduled runs
  coalesce until that interaction is resolved.
- [x] State survives process/store reinitialization.

### Answering and resumption

- [x] Only the first concurrent answer is accepted and retained.
- [x] Answer, skip, cancel, resume, complete, and fail transitions reject
  invalid state changes.
- [x] A resumable answer is sent to the original OpenClaw session with a unique
  idempotency key.
- [x] A cron schedule pauses after the questioning run ends and is re-enabled
  after Chat successfully admits the clarification into the original session.
- [x] The request stays `resuming` after admission and closes only from the
  matching `agent_end` callback.
- [x] A resumed run can ask a second question without losing the original run
  correlation.
- [x] A failed resume remains visible as `failed`; the accepted answer is not
  discarded.

### User experience

- [x] Questions have a dedicated sidebar destination and an active/all view.
- [x] Open questions appear in the notification center.
- [x] Question notifications deep-link into Chat, where the normal composer
  submits the clarification and reports whether the source resumed.
- [x] The loading state uses only the centered spinner.
- [x] Users can answer free-form or choice questions and skip a question without
  using the terminal.
- [x] The live UI was verified by creating, displaying, and resolving a real
  durable interaction on port 3100.
- [ ] Telegram, WhatsApp, and Discord outbound question cards and inbound
  answer correlation are implemented as transport adapters.

### Memory and hosting neutrality

- [x] Awareness logic depends on a capability interface, not provider names.
- [x] No-memory mode remains operational.
- [x] Composite reads tolerate one offline provider and deduplicate evidence.
- [x] Memory writes require an explicit write provider.
- [x] Machine intake fails closed outside local loopback mode unless a service
  token is configured.
- [x] Interaction queries are tenant-scoped.
- [ ] The hosted adapter uses the platform database and derives tenant/user
  identity from trusted-proxy authentication rather than environment defaults.

### Noise, safety, and operations

- [x] The protocol tells agents to finish safe independent work, avoid guesses,
  avoid uncertain memory writes, and remain quiet on routine success.
- [x] Question and persisted text sizes are bounded.
- [x] OpenClaw reports the installed plugin as loaded with the required typed
  hooks and no diagnostics.
- [x] Unit/API/store/plugin tests cover protocol parsing, idempotency,
  concurrency, transitions, authentication, provider neutrality, correlation,
  and completion.
- [ ] Channel delivery has per-user quiet hours, batching, rate limits,
  escalation, and delivery receipts.

## Next adapters

The next implementation slice is transport routing: one outbound interface for
Mission Control, Telegram, WhatsApp, and Discord, plus normalized inbound answer
correlation. After that, add the hosted database adapter and concrete OpenClaw
Memory/G-Brain search adapters. Integrations such as Gmail, Outlook, Slack, and
calendar jobs should emit the same interaction request rather than implementing
their own pause-and-question logic.
