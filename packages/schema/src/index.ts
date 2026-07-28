import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";

export type FieldKind =
  | "text"
  | "rich-text"
  | "number"
  | "boolean"
  | "select"
  | "date"
  | "datetime"
  | "slug"
  | "link"
  | "asset"
  | "reference"
  | "object"
  | "list"
  | "blocks"
  | "json";

export interface BaseField<TKind extends FieldKind> {
  readonly kind: TKind;
  readonly label?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly localized?: boolean;
  readonly inline?: boolean;
}

export interface TextField extends BaseField<"text" | "rich-text" | "slug"> {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly allowedNodes?: readonly string[];
}

export interface NumberField extends BaseField<"number"> {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer?: boolean;
}

export interface BooleanField extends BaseField<"boolean"> {
  readonly defaultValue?: boolean;
}

export interface SelectField extends BaseField<"select"> {
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string;
  readonly multiple?: boolean;
}

export interface TemporalField extends BaseField<"date" | "datetime"> {}

export interface LinkField extends BaseField<"link"> {
  readonly allowedProtocols?: readonly string[];
}

export interface AssetField extends BaseField<"asset"> {
  readonly accept?: readonly string[];
  readonly aspectRatio?: readonly [number, number];
}

export interface ReferenceField extends BaseField<"reference"> {
  readonly collections: readonly string[];
  readonly multiple?: boolean;
}

export interface ObjectField extends BaseField<"object"> {
  readonly fields: FieldRecord;
}

export interface ListField extends BaseField<"list"> {
  readonly of: FieldDefinition;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface BlocksField extends BaseField<"blocks"> {
  readonly allowed: readonly string[];
}

export interface JsonField extends BaseField<"json"> {}

export type FieldDefinition =
  | TextField
  | NumberField
  | BooleanField
  | SelectField
  | TemporalField
  | LinkField
  | AssetField
  | ReferenceField
  | ObjectField
  | ListField
  | BlocksField
  | JsonField;

export type FieldRecord = Readonly<Record<string, FieldDefinition>>;

type WithoutKind<TField extends FieldDefinition> = Omit<TField, "kind">;

function field<TField extends FieldDefinition>(
  kind: TField["kind"],
  options: WithoutKind<TField>,
): TField {
  return Object.freeze({ kind, ...options }) as TField;
}

export const fields = {
  text: (options: WithoutKind<TextField> = {}): TextField => field("text", options),
  richText: (options: WithoutKind<TextField> = {}): TextField => field("rich-text", options),
  number: (options: WithoutKind<NumberField> = {}): NumberField => field("number", options),
  boolean: (options: WithoutKind<BooleanField> = {}): BooleanField => field("boolean", options),
  select: (options: WithoutKind<SelectField>): SelectField => field("select", options),
  date: (options: WithoutKind<TemporalField> = {}): TemporalField => field("date", options),
  datetime: (options: WithoutKind<TemporalField> = {}): TemporalField => field("datetime", options),
  slug: (options: WithoutKind<TextField> = {}): TextField => field("slug", options),
  link: (options: WithoutKind<LinkField> = {}): LinkField => field("link", options),
  asset: (options: WithoutKind<AssetField> = {}): AssetField => field("asset", options),
  reference: (options: WithoutKind<ReferenceField>): ReferenceField => field("reference", options),
  object: (options: WithoutKind<ObjectField>): ObjectField => field("object", options),
  list: (options: WithoutKind<ListField>): ListField => field("list", options),
  blocks: (options: WithoutKind<BlocksField>): BlocksField => field("blocks", options),
  json: (options: WithoutKind<JsonField> = {}): JsonField => field("json", options),
} as const;

export interface DefinitionConstraints {
  readonly allowedParents?: readonly string[];
  readonly minInstances?: number;
  readonly maxInstances?: number;
  readonly recommendedPosition?: "first" | "last";
}

export interface SchemaMigrationMetadata {
  readonly from: number;
  readonly to: number;
  readonly description: string;
}

export interface SchemaDefinition<TFields extends FieldRecord = FieldRecord> {
  readonly kind: "section" | "collection" | "page" | "post" | "global" | "settings";
  readonly name: string;
  readonly version: number;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly fields: TFields;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly constraints?: DefinitionConstraints;
  readonly features?: readonly ("routing" | "seo" | "localization" | "publication")[];
  readonly migrations?: readonly SchemaMigrationMetadata[];
}

type DefinitionInput<TFields extends FieldRecord> = Omit<SchemaDefinition<TFields>, "kind">;

function assertStableName(kind: string, name: string, version: number): void {
  if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) {
    throw new Error(`${kind} name "${name}" must be a stable identifier.`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`${kind} "${name}" must have a positive integer version.`);
  }
}

