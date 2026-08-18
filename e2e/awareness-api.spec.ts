import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { GET as listApi, POST as interactionApi } from "../src/app/api/interactions/route";
import { POST as intakeApi } from "../src/app/api/interactions/intake/route";
import {
  answerInteraction,
  createInteraction,
  resetInteractionStoreForTests,
  transitionInteraction,
} from "../src/lib/awareness/store";

let directory = "";

/**
 * `withRoute` (src/lib/api-route.ts) requires a second `{ params: Promise<...> }`
 * argument on every wrapped handler — even for these three routes, none of
 * which have a dynamic segment — matching Next.js's own generated route
 * type-check. This file calls the handlers directly (not through
 * `testApiHandler`), so it supplies the empty-params context Next.js would
 * normally construct itself.
 */
const noParams = { params: Promise.resolve({}) };

function request(url: string, body: unknown, headers?: Record<string, string>) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const interaction = (key: string) => ({
  title: "Scheduled work needs context",
  question: "Who is Alex?",
  source: { kind: "cron" as const, id: key, runId: key },
  idempotencyKey: key,
});

test.describe.serial("interaction API", () => {
  test.beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mc-awareness-api-"));
    process.env.MISSION_CONTROL_INTERACTION_DB = join(directory, "interactions.db");
    process.env.MISSION_CONTROL_AUTH = "off";
    delete process.env.MISSION_CONTROL_AWARENESS_TOKEN;
    resetInteractionStoreForTests();
  });

  test.afterAll(async () => {
    delete process.env.MISSION_CONTROL_INTERACTION_DB;
    delete process.env.MISSION_CONTROL_AWARENESS_TOKEN;
    delete process.env.MISSION_CONTROL_AUTH;
    resetInteractionStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  test("loopback intake works without a token in local auth-off mode", async () => {
    const response = await intakeApi(request(
      "http://127.0.0.1:3100/api/interactions/intake",
      { interaction: interaction("intake-local") },
      { host: "127.0.0.1:3100" },
    ), noParams);
    expect(response.status).toBe(201);
    expect((await response.json()).interaction.status).toBe("open");
  });

  test("non-loopback intake fails closed without a service token", async () => {
    const response = await intakeApi(request(
      "https://mission.example/api/interactions/intake",
      { interaction: interaction("intake-remote") },
      { host: "mission.example" },
    ), noParams);
    expect(response.status).toBe(503);
  });

  test("configured intake token rejects a missing token", async () => {
    process.env.MISSION_CONTROL_AWARENESS_TOKEN = "secret-value";
    const response = await intakeApi(request(
      "https://mission.example/api/interactions/intake",
      { interaction: interaction("missing-token") },
      { host: "mission.example" },
    ), noParams);
    expect(response.status).toBe(401);
  });

  test("configured intake token accepts the matching bearer token", async () => {
    const response = await intakeApi(request(
      "https://mission.example/api/interactions/intake",
      { interaction: interaction("valid-token") },
      { host: "mission.example", authorization: "Bearer secret-value" },
    ), noParams);
    expect(response.status).toBe(201);
    delete process.env.MISSION_CONTROL_AWARENESS_TOKEN;
  });

  test("browser API creates a question", async () => {
    const response = await interactionApi(request(
      "http://127.0.0.1:3100/api/interactions",
      { action: "create", interaction: interaction("browser-create") },
    ), noParams);
    expect(response.status).toBe(201);
    expect((await response.json()).interaction.question).toBe("Who is Alex?");
  });

  test("list endpoint returns active questions", async () => {
    const response = await listApi(new NextRequest("http://127.0.0.1:3100/api/interactions?status=active"), noParams);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.count).toBeGreaterThanOrEqual(3);
    expect(body.interactions.every((item: { status: string }) => item.status === "open" || item.status === "resuming")).toBe(true);
  });

  test("chat deep links can load one durable question by id", async () => {
    const list = await (await listApi(new NextRequest("http://127.0.0.1:3100/api/interactions?status=active"), noParams)).json();
    const target = list.interactions.find((item: { idempotencyKey: string }) => item.idempotencyKey === "browser-create");
    const response = await listApi(new NextRequest(
      `http://127.0.0.1:3100/api/interactions?id=${encodeURIComponent(target.id)}`,
    ), noParams);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.interaction.id).toBe(target.id);
    expect(body.interaction.question).toBe("Who is Alex?");
  });

  test("unknown question deep links return not found", async () => {
    const response = await listApi(new NextRequest(
      "http://127.0.0.1:3100/api/interactions?id=00000000-0000-4000-8000-000000000000",
    ), noParams);
    expect(response.status).toBe(404);
  });

  test("answer endpoint accepts an answer without a resumable session", async () => {
    const list = await (await listApi(new NextRequest("http://127.0.0.1:3100/api/interactions?status=active"), noParams)).json();
    const target = list.interactions.find((item: { idempotencyKey: string }) => item.idempotencyKey === "browser-create");
    const response = await interactionApi(request(
      "http://127.0.0.1:3100/api/interactions",
      { action: "answer", id: target.id, answer: "Alex is my accountant" },
    ), noParams);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.resumed).toBe(false);
    expect(body.interaction.answer).toBe("Alex is my accountant");
  });

  test("a duplicate answer returns conflict", async () => {
    const all = await (await listApi(new NextRequest("http://127.0.0.1:3100/api/interactions?status=all"), noParams)).json();
    const target = all.interactions.find((item: { idempotencyKey: string }) => item.idempotencyKey === "browser-create");
    const response = await interactionApi(request(
      "http://127.0.0.1:3100/api/interactions",
      { action: "answer", id: target.id, answer: "Different" },
    ), noParams);
    expect(response.status).toBe(409);
    expect((await response.json()).accepted).toBe(false);
  });

  test("skip endpoint removes a question from the active list", async () => {
    const list = await (await listApi(new NextRequest("http://127.0.0.1:3100/api/interactions?status=active"), noParams)).json();
    const target = list.interactions.find((item: { idempotencyKey: string }) => item.idempotencyKey === "intake-local");
    const response = await interactionApi(request(
      "http://127.0.0.1:3100/api/interactions",
      { action: "skip", id: target.id },
    ), noParams);
    expect(response.status).toBe(200);
    expect((await response.json()).interaction.status).toBe("skipped");
  });

  test("runtime intake completes a resumed workflow only after agent_end", async () => {
    const created = await createInteraction(interaction("resume-completion"));
    await answerInteraction({ id: created.id, answer: "Use the first supplier" });
    await transitionInteraction({ id: created.id, status: "resuming" });
    const response = await intakeApi(request(
      "http://127.0.0.1:3100/api/interactions/intake",
      { action: "complete", id: created.id, success: true, runId: "resumed-run" },
      { host: "127.0.0.1:3100" },
    ), noParams);
    expect(response.status).toBe(200);
    expect((await response.json()).interaction.status).toBe("completed");
  });

  test("runtime pause requires the originating cron job id", async () => {
    const response = await intakeApi(request(
      "http://127.0.0.1:3100/api/interactions/intake",
      { action: "pause" },
      { host: "127.0.0.1:3100" },
    ), noParams);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("jobId is required");
  });

  test("unknown actions are rejected", async () => {
    const response = await interactionApi(request(
      "http://127.0.0.1:3100/api/interactions",
      { action: "explode" },
    ), noParams);
    expect(response.status).toBe(400);
  });
});
