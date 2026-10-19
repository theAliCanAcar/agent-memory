/**
 * agent-memory: three levels, stupidly simple.
 *
 * 1. Working memory  — ctx.state (current task scratchpad)
 * 2. Session memory  — conversation/task history per sessionId
 * 3. Long-term memory — Supabase/Postgres + pgvector semantic recall
 */

export type SessionEvent = {
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  data?: unknown;
  at: string;
};

export type SessionMemory = {
  get(sessionId: string): Promise<SessionEvent[]>;
  append(sessionId: string, event: Omit<SessionEvent, "at"> & { at?: string }): Promise<SessionEvent>;
  clear(sessionId: string): Promise<void>;
};

export type RememberInput = {
  userId: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type MemoryRecord = {
  id: string;
  userId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  /** Similarity score when returned from search (higher = closer). */
  score?: number;
};

export type SearchInput = {
  userId: string;
  query: string;
  limit?: number;
};

export type LongTermMemory = {
  remember(input: RememberInput): Promise<MemoryRecord>;
  search(input: SearchInput): Promise<MemoryRecord[]>;
};

export type Memory = {
  session: SessionMemory;
  longTerm: LongTermMemory;
  /** Convenience aliases matching the spec examples. */
  remember(input: RememberInput): Promise<MemoryRecord>;
  search(input: SearchInput): Promise<MemoryRecord[]>;
};

export function createMemory(options: {
  session?: SessionMemory;
  longTerm?: LongTermMemory;
}): Memory {
  const session = options.session ?? createInMemorySession();
  const longTerm = options.longTerm ?? createInMemoryLongTerm();
  return {
    session,
    longTerm,
    remember: (input) => longTerm.remember(input),
    search: (input) => longTerm.search(input),
  };
}

/** In-memory session store — perfect for tests and single-process demos. */
export function createInMemorySession(): SessionMemory {
  const store = new Map<string, SessionEvent[]>();
  return {
    async get(sessionId) {
      return [...(store.get(sessionId) ?? [])];
    },
    async append(sessionId, event) {
      const full: SessionEvent = { ...event, at: event.at ?? new Date().toISOString() } as SessionEvent;
      const list = store.get(sessionId) ?? [];
      list.push(full);
      store.set(sessionId, list);
      return full;
    },
    async clear(sessionId) {
      store.delete(sessionId);
    },
  };
}

/**
 * In-memory long-term store with keyword-overlap scoring.
 * Swap for `createSupabaseLongTerm()` (pgvector) when a real database is wired up.
 */
export function createInMemoryLongTerm(): LongTermMemory {
  const records: MemoryRecord[] = [];
  let counter = 0;
  return {
    async remember(input) {
      const record: MemoryRecord = {
        id: `mem_${Date.now().toString(36)}_${(++counter).toString(36)}`,
        userId: input.userId,
        content: input.text,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      };
      records.push(record);
      return record;
    },
    async search(input) {
      const limit = input.limit ?? 5;
      const terms = tokenize(input.query);
      return records
        .filter((r) => r.userId === input.userId)
        .map((r) => ({ ...r, score: overlap(terms, tokenize(r.content)) }))
        .filter((r) => (r.score ?? 0) > 0)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
    },
  };
}

/**
 * Supabase + pgvector long-term store. Pass a thin client exposing
 * `from(table)` and `rpc(fn, args)` (e.g. `createClient(SUPABASE_URL, SERVICE_ROLE_KEY)`).
 *
 * Expected SQL (see supabase/migrations):
 *   create table memories (
 *     id uuid primary key default gen_random_uuid(),
 *     user_id text not null,
 *     content text not null,
 *     metadata jsonb default '{}',
 *     embedding vector(1536),
 *     created_at timestamptz default now()
 *   );
 */
export type SupabaseLikeClient = {
  from(table: string): {
    insert(values: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
    select(columns: string): {
      eq(column: string, value: unknown): PromiseLike<{
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      }>;
    };
  };
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export function createSupabaseLongTerm(options: {
  client: SupabaseLikeClient;
  /** Produces the 1536-dim embedding for a text (e.g. OpenAI text-embedding-3-small). */
  embed?: (text: string) => Promise<number[]>;
  table?: string;
  searchFunction?: string;
}): LongTermMemory {
  const table = options.table ?? "memories";
  const searchFn = options.searchFunction ?? "match_memories";
  return {
    async remember(input) {
      const embedding = options.embed ? await options.embed(input.text) : null;
      const row = {
        user_id: input.userId,
        content: input.text,
        metadata: input.metadata ?? {},
        ...(embedding ? { embedding } : {}),
      };
      const { error } = await options.client.from(table).insert(row);
      if (error) throw new Error(`memory.remember failed: ${error.message}`);
      return {
        id: "",
        userId: input.userId,
        content: input.text,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
      };
    },
    async search(input) {
      const limit = input.limit ?? 5;
      if (options.embed) {
        const embedding = await options.embed(input.query);
        const { data, error } = await options.client.rpc(searchFn, {
          query_embedding: embedding,
          match_threshold: 0.5,
          match_count: limit,
          p_user_id: input.userId,
        });
        if (error) throw new Error(`memory.search failed: ${error.message}`);
        return ((data as Array<Record<string, unknown>>) ?? []).map(toRecord);
      }
      // No embedder: fall back to exact-ish filtering by user.
      const { data, error } = await options.client.from(table).select("*").eq("user_id", input.userId);
      if (error) throw new Error(`memory.search failed: ${error.message}`);
      return ((data as Array<Record<string, unknown>>) ?? []).slice(0, limit).map(toRecord);
    },
  };
}

function toRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id ?? ""),
    userId: String(row.user_id ?? ""),
    content: String(row.content ?? ""),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const term of a) if (b.has(term)) hits++;
  return a.size === 0 ? 0 : hits / a.size;
}