function assertMigrationChain(
  name: string,
  version: number,
  migrations: readonly SchemaMigrationMetadata[] | undefined,
): void {
  if (version === 1 && (migrations === undefined || migrations.length === 0)) return;
  let current = 1;
  for (const migration of migrations ?? []) {
    if (
      migration.from !== current ||
      migration.to !== current + 1 ||
      migration.description.trim().length === 0
    ) {
      throw new Error(`Schema "${name}" has an invalid migration from version ${current}.`);
    }
    current = migration.to;
  }
  if (current !== version) {
    throw new Error(`Schema "${name}" is missing a migration from version ${current}.`);
  }
}

function define<TFields extends FieldRecord>(
  kind: SchemaDefinition["kind"],
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> {
  assertStableName("Schema", input.name, input.version);
  assertMigrationChain(input.name, input.version, input.migrations);
  return Object.freeze({ kind, ...input });
}

export const defineSection = <TFields extends FieldRecord>(
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> => define("section", input);
export const defineCollection = <TFields extends FieldRecord>(
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> => define("collection", input);
export const definePageType = <TFields extends FieldRecord>(
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> => define("page", input);
export const definePostType = <TFields extends FieldRecord>(
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> => define("post", input);
export const defineGlobal = <TFields extends FieldRecord>(
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> => define("global", input);
export const defineSettings = <TFields extends FieldRecord>(
  input: DefinitionInput<TFields>,
): SchemaDefinition<TFields> => define("settings", input);

export interface TemplateSection {
  readonly id: string;
  readonly type: string;
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface TemplateDefinition {
  readonly kind: "template";
  readonly name: string;
  readonly version: number;
  readonly label: string;
  readonly description?: string;
  readonly pageType: string;
  readonly sections: readonly TemplateSection[];
}

export function defineTemplate(input: Omit<TemplateDefinition, "kind">): TemplateDefinition {
  assertStableName("Template", input.name, input.version);
  const ids = new Set<string>();
  for (const section of input.sections) {
    if (section.id.trim().length === 0 || section.type.trim().length === 0) {
      throw new Error(`Template "${input.name}" contains an incomplete section.`);
    }
    if (ids.has(section.id)) {
      throw new Error(`Template "${input.name}" contains duplicate section ID "${section.id}".`);
    }
    ids.add(section.id);
  }
  return Object.freeze({ kind: "template", ...input });
}

export interface WorkflowState {
  readonly id: string;
  readonly label: string;
  readonly terminal?: boolean;
}

export interface WorkflowTransition {
  readonly from: string;
  readonly to: string;
  readonly permission: string;
  readonly confirmation?: boolean;
}

export interface WorkflowDefinition {
  readonly kind: "workflow";
  readonly name: string;
  readonly version: number;
  readonly label: string;
  readonly initialState: string;
  readonly states: readonly WorkflowState[];
  readonly transitions: readonly WorkflowTransition[];
}

export function defineWorkflow(input: Omit<WorkflowDefinition, "kind">): WorkflowDefinition {
  assertStableName("Workflow", input.name, input.version);
  const states = new Set(input.states.map((state) => state.id));
  if (!states.has(input.initialState) || states.size !== input.states.length) {
    throw new Error(`Workflow "${input.name}" has invalid or duplicate states.`);
  }
  for (const transition of input.transitions) {
    if (
      !states.has(transition.from) ||
      !states.has(transition.to) ||
      transition.permission.trim().length === 0
    ) {
      throw new Error(`Workflow "${input.name}" contains an invalid transition.`);
    }
  }
  return Object.freeze({ kind: "workflow", ...input });
}

export type CmsDefinition = SchemaDefinition | TemplateDefinition | WorkflowDefinition;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function compileStableAst<TDefinition extends CmsDefinition>(
  definition: TDefinition,
): TDefinition {
  return stableValue(definition) as TDefinition;
}

export interface JsonSchema {
  readonly [key: string]: unknown;
}

function fieldSchema(definition: FieldDefinition): JsonSchema {
  const common: Record<string, unknown> = {};
  if (definition.description !== undefined) common.description = definition.description;
  switch (definition.kind) {
    case "text":
    case "slug":
      return {
        type: "string",
        ...common,
        ...(definition.minLength === undefined ? {} : { minLength: definition.minLength }),
        ...(definition.maxLength === undefined ? {} : { maxLength: definition.maxLength }),
        ...(definition.pattern === undefined ? {} : { pattern: definition.pattern }),
      };
    case "rich-text":
      return { type: "object", ...common, required: ["type", "children"] };
    case "number":
      return {
        type: definition.integer === true ? "integer" : "number",
        ...common,
        ...(definition.minimum === undefined ? {} : { minimum: definition.minimum }),
        ...(definition.maximum === undefined ? {} : { maximum: definition.maximum }),
      };
    case "boolean":
      return { type: "boolean", ...common };
    case "select":
      return definition.multiple === true
        ? {
            type: "array",
            items: { enum: definition.options.map((option) => option.value) },
            uniqueItems: true,
          }
        : { type: "string", enum: definition.options.map((option) => option.value) };
    case "date":
      return { type: "string", format: "date", ...common };
    case "datetime":
      return { type: "string", format: "date-time", ...common };
    case "link":
      return {
        type: "object",
        required: ["href"],
        properties: { href: { type: "string" }, label: { type: "string" } },
        additionalProperties: false,
      };
    case "asset":
      return {
        type: "object",
        required: ["id", "fileName", "mimeType", "url"],
        properties: {
          id: { type: "string", pattern: "^ast_[0-9A-Za-z]+$" },
          fileName: { type: "string", minLength: 1 },
          mimeType: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 },
          altText: { type: "string" },
        },
        additionalProperties: false,
      };
    case "reference": {
      const reference = {
        type: "object",
        required: ["collection", "id"],
        properties: {
          collection: { enum: [...definition.collections] },
          id: { type: "string" },
        },
        additionalProperties: false,
      };
      return definition.multiple === true ? { type: "array", items: reference } : reference;
    }
    case "object":
      return compileFields(definition.fields);
    case "list":
      return {
        type: "array",
        items: fieldSchema(definition.of),
        ...(definition.minItems === undefined ? {} : { minItems: definition.minItems }),
        ...(definition.maxItems === undefined ? {} : { maxItems: definition.maxItems }),
      };
    case "blocks":
      return {
        type: "array",
        items: {
          type: "object",
          required: ["id", "type"],
          properties: { id: { type: "string" }, type: { enum: [...definition.allowed] } },
        },
      };
    case "json":
      return {};
  }
}

function compileFields(definitions: FieldRecord): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, definition] of Object.entries(definitions)) {
    properties[name] = fieldSchema(definition);
    if (definition.required === true) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

export function compileJsonSchema(definition: SchemaDefinition): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `cms://${definition.kind}/${definition.name}/v${definition.version}`,
    title: definition.label,
    ...compileFields(definition.fields),
  };
}

export interface EditorManifestEntry {
  readonly kind: SchemaDefinition["kind"];
  readonly name: string;
  readonly version: number;
  readonly label: string;
  readonly category?: string;
  readonly fields: readonly (FieldDefinition & { readonly name: string })[];
}

export function compileEditorManifest(definition: SchemaDefinition): EditorManifestEntry {
  return {
    kind: definition.kind,
    name: definition.name,
    version: definition.version,
    label: definition.label,
    ...(definition.category === undefined ? {} : { category: definition.category }),
    fields: Object.entries(definition.fields).map(([name, value]) => ({ name, ...value })),
  };
}

export interface McpSchemaDescription {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export function compileMcpDescription(definition: SchemaDefinition): McpSchemaDescription {
  return {
    name: `${definition.kind}_${definition.name}`,
    title: definition.label,
    description:
      definition.description ??
      `Create or update ${definition.label} content using schema version ${definition.version}.`,
    inputSchema: compileJsonSchema(definition),
  };
}

export interface ValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export type ValidationResult<TValue> =
  | { readonly valid: true; readonly value: TValue }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

export interface ValueValidator<TValue> {
  readonly validate: (value: unknown) => ValidationResult<TValue>;
}

function validationIssues(errors: readonly ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "The value is invalid.",
  }));
}

export function compileValidator<TValue = Readonly<Record<string, unknown>>>(
  definition: SchemaDefinition,
): ValueValidator<TValue> {
  const AjvConstructor = AjvModule as unknown as new (options: {
    readonly allErrors: boolean;
    readonly strict: boolean;
    readonly validateSchema: boolean;
    readonly formats: Readonly<Record<string, RegExp>>;
  }) => { compile(schema: unknown): ValidateFunction };
  const ajv = new AjvConstructor({
    allErrors: true,
    strict: false,
    validateSchema: false,
    formats: {
      date: /^\d{4}-\d{2}-\d{2}$/u,
      "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
    },
  });
  const validate = ajv.compile(compileJsonSchema(definition));
  return {
    validate(value) {
      return validate(value)
        ? { valid: true, value: value as TValue }
        : { valid: false, issues: validationIssues(validate.errors) };
    },
  };
}

export interface ZodLikeSchema<TValue> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: TValue }
    | { readonly success: false; readonly error: unknown };
}

