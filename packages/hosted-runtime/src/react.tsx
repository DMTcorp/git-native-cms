"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  CmsOverviewApp,
  DashboardApp,
  EditorApp,
  type EditorBlockManifest,
  type EditorFieldManifest,
  type EditorSectionTemplate,
} from "@git-native-cms/editor";
import { createPreviewBridge } from "@git-native-cms/editor-bridge";
import type { Revision } from "@git-native-cms/core";
import { CMS_ACTIONS } from "@git-native-cms/permissions";
import {
  CmsPageRenderer,
  type CmsPageDocument,
  type ReactRegistry,
  type RenderContentDocument,
} from "@git-native-cms/react";
import type { FieldDefinition } from "@git-native-cms/schema";
import type { HostedEditorState } from "./index.js";
import {
  addHostedReviewComment,
  addHostedTeamMember,
  assignHostedReviewers,
  advanceHostedWorkflow,
  createHostedChange,
  createHostedDocument,
  createHostedTranslationJob,
  deleteHostedAsset,
  deleteHostedDocument,
  findHostedUsages,
  findHostedAssetUsages,
  importHostedTranslation,
  inviteHostedTeamMember,
  lockHostedStaging,
  publishHostedStaging,
  readHostedTranslationJob,
  removeHostedChangeFromStaging,
  requestHostedChanges,
  resolveHostedChangeConflicts,
  resolveHostedReviewComment,
  rollbackHostedRelease,
  scheduleHostedContent,
  updateHostedAsset,
  updateHostedTeamRoleMappings,
  unlockHostedStaging,
  uploadHostedAsset,
} from "./client.js";

