import AjvModule, { type ValidateFunction } from "ajv";

export const PROTOCOL_VERSION = "1.0.0";

export interface ProtocolEnvelope<TType extends string, TPayload> {
  readonly protocolVersion: string;
  readonly type: TType;
  readonly requestId?: string;
  readonly timestamp: string;
  readonly payload: TPayload;
}

export interface ErrorEnvelopePayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly category: string;
    readonly retryable: boolean;
    readonly context?: Readonly<Record<string, unknown>>;
  };
}

export function createEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  options: { readonly requestId?: string; readonly now?: Date } = {},
): ProtocolEnvelope<TType, TPayload> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    timestamp: (options.now ?? new Date()).toISOString(),
    payload,
  };
}

export const protocolEnvelopeSchema = {
  $id: "cms://protocol/envelope/v1",
  type: "object",
  required: ["protocolVersion", "type", "timestamp", "payload"],
  properties: {
    protocolVersion: { type: "string", const: PROTOCOL_VERSION },
    type: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    payload: {},
  },
  additionalProperties: false,
} as const;

let validator: ValidateFunction | undefined;

function protocolAjv(): { compile(schema: unknown): ValidateFunction } {
  const AjvConstructor = AjvModule as unknown as new (options: {
    readonly strict: boolean;
    readonly formats: Readonly<Record<string, { readonly validate: (value: string) => boolean }>>;
  }) => { compile(schema: unknown): ValidateFunction };
  return new AjvConstructor({
    strict: true,
    formats: {
      "date-time": {
        validate: (value: string) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
          !Number.isNaN(Date.parse(value)),
      },
    },
  });
}

export function compileProtocolSchema<TValue>(
  schema: unknown,
): (value: unknown) => value is TValue {
  const compiled = protocolAjv().compile(schema);
  return (value: unknown): value is TValue => compiled(value);
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope<string, unknown> {
  const current = validator ?? protocolAjv().compile(protocolEnvelopeSchema);
  validator = current;
  return current(value);
}