export function fromZod<TValue>(schema: ZodLikeSchema<TValue>): ValueValidator<TValue> {
  return {
    validate(value) {
      const result = schema.safeParse(value);
      return result.success
        ? { valid: true, value: result.data }
        : {
            valid: false,
            issues: [
              {
                path: "/",
                keyword: "zod",
                message:
                  result.error instanceof Error ? result.error.message : "Zod validation failed.",
              },
            ],
          };
    },
  };
}

export interface CompiledMigrationMetadata {
  readonly schema: string;
  readonly currentVersion: number;
  readonly chain: readonly SchemaMigrationMetadata[];
}

export function compileMigrationMetadata(definition: SchemaDefinition): CompiledMigrationMetadata {
  return {
    schema: `${definition.kind}/${definition.name}`,
    currentVersion: definition.version,
    chain: definition.migrations ?? [],
  };
}

function fieldType(definition: FieldDefinition): string {
  switch (definition.kind) {
    case "text":
    case "slug":
    case "date":
    case "datetime":
      return "string";
    case "rich-text":
    case "json":
      return "unknown";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "select": {
      const values = definition.options.map((option) => JSON.stringify(option.value)).join(" | ");
      return definition.multiple === true ? `readonly (${values})[]` : values;
    }
    case "link":
      return "{ readonly href: string; readonly label?: string }";
    case "asset":
      return "{ readonly id: string; readonly fileName: string; readonly mimeType: string; readonly url: string; readonly altText?: string }";
    case "reference": {
      const value = "{ readonly collection: string; readonly id: string }";
      return definition.multiple === true ? `readonly ${value}[]` : value;
    }
    case "object":
      return `{ ${Object.entries(definition.fields)
        .map(
          ([name, value]) =>
            `readonly ${JSON.stringify(name)}${value.required === true ? "" : "?"}: ${fieldType(value)};`,
        )
        .join(" ")} }`;
    case "list":
      return `readonly ${fieldType(definition.of)}[]`;
    case "blocks":
      return "{ readonly id: string; readonly type: string; readonly [key: string]: unknown }[]";
  }
}

