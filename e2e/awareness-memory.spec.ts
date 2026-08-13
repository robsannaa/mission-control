import { expect, test } from "@playwright/test";
import {
  CompositeMemoryProvider,
  NullMemoryProvider,
  type AwarenessMemoryProvider,
  type MemoryCandidate,
  type MemoryEvidence,
} from "../src/lib/awareness/memory";

function provider(input: {
  id: string;
  evidence?: MemoryEvidence[];
  fail?: boolean;
  writes?: string[];
}): AwarenessMemoryProvider {
  return {
    id: input.id,
    async capabilities() { return ["search", "read", "stage", "commit"]; },
    async search() {
      if (input.fail) throw new Error("offline");
      return input.evidence || [];
    },
    async stage(candidate: MemoryCandidate) { input.writes?.push(`stage:${candidate.id}`); },
    async commit(id: string) { input.writes?.push(`commit:${id}`); },
    async health() { return input.fail ? { ok: false } : { ok: true }; },
  };
}

test.describe("memory-provider neutrality", () => {
  test("null provider keeps the loop operational", async () => {
    const memory = new NullMemoryProvider();
    expect(await memory.capabilities()).toEqual([]);
    expect(await memory.search("Alex")).toEqual([]);
    expect((await memory.health()).ok).toBe(true);
  });

  test("composite searches every configured provider", async () => {
    const memory = new CompositeMemoryProvider([
      provider({ id: "openclaw", evidence: [{ id: "o", provider: "openclaw", text: "Alex works at Acme" }] }),
      provider({ id: "gbrain", evidence: [{ id: "g", provider: "gbrain", text: "Alex attended the meeting" }] }),
    ]);
    expect((await memory.search("Alex")).map((item) => item.provider)).toEqual(["openclaw", "gbrain"]);
  });

  test("one offline provider does not erase healthy evidence", async () => {
    const memory = new CompositeMemoryProvider([
      provider({ id: "offline", fail: true }),
      provider({ id: "openclaw", evidence: [{ id: "o", provider: "openclaw", text: "Known fact" }] }),
    ]);
    expect(await memory.search("fact")).toHaveLength(1);
    expect((await memory.health()).ok).toBe(true);
  });

  test("equivalent cross-provider evidence is deduplicated", async () => {
    const memory = new CompositeMemoryProvider([
      provider({ id: "one", evidence: [{ id: "1", provider: "one", source: "mail:1", text: "Alex is Rob's accountant" }] }),
      provider({ id: "two", evidence: [{ id: "2", provider: "two", source: "mail:1", text: "Alex is Rob's accountant" }] }),
    ]);
    expect(await memory.search("Alex")).toHaveLength(1);
  });

  test("writes go only to the explicit write provider", async () => {
    const readWrites: string[] = [];
    const writeWrites: string[] = [];
    const reader = provider({ id: "reader", writes: readWrites });
    const writer = provider({ id: "writer", writes: writeWrites });
    const memory = new CompositeMemoryProvider([reader, writer], writer);
    await memory.stage({ id: "candidate", text: "fact", evidence: [] });
    await memory.commit("candidate", "confirmed");
    expect(readWrites).toEqual([]);
    expect(writeWrites).toEqual(["stage:candidate", "commit:candidate"]);
  });

  test("composite enforces the requested result limit", async () => {
    const evidence = Array.from({ length: 10 }, (_, index) => ({
      id: String(index), provider: "p", text: `Fact ${index}`,
    }));
    const memory = new CompositeMemoryProvider([provider({ id: "p", evidence })]);
    expect(await memory.search("facts", 3)).toHaveLength(3);
  });
});

