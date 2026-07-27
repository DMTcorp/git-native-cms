"use client";

import type { Revision } from "@git-native-cms/core";
import { CmsEditorPage } from "@git-native-cms/next/editor";
import { sandboxChange, sandboxDocument } from "../cms.fixture";

export function CmsDemo() {
  return (
    <CmsEditorPage
      change={sandboxChange}
      document={sandboxDocument}
      previewUrl="/__cms/preview"
      onSave={async ({ expectedRevision, patches }) => {
        const response = await fetch(
          `/api/cms/changes/${sandboxChange.id}/documents/${sandboxDocument.id}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "idempotency-key": globalThis.crypto.randomUUID(),
              "x-csrf-token": "sandbox",
            },
            body: JSON.stringify({
              expectedRevision,
              patches,
              idempotencyKey: globalThis.crypto.randomUUID(),
            }),
          },
        );
        if (!response.ok) throw new Error("Save failed.");
        const envelope = (await response.json()) as {
          readonly payload: { readonly document: { readonly revision: Revision } };
        };
        return envelope.payload.document.revision;
      }}
    />
  );
}
