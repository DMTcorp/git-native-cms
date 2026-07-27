export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type ActorId = Brand<string, "ActorId">;
export type ChangeId = Brand<string, "ChangeId">;
export type DocumentId = Brand<string, "DocumentId">;
export type AssetId = Brand<string, "AssetId">;
export type ReleaseId = Brand<string, "ReleaseId">;
export type GitCommitSha = Brand<string, "GitCommitSha">;
export type Revision = GitCommitSha;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

export type CmsErrorCategory =
  | "validation"
  | "authorization"
  | "authentication"
  | "conflict"
  | "git"
  | "storage"
  | "network"
  | "configuration"
  | "internal";

export interface CmsErrorShape {
  readonly code: string;
  readonly message: string;
  readonly category: CmsErrorCategory;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class CmsError extends Error implements CmsErrorShape {
  readonly code: string;
  readonly category: CmsErrorCategory;
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(shape: CmsErrorShape) {
    super(shape.message, shape.cause === undefined ? undefined : { cause: shape.cause });
    this.name = "CmsError";
    this.code = shape.code;
    this.category = shape.category;
    this.retryable = shape.retryable;
    if (shape.context !== undefined) this.context = shape.context;
    if (shape.cause !== undefined) this.cause = shape.cause;
  }

  toJSON(): CmsErrorShape {
    return {
      code: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      ...(this.context === undefined ? {} : { context: this.context }),
    };
  }
}

export type RoleName =
  | "viewer"
  | "author"
  | "editor"
  | "translator"
  | "reviewer"
  | "publisher"
  | "developer"
  | "administrator"
  | Brand<string, "CustomRole">;

export interface Actor {
  readonly id: ActorId;
  readonly githubId: number;
  readonly login: string;
  readonly displayName: string;
  readonly roles: readonly RoleName[];
  readonly source: "ui" | "cli" | "mcp" | "action";
}

export type ChangeStatus =
  "draft" | "in_review" | "changes_requested" | "approved" | "staging" | "published" | "archived";

export interface Change {
  readonly id: ChangeId;
  readonly name: string;
  readonly description?: string;
  readonly ownerId: ActorId;
  readonly baseBranch: string;
  readonly baseCommit: GitCommitSha;
  readonly branchName: string;
  readonly status: ChangeStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ContentDocument<TData = unknown> {
  readonly id: DocumentId;
  readonly type: string;
  readonly schemaVersion: number;
  readonly revision: Revision;
  readonly data: TData;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number): string {
  let value = Math.max(0, Math.floor(time));
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = CROCKFORD[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && output.length < 16) {
      bitCount -= 5;
      output += CROCKFORD[(bits >> bitCount) & 31];
    }
  }
  while (output.length < 16) output += "0";
  return output;
}

export function createPrefixedId<TBrand extends string>(
  prefix: string,
  options: {
    readonly now?: number;
    readonly random?: Uint8Array;
  } = {},
): Brand<string, TBrand> {
  const random = options.random ?? globalThis.crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}_${encodeTime(options.now ?? Date.now())}${encodeRandom(random)}` as Brand<
    string,
    TBrand
  >;
}

export function isoTimestamp(date: Date = new Date()): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}

export function assertNever(value: never): never {
  throw new CmsError({
    code: "CMS_INTERNAL_001",
    message: `Unhandled value: ${String(value)}`,
    category: "internal",
    retryable: false,
  });
}

export function isCmsError(value: unknown): value is CmsError {
  return value instanceof CmsError;
}
