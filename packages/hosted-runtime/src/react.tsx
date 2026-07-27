"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { DashboardApp, EditorApp } from "@git-native-cms/editor";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import type { Revision } from "@git-native-cms/core";
import {
  CmsPageRenderer,
  type CmsPageDocument,
  type ReactRegistry,
  type RenderContentDocument,
} from "@git-native-cms/react";
import type { HostedEditorState } from "./index.js";
import {
  addHostedReviewComment,
  advanceHostedWorkflow,
  createHostedChange,
  createHostedDocument,
  createHostedTranslationJob,
  deleteHostedAsset,
  deleteHostedDocument,
  findHostedUsages,
  importHostedTranslation,
  publishHostedStaging,
  readHostedTranslationJob,
  requestHostedChanges,
  rollbackHostedRelease,
  scheduleHostedContent,
  uploadHostedAsset,
} from "./client.js";

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "untitled"
  );
}

function initialData(type: string, title: string): Readonly<Record<string, unknown>> {
  const base = { title, slug: slug(title) };
  if (type === "pages") {
    return { ...base, route: { path: `/${slug(title)}` }, sections: [] };
  }
  if (type === "posts") {
    return { ...base, excerpt: "", publishedAt: new Date().toISOString(), sections: [] };
  }
  if (type === "navigation") return { ...base, items: [] };
  if (type === "pricing") return { ...base, plans: [] };
  if (type === "settings") return { ...base, siteName: title, defaultLocale: "en-US" };
  if (type === "reusable-blocks") return { ...base, sections: [] };
  return { ...base, description: "", locale: "en-US" };
}

