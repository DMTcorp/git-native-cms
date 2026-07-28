"use client";

import { createElement, useEffect, useId, useMemo, useRef, type ReactElement } from "react";
import { createEditor, type SerializedEditorState } from "lexical";
import type { Asset, AssetReference, DocumentSummary } from "@git-native-cms/application";
import { createPrefixedId } from "@git-native-cms/core";
import { Button, TextField } from "@git-native-cms/editor-ui";

export interface EditorFieldManifest {
  readonly name: string;
  readonly kind: string;
  readonly label: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly inline?: boolean;
  readonly localized?: boolean;
  readonly accept?: readonly string[];
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly multiple?: boolean;
  readonly collections?: readonly string[];
  readonly allowed?: readonly string[];
  readonly allowedProtocols?: readonly string[];
  readonly fields?: readonly EditorFieldManifest[];
  readonly of?: EditorFieldManifest;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly blocks?: readonly EditorBlockManifest[];
  readonly extension?: {
    readonly src: string;
    readonly origin: string;
    readonly title?: string;
  };
}

export interface EditorBlockManifest {
  readonly type: string;
  readonly label: string;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly fields: readonly EditorFieldManifest[];
}

export interface FieldEditorRenderProps {
  readonly field: EditorFieldManifest;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly assets: readonly Asset[];
  readonly documents: readonly DocumentSummary[];
  readonly path: readonly string[];
  readonly registry: EditorFieldRegistry;
  readonly onChange: (value: unknown) => void;
  readonly onOpenAsset: (field: EditorFieldManifest, path: readonly string[]) => void;
}

export type FieldEditorRenderer = (props: FieldEditorRenderProps) => ReactElement;

export interface EditorFieldRegistry {
  readonly renderers: ReadonlyMap<string, FieldEditorRenderer>;
}

function assetReference(value: unknown): AssetReference | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.id !== "string" ||
    !record.id.startsWith("ast_") ||
    typeof record.fileName !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.url !== "string"
  ) {
    return undefined;
  }
  return {
    id: record.id as AssetReference["id"],
    fileName: record.fileName,
    mimeType: record.mimeType,
    url: record.url,
    ...(typeof record.altText === "string" ? { altText: record.altText } : {}),
  };
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function defaultFieldValue(field: EditorFieldManifest): unknown {
  switch (field.kind) {
    case "text":
    case "slug":
    case "date":
    case "datetime":
      return "";
    case "rich-text":
      return { type: "root", children: [] };
    case "number":
      return 0;
    case "boolean":
      return false;
    case "select":
      return field.multiple === true ? [] : (field.options?.[0]?.value ?? "");
    case "link":
      return { href: "", label: "" };
    case "asset":
      return null;
    case "reference":
      return field.multiple === true ? [] : null;
    case "object":
      return Object.fromEntries(
        (field.fields ?? []).map((nested) => [nested.name, defaultFieldValue(nested)]),
      );
    case "list":
    case "blocks":
      return [];
    case "json":
      return {};
    default:
      return null;
  }
}

function PortableRichTextField(props: FieldEditorRenderProps): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const namespace = useId();
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const editor = useMemo(
    () =>
      createEditor({
        namespace: `cms-rich-text-${namespace}`,
        onError(error) {
          throw error;
        },
      }),
    [namespace],
  );
  useEffect(() => {
    editor.setRootElement(root.current);
    const unregister = editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has("cms-external-value")) return;
      const serialized = editorState.toJSON() as unknown as Readonly<Record<string, unknown>>;
      onChange.current(serialized.root ?? serialized);
    });
    return () => {
      unregister();
      editor.setRootElement(null);
    };
  }, [editor]);
  useEffect(() => {
    editor.setEditable(!props.disabled);
  }, [editor, props.disabled]);
  useEffect(() => {
    try {
      const value = recordValue(props.value);
      const serialized = ("root" in value
        ? value
        : { root: value }) as unknown as SerializedEditorState;
      const source = JSON.stringify(serialized);
      if (JSON.stringify(editor.getEditorState().toJSON()) === source) return;
      editor.setEditorState(editor.parseEditorState(source), { tag: "cms-external-value" });
    } catch {
      // Invalid portable rich text remains recoverable in the editor.
    }
  }, [editor, props.value]);
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.field.label}</span>
      <div
        ref={root}
        className="cms-rich-text"
        contentEditable={!props.disabled}
        role="textbox"
        aria-multiline="true"
        aria-label={props.field.label}
        suppressContentEditableWarning
      />
      {props.field.description !== undefined && <small>{props.field.description}</small>}
    </label>
  );
}

