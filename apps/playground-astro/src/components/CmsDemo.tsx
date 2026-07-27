import type { Revision } from "@git-native-cms/core";
import { EditorApp } from "@git-native-cms/editor";
import { change, document } from "../cms-fixture";

export function CmsDemo() {
  return (
    <EditorApp
      change={change}
      document={document}
      previewUrl="/__cms/preview"
      onSave={async ({ expectedRevision, patches }) => {
        const response = await fetch(`/api/cms/changes/${change.id}/documents/${document.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": globalThis.crypto.randomUUID(),
            "x-csrf-token": "sandbox",
          },
          body: JSON.stringify({ expectedRevision, patches }),
        });
        if (!response.ok) throw new Error("Save failed.");
        const result = (await response.json()) as {
          readonly payload: { readonly document: { readonly revision: Revision } };
        };
        return result.payload.document.revision;
      }}
    />
  );
}