export function CmsHostedApp(props: {
  readonly state: HostedEditorState;
  readonly previewUrl?: string;
  readonly productionUrl?: string;
}): ReactElement {
  const state = props.state;
  if (!state.authenticated) {
    return (
      <main className="cms-app cms-login">
        <div className="cms-login__card">
          <span className="cms-login__eyebrow">Git-backed workspace</span>
          <h1>Open the visual content editor.</h1>
          <p>
            Sign in with GitHub. Credentials stay server-side and every edit is recorded in an
            isolated Change.
          </p>
          <a className="cms-login__action" href={state.loginUrl}>
            Continue with GitHub
          </a>
          <small>{state.projectName}</small>
        </div>
      </main>
    );
  }
  if (state.view === "dashboard") {
    return (
      <DashboardApp
        projectName={state.projectName}
        actorName={state.actor.displayName}
        changes={state.changes}
        releases={state.releases}
        pointers={state.pointers}
        stagingRevision={state.stagingRevision}
        onCreateChange={({ name, description }) =>
          createHostedChange({
            name,
            ...(description === undefined ? {} : { description }),
            csrfToken: state.csrfToken,
          })
        }
        onRollback={({ releaseId, expectedPointerRevision }) =>
          rollbackHostedRelease({
            releaseId,
            expectedPointerRevision,
            csrfToken: state.csrfToken,
          })
        }
        onPublishStaging={(expectedStagingRevision) =>
          publishHostedStaging({
            expectedStagingRevision,
            csrfToken: state.csrfToken,
            registryDigest: state.registryDigest,
          })
        }
      />
    );
  }
  const { change, document, documents, assets, csrfToken } = state;
  return (
    <EditorApp
      change={change}
      document={document}
      contentDocuments={state.contentDocuments}
      previewDocument={state.previewDocument}
      documents={documents}
      {...(state.baseDocument === undefined ? {} : { baseDocument: state.baseDocument })}
      {...(state.productionDocument === undefined
        ? {}
        : { productionDocument: state.productionDocument })}
      review={state.review}
      assets={assets}
      previewUrl={props.previewUrl ?? "/__cms/preview"}
      {...(props.productionUrl === undefined ? {} : { productionUrl: props.productionUrl })}
      onNavigateDocument={(documentId) =>
        window.location.assign(
          `/cms/changes/${encodeURIComponent(change.id)}/documents/${encodeURIComponent(documentId)}`,
        )
      }
      onCreateDocument={async ({ type, title, expectedRevision }) => {
        const created = await createHostedDocument({
          changeId: change.id,
          type,
          data: initialData(type, title),
          expectedRevision,
          csrfToken,
        });
        return { id: created.id, revision: created.revision };
      }}
      onDeleteDocument={({ documentId, expectedRevision }) =>
        deleteHostedDocument({
          changeId: change.id,
          documentId,
          expectedRevision,
          csrfToken,
        })
      }
      {...(change.pullRequestNumber === undefined
        ? {}
        : {
            onAddReviewComment: (body: string) =>
              addHostedReviewComment({
                changeId: change.id,
                pullRequestNumber: change.pullRequestNumber as number,
                body,
                csrfToken,
              }),
            onRequestChanges: ({
              body,
              expectedRevision,
            }: {
              readonly body: string;
              readonly expectedRevision: Revision;
            }) =>
              requestHostedChanges({
                changeId: change.id,
                pullRequestNumber: change.pullRequestNumber as number,
                body,
                expectedRevision,
                csrfToken,
              }),
          })}
      onUploadAsset={({ file, expectedRevision }) =>
        uploadHostedAsset({
          changeId: change.id,
          file,
          expectedRevision,
          csrfToken,
        })
      }
      onDeleteAsset={({ assetId, expectedRevision }) =>
        deleteHostedAsset({
          changeId: change.id,
          assetId,
          expectedRevision,
          csrfToken,
        })
      }
      onImportTranslation={({ locale, xliff, expectedRevision }) =>
        importHostedTranslation({
          changeId: change.id,
          documentId: document.id,
          targetLocale: locale,
          xliff,
          expectedRevision,
          csrfToken,
        })
      }
      {...(state.translationProviderAvailable
        ? {
            onCreateTranslationJob: ({
              locale,
              expectedRevision,
            }: {
              readonly locale: string;
              readonly expectedRevision: Revision;
            }) =>
              createHostedTranslationJob({
                changeId: change.id,
                documentId: document.id,
                targetLocale: locale,
                expectedRevision,
                csrfToken,
              }),
            onReadTranslationJob: (jobId: string) =>
              readHostedTranslationJob({
                changeId: change.id,
                documentId: document.id,
                targetLocale: "pl-PL",
                jobId,
              }),
          }
        : {})}
      onSchedule={({ action, executeAt, expectedRevision }) =>
        scheduleHostedContent({
          changeId: change.id,
          documentIds: [document.id],
          action,
          executeAt,
          expectedRevision,
          csrfToken,
        })
      }
      onFindUsages={() =>
        findHostedUsages({
          changeId: change.id,
          referenceId: document.id,
        })
      }
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
      onWorkflowAction={({ action, expectedRevision, pullRequestNumber }) =>
        advanceHostedWorkflow({
          action,
          changeId: change.id,
          changeName: change.name,
          csrfToken,
          expectedRevision,
          registryDigest: state.registryDigest,
          ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
        })
      }
    />
  );
}

export function createCmsPreviewComponent(
  registry: ReactRegistry,
  initialDocument: CmsPageDocument = { id: "preview", sections: [] },
): () => ReactElement {
  return function CmsHostedPreview(): ReactElement {
    const [document, setDocument] = useState<CmsPageDocument>(initialDocument);
    const [content, setContent] = useState<readonly RenderContentDocument[]>([]);
    const documentRef = useRef(document);
    const contentRef = useRef(content);
    documentRef.current = document;
    contentRef.current = content;
    useEffect(() => {
      const query = new URLSearchParams(window.location.search);
      const sessionId = query.get("cmsSession");
      if (sessionId === null) return;
      const bridge = createPreviewBridge({
        parentOrigin: window.location.origin,
        sessionId,
        getDocument: () => documentRef.current,
        setDocument: (value) => setDocument(value as CmsPageDocument),
        getContent: () => contentRef.current,
        setContent: (value) => setContent(value as readonly RenderContentDocument[]),
      });
      return () => bridge.destroy();
    }, []);
    return <CmsPageRenderer document={document} registry={registry} content={content} preview />;
  };
}
