export type MemoryCapability = "search" | "read" | "stage" | "commit";

export type MemoryEvidence = {
  id: string;
  provider: string;
  text: string;
  source?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
};

export type MemoryCandidate = {
  id: string;
  text: string;
  evidence: MemoryEvidence[];
  metadata?: Record<string, unknown>;
};

/** Business logic consumes this interface and never branches on provider name. */
export interface AwarenessMemoryProvider {
  readonly id: string;
  capabilities(): Promise<MemoryCapability[]>;
  search(query: string, limit?: number): Promise<MemoryEvidence[]>;
  stage(candidate: MemoryCandidate): Promise<void>;
  commit(candidateId: string, confirmation: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class NullMemoryProvider implements AwarenessMemoryProvider {
  readonly id = "none";
  async capabilities(): Promise<MemoryCapability[]> { return []; }
  async search(query: string, limit?: number): Promise<MemoryEvidence[]> {
    void query;
    void limit;
    return [];
  }
  async stage(candidate: MemoryCandidate): Promise<void> {
    void candidate;
    // No writable memory configured.
  }
  async commit(candidateId: string, confirmation: string): Promise<void> {
    void candidateId;
    void confirmation;
    // No writable memory configured.
  }
  async health() { return { ok: true, detail: "No memory provider configured" }; }
}

export class CompositeMemoryProvider implements AwarenessMemoryProvider {
  readonly id = "composite";
  constructor(
    private readonly providers: AwarenessMemoryProvider[],
    private readonly writeProvider?: AwarenessMemoryProvider,
  ) {}

  async capabilities(): Promise<MemoryCapability[]> {
    const all = await Promise.all(this.providers.map((provider) => provider.capabilities()));
    return [...new Set(all.flat())];
  }

  async search(query: string, limit = 8): Promise<MemoryEvidence[]> {
    const settled = await Promise.allSettled(
      this.providers.map((provider) => provider.search(query, limit)),
    );
    const seen = new Set<string>();
    const evidence: MemoryEvidence[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const item of result.value) {
        const key = `${item.source || ""}:${item.text.trim().toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(item);
      }
    }
    return evidence.slice(0, limit);
  }

  async stage(candidate: MemoryCandidate): Promise<void> {
    if (this.writeProvider) await this.writeProvider.stage(candidate);
  }

  async commit(candidateId: string, confirmation: string): Promise<void> {
    if (this.writeProvider) await this.writeProvider.commit(candidateId, confirmation);
  }

  async health() {
    const states = await Promise.allSettled(this.providers.map((provider) => provider.health()));
    const healthy = states.filter((state) => state.status === "fulfilled" && state.value.ok).length;
    return { ok: healthy > 0 || this.providers.length === 0, detail: `${healthy}/${this.providers.length} providers healthy` };
  }
}