function TextFieldEditor(props: FieldEditorRenderProps): ReactElement {
  return (
    <TextField
      label={props.field.label}
      value={typeof props.value === "string" ? props.value : ""}
      isDisabled={props.disabled}
      onChange={props.onChange}
    />
  );
}

function NumberFieldEditor(props: FieldEditorRenderProps): ReactElement {
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.field.label}</span>
      <input
        className="cms-field__input"
        type="number"
        value={typeof props.value === "number" ? props.value : ""}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(
            event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
          )
        }
      />
    </label>
  );
}

function BooleanFieldEditor(props: FieldEditorRenderProps): ReactElement {
  return (
    <label className="cms-field cms-field--boolean">
      <input
        type="checkbox"
        checked={props.value === true}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.field.label}</span>
    </label>
  );
}

function SelectFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const selected = props.field.multiple
    ? Array.isArray(props.value)
      ? props.value.map(String)
      : []
    : typeof props.value === "string"
      ? props.value
      : "";
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.field.label}</span>
      <select
        className="cms-field__input"
        value={selected}
        multiple={props.field.multiple === true}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(
            props.field.multiple === true
              ? [...event.currentTarget.selectedOptions].map((option) => option.value)
              : event.currentTarget.value,
          )
        }
      >
        {props.field.multiple !== true && <option value="">Choose…</option>}
        {props.field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TemporalFieldEditor(props: FieldEditorRenderProps): ReactElement {
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.field.label}</span>
      <input
        className="cms-field__input"
        type={props.field.kind === "date" ? "date" : "datetime-local"}
        value={
          typeof props.value !== "string"
            ? ""
            : props.field.kind === "datetime"
              ? props.value.replace(/Z$/u, "").slice(0, 16)
              : props.value.slice(0, 10)
        }
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(
            props.field.kind === "datetime" && event.currentTarget.value.length > 0
              ? new Date(event.currentTarget.value).toISOString()
              : event.currentTarget.value,
          )
        }
      />
    </label>
  );
}

function LinkFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const link = recordValue(props.value);
  const update = (key: "href" | "label", value: string): void => {
    props.onChange({ ...link, [key]: value });
  };
  return (
    <fieldset className="cms-field-group">
      <legend>{props.field.label}</legend>
      <label className="cms-field">
        <span className="cms-field__label">URL</span>
        <input
          className="cms-field__input"
          type="url"
          value={typeof link.href === "string" ? link.href : ""}
          disabled={props.disabled}
          placeholder="https://example.com/path"
          onChange={(event) => update("href", event.currentTarget.value)}
        />
      </label>
      <TextField
        label="Label"
        value={typeof link.label === "string" ? link.label : ""}
        isDisabled={props.disabled}
        onChange={(value) => update("label", value)}
      />
    </fieldset>
  );
}

function ReferenceFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const candidates = props.documents.filter(
    (document) =>
      props.field.collections === undefined ||
      props.field.collections.length === 0 ||
      props.field.collections.includes(document.type),
  );
  const references = Array.isArray(props.value)
    ? props.value.map(recordValue)
    : [recordValue(props.value)];
  const selected = props.field.multiple
    ? references
        .map((reference) => (typeof reference.id === "string" ? reference.id : ""))
        .filter(Boolean)
    : typeof references[0]?.id === "string"
      ? references[0].id
      : "";
  const referenceFor = (id: string): { readonly collection: string; readonly id: string } => {
    const document = candidates.find((candidate) => candidate.id === id);
    return { collection: document?.type ?? props.field.collections?.[0] ?? "content", id };
  };
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.field.label}</span>
      <select
        className="cms-field__input"
        value={selected}
        multiple={props.field.multiple === true}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(
            props.field.multiple === true
              ? [...event.currentTarget.selectedOptions].map((option) => referenceFor(option.value))
              : event.currentTarget.value === ""
                ? null
                : referenceFor(event.currentTarget.value),
          )
        }
      >
        {props.field.multiple !== true && <option value="">No reference</option>}
        {candidates.map((document) => (
          <option key={document.id} value={document.id}>
            {document.title} · {document.type}
          </option>
        ))}
      </select>
    </label>
  );
}

function AssetFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const reference = assetReference(props.value);
  const catalogAsset = props.assets.find((asset) => asset.id === reference?.id);
  return (
    <section className="cms-media-field">
      <div className="cms-media-field__heading">
        <span>
          <strong>{props.field.label}</strong>
          {props.field.required === true && <small>Required</small>}
        </span>
        {props.field.description !== undefined && <p>{props.field.description}</p>}
      </div>
      {reference === undefined ? (
        <button
          type="button"
          className="cms-media-field__empty"
          disabled={props.disabled}
          onClick={() => props.onOpenAsset(props.field, props.path)}
        >
          <span aria-hidden="true">＋</span>
          <strong>Choose {props.field.label}</strong>
          <small>{props.field.accept?.join(", ") ?? "Any file from asset storage"}</small>
        </button>
      ) : (
        <>
          <div className="cms-media-field__selection">
            {reference.mimeType.startsWith("image/") ? (
              <img src={reference.url} alt="" />
            ) : (
              <span className="cms-asset-file" aria-hidden="true">
                {reference.mimeType === "application/pdf" ? "PDF" : "FILE"}
              </span>
            )}
            <span>
              <strong>{reference.fileName}</strong>
              <small>
                {catalogAsset === undefined
                  ? reference.mimeType
                  : `${(catalogAsset.size / 1024).toFixed(1)} KB · ${catalogAsset.mimeType}`}
              </small>
            </span>
          </div>
          <TextField
            label={`Alternative text for ${props.field.label}`}
            value={reference.altText ?? ""}
            isDisabled={props.disabled}
            onChange={(altText) => props.onChange({ ...reference, altText })}
          />
          <div className="cms-media-field__actions">
            <Button
              onPress={() => props.onOpenAsset(props.field, props.path)}
              isDisabled={props.disabled}
            >
              Replace
            </Button>
            <Button tone="danger" onPress={() => props.onChange(null)} isDisabled={props.disabled}>
              Remove
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function ObjectFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const value = recordValue(props.value);
  return (
    <fieldset className="cms-field-group">
      <legend>{props.field.label}</legend>
      {props.field.description !== undefined && <p>{props.field.description}</p>}
      {(props.field.fields ?? []).map((field) => (
        <SchemaFieldEditor
          key={field.name}
          {...props}
          field={field}
          value={value[field.name]}
          path={[...props.path, field.name]}
          onChange={(next) => props.onChange({ ...value, [field.name]: next })}
        />
      ))}
    </fieldset>
  );
}

function ListFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const values: readonly unknown[] = Array.isArray(props.value) ? props.value : [];
  const itemField = props.field.of ?? {
    name: "item",
    kind: "json",
    label: "Item",
  };
  const minimum = props.field.minItems ?? 0;
  const maximum = props.field.maxItems ?? Number.POSITIVE_INFINITY;
  const replace = (index: number, next: unknown): void => {
    props.onChange(values.map((value, candidate) => (candidate === index ? next : value)));
  };
  const move = (index: number, offset: -1 | 1): void => {
    const target = index + offset;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    const current = next[index];
    next[index] = next[target];
    next[target] = current;
    props.onChange(next);
  };
  return (
    <fieldset className="cms-field-group cms-field-list">
      <legend>{props.field.label}</legend>
      {values.length === 0 && <p>No items yet.</p>}
      {values.map((value, index) => (
        <section className="cms-field-list__item" key={`${props.field.name}:${String(index)}`}>
          <header>
            <strong>Item {index + 1}</strong>
            <span>
              <button
                type="button"
                aria-label={`Move item ${index + 1} up`}
                disabled={props.disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move item ${index + 1} down`}
                disabled={props.disabled || index === values.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={props.disabled || values.length <= minimum}
                onClick={() => props.onChange(values.filter((_, candidate) => candidate !== index))}
              >
                Remove
              </button>
            </span>
          </header>
          <SchemaFieldEditor
            {...props}
            field={{
              ...itemField,
              name: String(index),
              label: itemField.label || `Item ${index + 1}`,
            }}
            value={value}
            path={[...props.path, String(index)]}
            onChange={(next) => replace(index, next)}
          />
        </section>
      ))}
      <Button
        onPress={() => props.onChange([...values, defaultFieldValue(itemField)])}
        isDisabled={props.disabled || values.length >= maximum}
      >
        Add item
      </Button>
    </fieldset>
  );
}

function BlocksFieldEditor(props: FieldEditorRenderProps): ReactElement {
  const blocks = Array.isArray(props.value)
    ? props.value.filter(
        (value): value is Readonly<Record<string, unknown>> =>
          typeof value === "object" && value !== null && !Array.isArray(value),
      )
    : [];
  const available = (props.field.blocks ?? []).filter(
    (block) => props.field.allowed === undefined || props.field.allowed.includes(block.type),
  );
  return (
    <fieldset className="cms-field-group cms-field-list">
      <legend>{props.field.label}</legend>
      {blocks.map((block, index) => {
        const type = typeof block.type === "string" ? block.type : "";
        const manifest = available.find((candidate) => candidate.type === type);
        return (
          <section
            className="cms-field-list__item"
            key={typeof block.id === "string" ? block.id : index}
          >
            <header>
              <strong>{(manifest?.label ?? type) || `Block ${index + 1}`}</strong>
              <button
                type="button"
                disabled={props.disabled}
                onClick={() => props.onChange(blocks.filter((_, candidate) => candidate !== index))}
              >
                Remove
              </button>
            </header>
            {(manifest?.fields ?? []).map((field) => (
              <SchemaFieldEditor
                key={field.name}
                {...props}
                field={field}
                value={block[field.name]}
                path={[...props.path, String(index), field.name]}
                onChange={(next) =>
                  props.onChange(
                    blocks.map((candidate, candidateIndex) =>
                      candidateIndex === index ? { ...candidate, [field.name]: next } : candidate,
                    ),
                  )
                }
              />
            ))}
          </section>
        );
      })}
      {available.length === 0 ? (
        <p>No compatible block definitions are registered.</p>
      ) : (
        <label className="cms-field">
          <span className="cms-field__label">Add block</span>
          <select
            className="cms-field__input"
            value=""
            disabled={props.disabled}
            onChange={(event) => {
              const block = available.find(
                (candidate) => candidate.type === event.currentTarget.value,
              );
              if (block === undefined) return;
              props.onChange([
                ...blocks,
                {
                  ...block.defaults,
                  id: createPrefixedId("blk"),
                  type: block.type,
                },
              ]);
            }}
          >
            <option value="">Choose block…</option>
            {available.map((block) => (
              <option key={block.type} value={block.type}>
                {block.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}

function JsonFieldEditor(props: FieldEditorRenderProps): ReactElement {
  return (
    <label className="cms-field">
      <span className="cms-field__label">{props.field.label}</span>
      <textarea
        className="cms-field__input cms-field__input--json"
        defaultValue={JSON.stringify(props.value ?? null, null, 2)}
        disabled={props.disabled}
        onBlur={(event) => {
          try {
            props.onChange(JSON.parse(event.currentTarget.value));
            event.currentTarget.setCustomValidity("");
          } catch {
            event.currentTarget.setCustomValidity("Enter valid JSON.");
            event.currentTarget.reportValidity();
          }
        }}
      />
    </label>
  );
}

function CustomFieldIframeEditor(props: FieldEditorRenderProps): ReactElement {
  const iframe = useRef<HTMLIFrameElement>(null);
  const extension = props.field.extension;
  useEffect(() => {
    if (extension === undefined) return;
    let sourceOrigin: string;
    try {
      sourceOrigin = new URL(extension.src).origin;
    } catch {
      return;
    }
    if (sourceOrigin !== extension.origin || extension.origin === "*") return;
    const channel = new MessageChannel();
    const receive = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== "object" || event.data === null) return;
      const message = event.data as Readonly<Record<string, unknown>>;
      if (message.type === "cms.field.change" && "value" in message && !props.disabled) {
        props.onChange(message.value);
      }
    };
    channel.port1.addEventListener("message", receive);
    channel.port1.start();
    const connect = (): void => {
      iframe.current?.contentWindow?.postMessage(
        {
          type: "cms.field.init",
          field: props.field,
          value: props.value,
          disabled: props.disabled,
        },
        extension.origin,
        [channel.port2],
      );
    };
    iframe.current?.addEventListener("load", connect);
    connect();
    return () => {
      iframe.current?.removeEventListener("load", connect);
      channel.port1.removeEventListener("message", receive);
      channel.port1.close();
    };
  }, [extension, props.disabled, props.field, props.onChange, props.value]);
  if (extension === undefined) {
    return <JsonFieldEditor {...props} />;
  }
  const valid = (() => {
    try {
      return new URL(extension.src).origin === extension.origin && extension.origin !== "*";
    } catch {
      return false;
    }
  })();
  if (!valid) {
    return <p role="alert">The custom field extension has an invalid or unsafe origin.</p>;
  }
  return (
    <section className="cms-custom-field">
      <strong>{props.field.label}</strong>
      <iframe
        ref={iframe}
        src={extension.src}
        title={extension.title ?? `${props.field.label} field editor`}
        sandbox="allow-scripts"
      />
    </section>
  );
}

const BUILT_IN_RENDERERS = new Map<string, FieldEditorRenderer>([
  ["text", TextFieldEditor],
  ["slug", TextFieldEditor],
  ["rich-text", PortableRichTextField],
  ["number", NumberFieldEditor],
  ["boolean", BooleanFieldEditor],
  ["select", SelectFieldEditor],
  ["date", TemporalFieldEditor],
  ["datetime", TemporalFieldEditor],
  ["link", LinkFieldEditor],
  ["asset", AssetFieldEditor],
  ["reference", ReferenceFieldEditor],
  ["object", ObjectFieldEditor],
  ["list", ListFieldEditor],
  ["blocks", BlocksFieldEditor],
  ["json", JsonFieldEditor],
  ["custom", CustomFieldIframeEditor],
]);

export function createEditorFieldRegistry(
  extensions: Readonly<Record<string, FieldEditorRenderer>> = {},
): EditorFieldRegistry {
  return {
    renderers: new Map([...BUILT_IN_RENDERERS, ...Object.entries(extensions)]),
  };
}

export const defaultEditorFieldRegistry = createEditorFieldRegistry();

export function SchemaFieldEditor(
  props: Omit<FieldEditorRenderProps, "registry"> & {
    readonly registry?: EditorFieldRegistry;
  },
): ReactElement {
  const registry = props.registry ?? defaultEditorFieldRegistry;
  const renderer =
    registry.renderers.get(props.field.kind) ??
    (props.field.extension === undefined ? JsonFieldEditor : CustomFieldIframeEditor);
  return createElement(renderer, { ...props, registry });
}
