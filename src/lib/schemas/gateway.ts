/**
 * Zod schemas for the `/api/gateway` route group.
 *
 * `gatewayActionSchema` covers `POST /api/gateway`'s body. `action` stays
 * `z.string().optional()` rather than a strict `z.enum(["restart", "stop"])`
 * — the handler's own `switch`/fallback already answers an unrecognized or
 * missing action with a specific `Unknown action: <value>` message (D-06,
 * plain language), and a stricter enum here would replace that message with
 * a generic Zod one for the same input. Format/enum enforcement is left to
 * the handler, matching the "required stays manual" split documented in
 * `src/lib/schemas/agents.ts`.
 */
import { z } from "zod";

export const gatewayActionSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();

export type GatewayActionInput = z.infer<typeof gatewayActionSchema>;
