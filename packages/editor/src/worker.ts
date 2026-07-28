import { semanticDiff, type SemanticChange } from "@git-native-cms/diff";

export type EditorWorkerRequest =
  | {
      readonly id: string;
      readonly type: "semantic-diff";
      readonly before: unknown;
      readonly after: unknown;
    }
  | {
      readonly id: string;
      readonly type: "validate";
      readonly documents: readonly unknown[];
    }
  | {
      readonly id: string;
      readonly type: "index";
      readonly documents: readonly unknown[];
    };

export type EditorWorkerResult =
  | {
      readonly id: string;
      readonly type: "semantic-diff";
      readonly changes: readonly SemanticChange[];
    }
  | {
      readonly id: string;
      readonly type: "validate";
      readonly issues: readonly { readonly index: number; readonly message: string }[];
    }
  | {
      readonly id: string;
      readonly type: "index";
      readonly entries: readonly { readonly id: string; readonly text: string }[];
    }
  | { readonly id: string; readonly type: "error"; readonly message: string };

let sharedWorker: Worker | undefined;
const pending = new Map<
  string,
  {
    readonly resolve: (value: EditorWorkerResult) => void;
    readonly reject: (cause: unknown) => void;
  }
>();

function worker(): Worker | undefined {
  if (typeof Worker === "undefined") return undefined;
  if (sharedWorker !== undefined) return sharedWorker;
  sharedWorker = new Worker(new URL("./content-worker.js", import.meta.url), {
    type: "module",
    name: "git-native-cms-content",
  });
  sharedWorker.addEventListener("message", (event: MessageEvent<EditorWorkerResult>) => {
    const operation = pending.get(event.data.id);
    if (operation === undefined) return;
    pending.delete(event.data.id);
    if (event.data.type === "error") operation.reject(new Error(event.data.message));
    else operation.resolve(event.data);
  });
  sharedWorker.addEventListener("error", (event) => {
    for (const operation of pending.values()) operation.reject(event.error);
    pending.clear();
    sharedWorker?.terminate();
    sharedWorker = undefined;
  });
  return sharedWorker;
}

export async function semanticDiffInWorker(
  before: unknown,
  after: unknown,
): Promise<readonly SemanticChange[]> {
  const instance = worker();
  if (instance === undefined) return semanticDiff(before, after);
  const id = globalThis.crypto.randomUUID();
  const result = await new Promise<EditorWorkerResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    instance.postMessage({
      id,
      type: "semantic-diff",
      before,
      after,
    } satisfies EditorWorkerRequest);
  });
  return result.type === "semantic-diff" ? result.changes : semanticDiff(before, after);
}

export function terminateEditorWorker(): void {
  sharedWorker?.terminate();
  sharedWorker = undefined;
  pending.clear();
}
