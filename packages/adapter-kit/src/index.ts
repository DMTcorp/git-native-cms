export type {
  AssetStore,
  AuditSink,
  Clock,
  ContentRepository,
  GitProvider,
  IdGenerator,
  IdempotencyStore,
  ReleaseStore,
  SessionStore,
} from "@git-native-cms/application";

export interface ContractTestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details?: string;
}

export async function verifyIdempotent<TResult>(
  operation: () => Promise<TResult>,
): Promise<ContractTestResult> {
  const first = await operation();
  const second = await operation();
  const passed = JSON.stringify(first) === JSON.stringify(second);
  return {
    name: "idempotency",
    passed,
    ...(passed ? {} : { details: "Repeated calls returned different results." }),
  };
}

export * from "./contracts.js";