function TeamManagementApp(props: {
  readonly state: Extract<HostedEditorState, { readonly view: "team" }>;
}): ReactElement {
  const { state } = props;
  const [email, setEmail] = useState("");
  const [organizationRole, setOrganizationRole] = useState<"direct_member" | "admin">(
    "direct_member",
  );
  const [username, setUsername] = useState("");
  const [teamSlug, setTeamSlug] = useState(state.teams[0]?.slug ?? "");
  const [teamRole, setTeamRole] = useState<"member" | "maintainer">("member");
  const [mappings, setMappings] = useState<Record<string, string>>(() =>
    Object.fromEntries(state.teams.map((team) => [team.slug, "editor"])),
  );
  const [customRoles, setCustomRoles] = useState<
    readonly {
      readonly name: string;
      readonly actions: readonly string[];
    }[]
  >(() =>
    state.customRoles.map((role) => ({
      name: String(role.name),
      actions: [...role.actions],
    })),
  );
  const [customRoleName, setCustomRoleName] = useState("");
  const [operation, setOperation] = useState<"idle" | "working" | "complete" | "error">("idle");
  const [note, setNote] = useState<string | undefined>();
  const builtInRoles = [
    "viewer",
    "author",
    "editor",
    "translator",
    "reviewer",
    "publisher",
    "developer",
    "administrator",
  ] as const;

  const execute = async (operation_: () => Promise<void>, success: string): Promise<void> => {
    setOperation("working");
    setNote(undefined);
    try {
      await operation_();
      setOperation("complete");
      setNote(success);
    } catch (error) {
      setOperation("error");
      setNote(error instanceof Error ? error.message : "The team operation failed.");
    }
  };

  return (
    <main className="cms-app cms-team-page">
      <header className="cms-team-page__header">
        <div>
          <span className="cms-login__eyebrow">GitHub organization directory</span>
          <h1>Team & permissions</h1>
          <p>
            Membership stays in GitHub. CMS roles are reviewed through an auditable permissions PR.
          </p>
        </div>
        <a href="/cms">Back to Changes</a>
      </header>
      {note !== undefined && (
        <p
          role={operation === "error" ? "alert" : "status"}
          className={`cms-team-note is-${operation}`}
        >
          {note}
        </p>
      )}
      <div className="cms-team-page__grid">
        <section>
          <h2>Organization members</h2>
          <ul className="cms-team-members">
            {state.members.map((member) => (
              <li key={member.id}>
                {member.avatarUrl !== undefined && <img src={member.avatarUrl} alt="" />}
                <div>
                  <strong>{member.displayName}</strong>
                  <small>
                    @{member.login} · {member.organizationRole}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Invite to GitHub</h2>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </label>
          <label>
            Organization role
            <select
              value={organizationRole}
              onChange={(event) =>
                setOrganizationRole(event.currentTarget.value as "direct_member" | "admin")
              }
            >
              <option value="direct_member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <button
            type="button"
            disabled={operation === "working" || email.trim().length < 3}
            onClick={() =>
              void execute(async () => {
                const invitation = await inviteHostedTeamMember({
                  email: email.trim(),
                  role: organizationRole,
                  csrfToken: state.csrfToken,
                });
                setEmail("");
                setNote(`GitHub invitation ${invitation.id} is pending.`);
              }, "GitHub invitation created.")
            }
          >
            Send invitation
          </button>
        </section>
        <section>
          <h2>Add existing member to team</h2>
          <label>
            GitHub username
            <input value={username} onChange={(event) => setUsername(event.currentTarget.value)} />
          </label>
          <label>
            Team
            <select value={teamSlug} onChange={(event) => setTeamSlug(event.currentTarget.value)}>
              {state.teams.map((team) => (
                <option key={team.id} value={team.slug}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Team role
            <select
              value={teamRole}
              onChange={(event) =>
                setTeamRole(event.currentTarget.value as "member" | "maintainer")
              }
            >
              <option value="member">Member</option>
              <option value="maintainer">Maintainer</option>
            </select>
          </label>
          <button
            type="button"
            disabled={
              operation === "working" || username.trim().length === 0 || teamSlug.length === 0
            }
            onClick={() =>
              void execute(
                () =>
                  addHostedTeamMember({
                    teamSlug,
                    username: username.trim(),
                    role: teamRole,
                    csrfToken: state.csrfToken,
                  }),
                `@${username.trim()} was added to ${teamSlug}.`,
              )
            }
          >
            Add to team
          </button>
        </section>
        <section>
          <h2>CMS role mappings</h2>
          <p>Merging the generated pull request activates these mappings from Git.</p>
          <fieldset className="cms-team-custom-roles">
            <legend>Custom roles</legend>
            {customRoles.map((role) => (
              <details key={role.name}>
                <summary>
                  <strong>{role.name}</strong>
                  <span>{role.actions.length} actions</span>
                </summary>
                <div className="cms-team-custom-roles__actions">
                  {CMS_ACTIONS.map((action) => (
                    <label key={action}>
                      <input
                        type="checkbox"
                        checked={role.actions.includes(action)}
                        onChange={(event) =>
                          setCustomRoles((current) =>
                            current.map((candidate) =>
                              candidate.name !== role.name
                                ? candidate
                                : {
                                    ...candidate,
                                    actions: event.currentTarget.checked
                                      ? [...new Set([...candidate.actions, action])].sort()
                                      : candidate.actions.filter(
                                          (candidateAction) => candidateAction !== action,
                                        ),
                                  },
                            ),
                          )
                        }
                      />
                      {action}
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="cms-team-custom-roles__remove"
                  onClick={() => {
                    setCustomRoles((current) =>
                      current.filter((candidate) => candidate.name !== role.name),
                    );
                    setMappings((current) =>
                      Object.fromEntries(
                        Object.entries(current).map(([team, selectedRole]) => [
                          team,
                          selectedRole === role.name ? "editor" : selectedRole,
                        ]),
                      ),
                    );
                  }}
                >
                  Remove custom role
                </button>
              </details>
            ))}
            <div className="cms-team-custom-roles__new">
              <label>
                New custom role
                <input
                  value={customRoleName}
                  onChange={(event) => setCustomRoleName(event.currentTarget.value)}
                  placeholder="legal-reviewer"
                />
              </label>
              <button
                type="button"
                disabled={
                  !/^[a-z][a-z0-9-]{1,62}$/u.test(customRoleName) ||
                  customRoles.some((role) => role.name === customRoleName) ||
                  builtInRoles.includes(customRoleName as (typeof builtInRoles)[number])
                }
                onClick={() => {
                  setCustomRoles((current) => [
                    ...current,
                    { name: customRoleName, actions: ["project.read"] },
                  ]);
                  setCustomRoleName("");
                }}
              >
                Add custom role
              </button>
            </div>
          </fieldset>
          {state.teams.map((team) => (
            <label key={team.id}>
              {team.name}
              <select
                value={mappings[team.slug] ?? "editor"}
                onChange={(event) =>
                  setMappings((current) => ({
                    ...current,
                    [team.slug]: event.currentTarget.value,
                  }))
                }
              >
                {[...builtInRoles, ...customRoles.map((role) => role.name)].map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            type="button"
            disabled={operation === "working" || state.teams.length === 0}
            onClick={() =>
              void execute(async () => {
                const result = await updateHostedTeamRoleMappings({
                  mappings: state.teams.map((team) => ({
                    team: `${state.organization}/${team.slug}`,
                    roles: [mappings[team.slug] ?? "editor"],
                  })),
                  customRoles,
                  expectedRevision: state.mainRevision,
                  csrfToken: state.csrfToken,
                });
                window.location.assign(result.pullRequest.url);
              }, "Permissions pull request created.")
            }
          >
            Open permissions PR
          </button>
        </section>
      </div>
    </main>
  );
}

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

function editorFieldManifest(
  name: string,
  field: FieldDefinition,
  registry: ReactRegistry,
  depth = 0,
): EditorFieldManifest {
  const common = {
    name,
    kind: field.kind,
    label: field.label ?? name.replace(/([a-z])([A-Z])/gu, "$1 $2"),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.inline === undefined ? {} : { inline: field.inline }),
    ...(field.localized === undefined ? {} : { localized: field.localized }),
  };
  if (field.kind === "asset") {
    return { ...common, ...(field.accept === undefined ? {} : { accept: field.accept }) };
  }
  if (field.kind === "select") {
    return {
      ...common,
      options: field.options,
      ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
    };
  }
  if (field.kind === "reference") {
    return {
      ...common,
      collections: field.collections,
      ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
    };
  }
  if (field.kind === "link") {
    return {
      ...common,
      ...(field.allowedProtocols === undefined ? {} : { allowedProtocols: field.allowedProtocols }),
    };
  }
  if (field.kind === "object") {
    return {
      ...common,
      fields: Object.entries(field.fields).map(([nestedName, nested]) =>
        editorFieldManifest(nestedName, nested, registry, depth + 1),
      ),
    };
  }
  if (field.kind === "list") {
    return {
      ...common,
      of: editorFieldManifest("item", field.of, registry, depth + 1),
      ...(field.minItems === undefined ? {} : { minItems: field.minItems }),
      ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
    };
  }
  if (field.kind === "blocks") {
    const blocks: EditorBlockManifest[] =
      depth >= 2
        ? []
        : field.allowed.flatMap((type) => {
            const definition = registry.sections.get(type)?.definition;
            return definition === undefined
              ? []
              : [
                  {
                    type,
                    label: definition.label,
                    defaults: definition.defaults ?? {},
                    fields: Object.entries(definition.fields).map(([nestedName, nested]) =>
                      editorFieldManifest(nestedName, nested, registry, depth + 1),
                    ),
                  },
                ];
          });
    return { ...common, allowed: field.allowed, blocks };
  }
  return common;
}

function editorSectionTemplates(registry: ReactRegistry): readonly EditorSectionTemplate[] {
  return [...registry.sections.values()].map(({ definition }) => {
    const variant = Object.entries(definition.fields).find(
      ([name, field]) => name.toLocaleLowerCase().includes("variant") && field.kind === "select",
    );
    return {
      type: definition.name,
      label: definition.label,
      category: definition.category ?? "Sections",
      description: definition.description ?? `Add a ${definition.label} section.`,
      usageGuidance:
        definition.constraints?.recommendedPosition === "first"
          ? "Designed to introduce the page; place it before supporting sections."
          : definition.constraints?.recommendedPosition === "last"
            ? "Designed to close the page after the main content."
            : `Use this ${definition.category?.toLocaleLowerCase() ?? "content"} pattern where it supports the editorial flow.`,
      ...(variant === undefined || variant[1].kind !== "select"
        ? {}
        : { variantField: variant[0], variants: variant[1].options }),
      ...(definition.constraints === undefined ? {} : { constraints: definition.constraints }),
      defaults: definition.defaults ?? {},
      fields: Object.entries(definition.fields).map(([name, field]) =>
        editorFieldManifest(name, field, registry),
      ),
    };
  });
}

export function CmsHostedApp(props: {
  readonly state: HostedEditorState;
  readonly registry?: ReactRegistry;
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
  if (state.view === "team") {
    return <TeamManagementApp state={state} />;
  }
  if (
    state.view === "staging" ||
    state.view === "releases" ||
    state.view === "assets" ||
    state.view === "settings" ||
    state.view === "developer"
  ) {
    return (
      <CmsOverviewApp
        view={state.view}
        projectName={state.projectName}
        actorName={state.actor.displayName}
        changes={state.changes}
        releases={state.releases}
        pointers={state.pointers}
        assets={state.assets}
        stagingRevision={state.stagingRevision}
        {...(state.stagingLock === undefined ? {} : { stagingLock: state.stagingLock })}
        registryDigest={state.registryDigest}
        stagingUrl={state.stagingUrl}
        productionUrl={state.productionUrl}
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
        onLockStaging={({ expectedRevision, checklist }) =>
          lockHostedStaging({
            expectedRevision,
            checklist,
            csrfToken: state.csrfToken,
          })
        }
        onUnlockStaging={(expectedRevision) =>
          unlockHostedStaging({
            expectedRevision,
            csrfToken: state.csrfToken,
          })
        }
        onRemoveStagedChange={({ changeId, expectedRevision }) =>
          removeHostedChangeFromStaging({
            changeId,
            expectedRevision,
            csrfToken: state.csrfToken,
          })
        }
      />
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
        onCreateChange={({ name, description, baseBranch, collaborators, targetDate, emergency }) =>
          createHostedChange({
            name,
            ...(description === undefined ? {} : { description }),
            ...(baseBranch === undefined ? {} : { baseBranch }),
            ...(collaborators === undefined ? {} : { collaborators }),
            ...(targetDate === undefined ? {} : { targetDate }),
            ...(emergency === true ? { emergency: true } : {}),
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
  if (state.view !== "workspace") {
    throw new Error(`Unsupported hosted CMS view: ${String(state.view)}`);
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
      conflicts={state.conflicts}
      review={state.review}
      assets={assets}
      {...(props.registry === undefined
        ? {}
        : { sectionTemplates: editorSectionTemplates(props.registry) })}
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
            onAddReviewComment: (body: string, path?: string) =>
              addHostedReviewComment({
                changeId: change.id,
                pullRequestNumber: change.pullRequestNumber as number,
                body,
                ...(path === undefined ? {} : { path }),
                csrfToken,
              }),
            onResolveReviewComment: (input: {
              readonly commentId: string;
              readonly resolved: boolean;
            }) =>
              resolveHostedReviewComment({
                changeId: change.id,
                pullRequestNumber: change.pullRequestNumber as number,
                commentId: input.commentId,
                resolved: input.resolved,
                csrfToken,
              }),
            onAssignReviewers: (input: {
              readonly users: readonly string[];
              readonly teams: readonly string[];
            }) =>
              assignHostedReviewers({
                changeId: change.id,
                pullRequestNumber: change.pullRequestNumber as number,
                users: input.users,
                teams: input.teams,
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
      onResolveConflicts={async ({ expectedRevision, resolutions }) => {
        const result = await resolveHostedChangeConflicts({
          changeId: change.id,
          expectedRevision,
          resolutions,
          csrfToken,
        });
        queueMicrotask(() => window.location.reload());
        return result;
      }}
      onUploadAsset={({ file, expectedRevision }) =>
        uploadHostedAsset({
          changeId: change.id,
          file,
          expectedRevision,
          csrfToken,
        })
      }
      onUpdateAsset={({ assetId, altText, focalPoint, expectedRevision }) =>
        updateHostedAsset({
          changeId: change.id,
          assetId,
          altText,
          focalPoint,
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
      onFindAssetUsages={(assetId) => findHostedAssetUsages({ assetId })}
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
          ...(change.emergency === true ? { emergency: true } : {}),
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
