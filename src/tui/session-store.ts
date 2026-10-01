import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  runtimeEventTypes,
  type RuntimeEvent,
} from "../runtime/runtime-events.js";

export type TuiSessionStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface TuiSessionRunRecord {
  id: string;
  kind: "workflow-step" | "message" | "agent" | "publish";
  label: string;
  agentId?: string;
  task?: string;
  summary: string;
  workspacePath?: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
}

export interface TuiSessionRecord {
  id: string;
  agentId: string;
  agentIdentity?: string;
  agentName: string;
  repositoryUrl: string;
  placement: "local" | "remote";
  status: TuiSessionStatus;
  workspacePath?: string;
  summary?: string;
  error?: string;
  runs: readonly TuiSessionRunRecord[];
  events: readonly RuntimeEvent[];
  startedAt: string;
  updatedAt: string;
}

export interface ConsoleMessage {
  id: number;
  level: "info" | "success" | "warning" | "error";
  text: string;
}

export interface TuiSnapshot {
  sessions: readonly TuiSessionRecord[];
  messages: readonly ConsoleMessage[];
  attachedSessionId?: string;
}

type Listener = () => void;

const sessionStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting-approval",
  "completed",
  "failed",
  "cancelled",
]);
const runtimeEventSchema = z.object({
  type: z.enum(runtimeEventTypes),
  timestamp: z.string(),
  sessionId: z.string(),
  message: z.string(),
  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
const sessionRunRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["workflow-step", "message", "agent", "publish"]),
  label: z.string(),
  agentId: z.string().optional(),
  task: z.string().optional(),
  summary: z.string(),
  workspacePath: z.string().optional(),
  status: z.enum(["completed", "failed"]),
  startedAt: z.string(),
  completedAt: z.string(),
});
const sessionRecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentIdentity: z.string().optional(),
  agentName: z.string(),
  repositoryUrl: z.string(),
  placement: z.enum(["local", "remote"]),
  status: sessionStatusSchema,
  workspacePath: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  runs: z.array(sessionRunRecordSchema).optional(),
  events: z.array(runtimeEventSchema),
  startedAt: z.string(),
  updatedAt: z.string(),
});
const persistedStoreSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionRecordSchema),
  attachedSessionId: z.string().optional(),
});

export class TuiSessionStore {
  private readonly sessions = new Map<string, TuiSessionRecord>();
  private readonly listeners = new Set<Listener>();
  private persistenceQueue = Promise.resolve();
  private persistenceError: Error | undefined;
  private messages: ConsoleMessage[] = [];
  private attachedSessionId: string | undefined;
  private messageId = 0;

  constructor(private readonly persistencePath?: string) {}

  static async open(persistencePath?: string): Promise<TuiSessionStore> {
    const store = new TuiSessionStore(persistencePath);
    if (!persistencePath) return store;
    let document: unknown;
    try {
      document = JSON.parse(await readFile(persistencePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return store;
      throw error;
    }
    const persisted = persistedStoreSchema.parse(document);
    const restoredAt = new Date().toISOString();
    for (const session of persisted.sessions) {
      const interrupted = ["queued", "running", "awaiting-approval"].includes(
        session.status,
      );
      store.sessions.set(session.id, {
        id: session.id,
        agentId: session.agentId,
        ...(session.agentIdentity === undefined
          ? {}
          : { agentIdentity: session.agentIdentity }),
        agentName: session.agentName,
        repositoryUrl: session.repositoryUrl,
        placement: session.placement,
        runs: (session.runs ?? []).map((run) => ({
          id: run.id,
          kind: run.kind,
          label: run.label,
          ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
          ...(run.task === undefined ? {} : { task: run.task }),
          summary: run.summary,
          ...(run.workspacePath === undefined
            ? {}
            : { workspacePath: run.workspacePath }),
          status: run.status,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        })),
        events: session.events.map((event) => ({
          type: event.type,
          timestamp: event.timestamp,
          sessionId: event.sessionId,
          message: event.message,
          ...(event.attributes === undefined
            ? {}
            : { attributes: event.attributes }),
        })),
        startedAt: session.startedAt,
        ...(session.workspacePath === undefined
          ? {}
          : { workspacePath: session.workspacePath }),
        ...(session.summary === undefined ? {} : { summary: session.summary }),
        ...(interrupted
          ? {
              status: "failed" as const,
              error: "TUI process ended before the session completed",
              updatedAt: restoredAt,
            }
          : {
              status: session.status,
              updatedAt: session.updatedAt,
              ...(session.error === undefined ? {} : { error: session.error }),
            }),
      });
    }
    if (
      persisted.attachedSessionId &&
      store.sessions.has(persisted.attachedSessionId)
    ) {
      store.attachedSessionId = persisted.attachedSessionId;
    }
    return store;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): TuiSnapshot {
    return {
      sessions: [...this.sessions.values()].sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt),
      ),
      messages: this.messages,
      ...(this.attachedSessionId === undefined
        ? {}
        : { attachedSessionId: this.attachedSessionId }),
    };
  }

