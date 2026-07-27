export interface LogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly requestId?: string;
  readonly actorId?: string;
  readonly changeId?: string;
  readonly repository?: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CmsLogger {
  write(record: LogRecord): void;
}

const SECRET_KEYS = /token|secret|cookie|private.?key|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SECRET_KEYS.test(key) ? "[REDACTED]" : redact(child),
    ]),
  );
}

export function consoleLogger(
  consoleLike: Pick<Console, "debug" | "info" | "warn" | "error"> = console,
): CmsLogger {
  return {
    write(record) {
      const safe = redact(record) as LogRecord;
      consoleLike[record.level](JSON.stringify(safe));
    },
  };
}

export async function measured<TResult>(
  logger: CmsLogger,
  event: string,
  operation: () => Promise<TResult>,
  context: Omit<LogRecord, "event" | "level" | "durationMs"> = {},
): Promise<TResult> {
  const started = performance.now();
  try {
    const result = await operation();
    logger.write({ level: "info", event, ...context, durationMs: performance.now() - started });
    return result;
  } catch (error) {
    logger.write({
      level: "error",
      event,
      ...context,
      durationMs: performance.now() - started,
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
