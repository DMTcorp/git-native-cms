import type { Revision } from "@git-native-cms/core";
import { EditorApp } from "@git-native-cms/editor";
import type { HostedEditorState } from "@git-native-cms/hosted-runtime";
import { advanceHostedWorkflow } from "@git-native-cms/hosted-runtime/client";

export function CmsDemo(props: { readonly state: HostedEditorState }) {
  if (!props.state.authenticated) {
    return (
      <main className="cms-app cms-login">
        <div className="cms-login__card">
          <span className="cms-login__eyebrow">Hosted sandbox</span>
          <h1>Open the real Git-backed editor.</h1>
          <p>
            Sign in with GitHub. The CMS creates an isolated Change branch in the public content
            repository and keeps credentials server-side.
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
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ expectedRevision, patches }),
        });
        if (!response.ok) throw new Error("Save failed.");
        const result = (await response.json()) as {
          readonly payload: { readonly document: { readonly revision: Revision } };
        };
        return result.payload.document.revision;
      }}
      onWorkflowAction={({ action, expectedRevision, pullRequestNumber }) =>
        advanceHostedWorkflow({
          action,
          changeId: change.id,
          changeName: change.name,
          csrfToken,
          expectedRevision,
          ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
        })
      }
    />
  );
}