export function compileTypes(definition: SchemaDefinition): string {
  const typeName = `${definition.name[0]?.toUpperCase() ?? ""}${definition.name.slice(1)}Data`;
  const fieldsSource = Object.entries(definition.fields)
    .map(
      ([name, value]) =>
        `  readonly ${JSON.stringify(name)}${value.required === true ? "" : "?"}: ${fieldType(value)};`,
    )
    .join("\n");
  return `export interface ${typeName} {\n${fieldsSource}\n}\n`;
}

export type RichTextElementType =
  | "paragraph"
  | "heading"
  | "quote"
  | "unordered-list"
  | "ordered-list"
  | "list-item"
  | "link"
  | "code"
  | "hard-break";

export interface RichTextText {
  readonly type: "text";
  readonly text: string;
  readonly marks?: readonly ("bold" | "italic" | "underline" | "code")[];
}

export interface RichTextElement {
  readonly type: RichTextElementType;
  readonly level?: 1 | 2 | 3 | 4 | 5 | 6;
  readonly url?: string;
  readonly children: readonly PortableRichTextNode[];
}

export type PortableRichTextNode = RichTextText | RichTextElement;

export interface PortableRichTextRoot {
  readonly type: "root";
  readonly children: readonly PortableRichTextNode[];
}

const DEFAULT_RICH_TEXT_ELEMENTS: ReadonlySet<RichTextElementType> = new Set([
  "paragraph",
  "heading",
  "quote",
  "unordered-list",
  "ordered-list",
  "list-item",
  "link",
  "code",
  "hard-break",
]);

