/// <reference lib="webworker" />

import { semanticDiff } from "@git-native-cms/diff";
import type { EditorWorkerRequest, EditorWorkerResult } from "./worker.js";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function validate(documents: readonly unknown[]): readonly {
  readonly index: number;
  readonly message: string;
}[] {
  return documents.flatMap((value, index) => {
    const document = record(value);
    if (document === undefined) return [{ index, message: "Document must be an object." }];
    const issues: { readonly index: number; readonly message: string }[] = [];
    if (typeof document.id !== "string")
      issues.push({ index, message: "Document ID is required." });
    if (typeof document.type !== "string")
      issues.push({ index, message: "Document type is required." });
    return issues;
  });
}

function index(documents: readonly unknown[]): readonly {
  readonly id: string;
  readonly text: string;
}[] {
  return documents.flatMap((value) => {
    const document = record(value);
    if (document === undefined || typeof document.id !== "string") return [];
    return [
      {
        id: document.id,
        text: JSON.stringify(document).normalize("NFKC").toLocaleLowerCase("en-US"),
      },
    ];
  });
}

self.addEventListener("message", (event: MessageEvent<EditorWorkerRequest>) => {
  const request = event.data;
  let result: EditorWorkerResult;
  try {
    if (request.type === "semantic-diff") {
      result = {
        id: request.id,
        type: "semantic-diff",
        changes: semanticDiff(request.before, request.after),
      };
    } else if (request.type === "validate") {
      result = { id: request.id, type: "validate", issues: validate(request.documents) };
    } else {
      result = { id: request.id, type: "index", entries: index(request.documents) };
    }
  } catch (cause) {
    result = {
      id: request.id,
      type: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  self.postMessage(result);
});