  create(
    record: Omit<
      TuiSessionRecord,
      "runs" | "events" | "startedAt" | "updatedAt"
    >,
  ): void {
    if (this.sessions.has(record.id)) {
      throw new Error(`Session ${record.id} already exists`);
    }
    const timestamp = new Date().toISOString();
    this.sessions.set(record.id, {
      ...record,
      runs: [],
      events: [],
      startedAt: timestamp,
      updatedAt: timestamp,
    });
    this.emit(true);
  }

  update(
    sessionId: string,
    patch: Partial<
      Pick<
        TuiSessionRecord,
        "status" | "workspacePath" | "summary" | "error"
      >
    >,
  ): void {
    const current = this.requireSession(sessionId);
    this.sessions.set(sessionId, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.emit(true);
  }

  appendEvent(event: RuntimeEvent): void {
    const current = this.requireSession(event.sessionId);
    this.sessions.set(event.sessionId, {
      ...current,
      events: [...current.events, event],
      updatedAt: event.timestamp,
    });
    this.emit(true);
  }

  appendRun(sessionId: string, run: TuiSessionRunRecord): void {
    const current = this.requireSession(sessionId);
    this.sessions.set(sessionId, {
      ...current,
      runs: [...current.runs, run],
      updatedAt: run.completedAt,
    });
    this.emit(true);
  }

  message(level: ConsoleMessage["level"], text: string): void {
    this.messageId += 1;
    this.messages = [
      ...this.messages.slice(-19),
      { id: this.messageId, level, text },
    ];
    this.emit(false);
  }

  clearMessages(): void {
    this.messages = [];
    this.emit(false);
  }

  attach(sessionId: string): void {
    this.requireSession(sessionId);
    this.attachedSessionId = sessionId;
    this.emit(true);
  }

  detach(): void {
    this.attachedSessionId = undefined;
    this.emit(true);
  }

  get(sessionId: string): TuiSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  resolveId(prefix: string): string {
    const matches = [...this.sessions.keys()].filter((id) => id.startsWith(prefix));
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Session ${prefix} was not found`
          : `Session prefix ${prefix} is ambiguous`,
      );
    }
    return matches[0] ?? prefix;
  }

  async flush(): Promise<void> {
    await this.persistenceQueue;
    if (this.persistenceError) throw this.persistenceError;
  }

  private requireSession(sessionId: string): TuiSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} was not found`);
    }
    return session;
  }

  private emit(persist: boolean): void {
    if (persist) this.schedulePersistence();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private schedulePersistence(): void {
    if (!this.persistencePath) return;
    this.persistenceQueue = this.persistenceQueue.then(async () => {
      try {
        await persistStore(this.persistencePath!, this.snapshot());
        this.persistenceError = undefined;
      } catch (error) {
        this.persistenceError =
          error instanceof Error ? error : new Error(String(error));
      }
    });
  }
}

async function persistStore(path: string, snapshot: TuiSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        version: 1,
        sessions: snapshot.sessions,
        ...(snapshot.attachedSessionId === undefined
          ? {}
          : { attachedSessionId: snapshot.attachedSessionId }),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}