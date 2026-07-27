"use client";

import type { HostedEditorState } from "@git-native-cms/hosted-runtime";
import type { Revision } from "@git-native-cms/core";
import { CmsEditorPage } from "@git-native-cms/next/editor";

export function CmsDemo(props: { readonly state: HostedEditorState }) {
  if (!props.state.authenticated) {
    return (
      <main className="cms-app cms-login">
        <div className="cms-login__card">
          <span className="cms-login__eyebrow">Hosted sandbox</span>
          <h1>Open the real Git-backed editor.</h1>
          <p>
            Sign in with GitHub. The CMS will create your own Change branch in the public sandbox
            content repository; no personal repository access is requested.
          </p>
          <a className="cms-login__action" href={props.state.loginUrl}>
            Continue with GitHub
          </a>
          <small>{props.state.projectName}</small>
        </div>
      </main>
    );
  }
  const { change, document, csrfToken } = props.state;
  return (
    <CmsEditorPage
      change={change}
      document={document}
      previewUrl="/__cms/preview"
      onSave={async ({ expectedRevision, patches }) => {
        const response = await fetch(`/api/cms/changes/${change.id}/documents/${document.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": globalThis.crypto.randomUUID(),
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            expectedRevision,
            patches,
            idempotencyKey: globalThis.crypto.randomUUID(),
          }),
        });
        if (!response.ok) throw new Error("Save failed.");
        const envelope = (await response.json()) as {
          readonly payload: { readonly document: { readonly revision: Revision } };
        };
        return envelope.payload.document.revision;
      }}
    />
  );
}