function safeLink(value: unknown, protocols: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  if (value.startsWith("/") || value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizePortableRichText(
  value: unknown,
  options: {
    readonly allowedElements?: ReadonlySet<RichTextElementType>;
    readonly allowedProtocols?: ReadonlySet<string>;
    readonly maximumNodes?: number;
    readonly maximumDepth?: number;
  } = {},
): PortableRichTextRoot {
  const allowedElements = options.allowedElements ?? DEFAULT_RICH_TEXT_ELEMENTS;
  const allowedProtocols = options.allowedProtocols ?? new Set(["https:", "http:", "mailto:"]);
  const maximumNodes = options.maximumNodes ?? 10_000;
  const maximumDepth = options.maximumDepth ?? 32;
  let nodes = 0;

  function visit(node: unknown, depth: number): readonly PortableRichTextNode[] {
    if (++nodes > maximumNodes || depth > maximumDepth) {
      throw new Error("Rich text exceeds the configured complexity limit.");
    }
    if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
    const record = node as Readonly<Record<string, unknown>>;
    if (record.type === "text") {
      if (typeof record.text !== "string") return [];
      const allowedMarks = ["bold", "italic", "underline", "code"] as const;
      const marks = Array.isArray(record.marks)
        ? record.marks.filter(
            (mark): mark is (typeof allowedMarks)[number] =>
              typeof mark === "string" &&
              allowedMarks.includes(mark as (typeof allowedMarks)[number]),
          )
        : [];
      return [
        {
          type: "text",
          text: record.text.slice(0, 100_000),
          ...(marks.length === 0 ? {} : { marks: [...new Set(marks)] }),
        },
      ];
    }
    if (
      typeof record.type !== "string" ||
      !allowedElements.has(record.type as RichTextElementType)
    ) {
      return [];
    }
    const type = record.type as RichTextElementType;
    const children = Array.isArray(record.children)
      ? record.children.flatMap((child) => visit(child, depth + 1))
      : [];
    if (type === "link") {
      const url = safeLink(record.url, allowedProtocols);
      return url === undefined ? children : [{ type, url, children }];
    }
    if (type === "heading") {
      const level =
        typeof record.level === "number" &&
        Number.isInteger(record.level) &&
        record.level >= 1 &&
        record.level <= 6
          ? (record.level as NonNullable<RichTextElement["level"]>)
          : 2;
      return [{ type, level, children }];
    }
    return [{ type, children }];
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: "root", children: [] };
  }
  const root = value as Readonly<Record<string, unknown>>;
  if (root.type !== "root" || !Array.isArray(root.children)) {
    return { type: "root", children: [] };
  }
  return {
    type: "root",
    children: root.children.flatMap((child) => visit(child, 1)),
  };
}

export function richTextToPlainText(value: PortableRichTextRoot): string {
  function nodeText(node: PortableRichTextNode): string {
    return node.type === "text" ? node.text : node.children.map(nodeText).join("");
  }
  return value.children.map(nodeText).join("\n").trim();
}
