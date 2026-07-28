"use client";

import { useEffect, useMemo, useState, type ReactElement } from "react";
import type {
  Asset,
  EnvironmentPointer,
  StagingBatchLock,
  StoredRelease,
} from "@git-native-cms/application";
import type { Change, Revision } from "@git-native-cms/core";
import { Button, ChangeRail, StatusBadge } from "@git-native-cms/editor-ui";
import { formatCmsDate } from "./time.js";

export type CmsOverviewView = "staging" | "releases" | "assets" | "settings" | "developer";

export interface CmsOverviewAppProps {
  readonly view: CmsOverviewView;
  readonly projectName: string;
  readonly actorName: string;
  readonly changes: readonly Change[];
  readonly releases: readonly StoredRelease[];
  readonly pointers: readonly EnvironmentPointer[];
  readonly assets: readonly Asset[];
  readonly stagingRevision: Revision;
  readonly stagingLock?: StagingBatchLock;
  readonly registryDigest: string;
  readonly stagingUrl?: string;
  readonly productionUrl?: string;
  readonly onPublishStaging?: (expectedRevision: Revision) => Promise<void>;
  readonly onLockStaging?: (input: {
    readonly expectedRevision: Revision;
    readonly checklist: readonly string[];
  }) => Promise<Revision>;
  readonly onUnlockStaging?: (expectedRevision: Revision) => Promise<Revision>;
  readonly onRemoveStagedChange?: (input: {
    readonly changeId: string;
    readonly expectedRevision: Revision;
  }) => Promise<Revision>;
  readonly onRollback?: (input: {
    readonly releaseId: string;
    readonly expectedPointerRevision: string;
  }) => Promise<void>;
}

function Navigation(): ReactElement {
  return (
    <nav aria-label="CMS sections">
      <a href="/cms/changes">Changes</a>
      <a href="/cms/staging">Staging</a>
      <a href="/cms/releases">Releases</a>
      <a href="/cms/assets">Assets</a>
      <a href="/cms/team">Team</a>
      <a href="/cms/settings">Settings</a>
      <a href="/cms/developer">Developer</a>
    </nav>
  );
}

function Header(props: {
  readonly projectName: string;
  readonly actorName: string;
  readonly title: string;
  readonly description: string;
}): ReactElement {
  return (
    <header className="cms-dashboard__header">
      <div>
        <span className="cms-login__eyebrow">Git-native visual CMS</span>
        <h1>{props.title}</h1>
        <p>
          {props.description}{" "}
          <span className="cms-overview__actor">Signed in as {props.actorName}.</span>
        </p>
        <small>{props.projectName}</small>
      </div>
      <Navigation />
    </header>
  );
}

function StagingView(props: CmsOverviewAppProps): ReactElement {
  const staged = props.changes.filter((change) => change.status === "staging");
  const stagingPointer = props.pointers.find((pointer) => pointer.environment === "staging");
  const publishStaging = props.onPublishStaging;
  const [operation, setOperation] = useState<"idle" | "working" | "complete" | "error">("idle");
  const [currentRevision, setCurrentRevision] = useState(props.stagingRevision);
  const [checklist, setChecklist] = useState({
    routes: false,
    responsive: false,
    localization: false,
  });
  const [lockedRevision, setLockedRevision] = useState<Revision | undefined>(
    props.stagingLock === undefined ? undefined : props.stagingRevision,
  );
  const checklistComplete = Object.values(checklist).every(Boolean);
  const batchLocked = lockedRevision !== undefined;
  return (
    <>
      <Header
        projectName={props.projectName}
        actorName={props.actorName}
        title="Staging"
        description="Validate the complete release candidate before promoting it to Production."
      />
      <section className="cms-overview__panel" aria-labelledby="staging-title">
        <div className="cms-dashboard__section-heading">
          <div>
            <span>Release candidate</span>
            <h2 id="staging-title">Staged Changes</h2>
          </div>
          <StatusBadge tone="staging">{staged.length} staged</StatusBadge>
        </div>
        <ChangeRail current="staging" />
        {staged.length === 0 ? (
          <div className="cms-empty">
            <h2>Nothing is staged</h2>
            <p>Approved Changes appear here after they are added to Staging.</p>
          </div>
        ) : (
          <ul className="cms-change-list">
            {staged.map((change) => (
              <li key={change.id}>
                <a href={`/cms/changes/${encodeURIComponent(change.id)}`}>
                  <span className="cms-change-list__marker" aria-hidden="true" />
                  <span>
                    <strong>{change.name}</strong>
                    <small>{change.description ?? "No description"}</small>
                  </span>
                  <StatusBadge tone="staging">staging</StatusBadge>
                  <time dateTime={change.updatedAt}>{formatCmsDate(change.updatedAt)}</time>
                </a>
                {props.onRemoveStagedChange !== undefined && !batchLocked && (
                  <Button
                    tone="danger"
                    isDisabled={operation === "working"}
                    onPress={() => {
                      if (
                        !window.confirm(
                          `Remove ${change.name} from this release candidate using an auditable revert?`,
                        )
                      ) {
                        return;
                      }
                      setOperation("working");
                      void props
                        .onRemoveStagedChange?.({
                          changeId: change.id,
                          expectedRevision: currentRevision,
                        })
                        .then((revision) => {
                          if (revision === undefined) return;
                          setCurrentRevision(revision);
                          window.location.reload();
                        })
                        .catch(() => setOperation("error"));
                    }}
                  >
                    Remove before publish
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <dl className="cms-overview__facts">
          <div>
            <dt>Staging revision</dt>
            <dd>
              <code>{currentRevision}</code>
            </dd>
          </div>
          <div>
            <dt>Current release</dt>
            <dd>
              <code>{stagingPointer?.releaseId ?? "not published"}</code>
            </dd>
          </div>
        </dl>
        <section className="cms-staging-checklist" aria-labelledby="staging-checklist">
          <div>
            <h3 id="staging-checklist">Release test checklist</h3>
            {props.stagingUrl !== undefined && (
              <a href={props.stagingUrl} target="_blank" rel="noreferrer">
                Open staging website
              </a>
            )}
          </div>
          {(
            [
              ["routes", "Critical routes and redirects"],
              ["responsive", "Desktop, tablet and mobile presentation"],
              ["localization", "Locale, market and SEO metadata"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={checklist[key]}
                disabled={batchLocked}
                onChange={(event) =>
                  setChecklist((current) => ({ ...current, [key]: event.currentTarget.checked }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
          <div className="cms-staging-validation">
            <strong>Automated validation</strong>
            <ul>
              <li className={staged.length > 0 ? "is-passing" : "is-pending"}>
                At least one approved Change is included
              </li>
              <li
                className={props.registryDigest.startsWith("sha256:") ? "is-passing" : "is-pending"}
              >
                Component registry is pinned
              </li>
              <li className={stagingPointer !== undefined ? "is-passing" : "is-pending"}>
                Staging release pointer is available
              </li>
            </ul>
          </div>
          {batchLocked ? (
            <div className="cms-staging-lock is-locked">
              <span>
                <strong>Candidate locked</strong>
                <small>
                  Publication uses revision <code>{lockedRevision}</code>; a concurrent update is
                  rejected atomically.
                </small>
              </span>
              <Button
                isDisabled={operation === "working"}
                onPress={() => {
                  if (lockedRevision === undefined) return;
                  setOperation("working");
                  void (props.onUnlockStaging?.(lockedRevision) ?? Promise.resolve(lockedRevision))
                    .then(() => {
                      setLockedRevision(undefined);
                      setOperation("idle");
                    })
                    .catch(() => setOperation("error"));
                }}
              >
                Unlock checklist
              </Button>
            </div>
          ) : (
            <Button
              isDisabled={!checklistComplete || staged.length === 0 || operation === "working"}
              onPress={() => {
                const completed = Object.entries(checklist)
                  .filter(([, value]) => value)
                  .map(([key]) => key);
                setOperation("working");
                void (
                  props.onLockStaging?.({
                    expectedRevision: currentRevision,
                    checklist: completed,
                  }) ?? Promise.resolve(currentRevision)
                )
                  .then((revision) => {
                    setLockedRevision(revision);
                    setOperation("idle");
                  })
                  .catch(() => setOperation("error"));
              }}
            >
              Lock tested candidate
            </Button>
          )}
        </section>
        {staged.length > 0 && publishStaging !== undefined && (
          <Button
            tone="primary"
            isDisabled={operation === "working" || !batchLocked}
            onPress={() => {
              if (
                !window.confirm(`Publish ${String(staged.length)} staged Change(s) to Production?`)
              ) {
                return;
              }
              setOperation("working");
              void publishStaging(lockedRevision ?? currentRevision)
                .then(() => setOperation("complete"))
                .catch(() => setOperation("error"));
            }}
          >
            {operation === "working" ? "Publishing…" : "Publish to Production"}
          </Button>
        )}
        {operation === "complete" && <p role="status">Production was published atomically.</p>}
        {operation === "error" && <p role="alert">The release could not be published.</p>}
      </section>
    </>
  );
}

function ReleasesView(props: CmsOverviewAppProps): ReactElement {
  const production = props.pointers.find((pointer) => pointer.environment === "production");
  const rollback = props.onRollback;
  const [operation, setOperation] = useState<"idle" | "working" | "complete" | "error">("idle");
  const [compareFrom, setCompareFrom] = useState(props.releases[1]?.id ?? props.releases[0]?.id);
  const [compareTo, setCompareTo] = useState(props.releases[0]?.id);
  const from = props.releases.find((release) => release.id === compareFrom);
  const to = props.releases.find((release) => release.id === compareTo);
  const changedFiles =
    from === undefined || to === undefined
      ? []
      : [...new Set([...Object.keys(from.files), ...Object.keys(to.files)])]
          .filter((path) => from.files[path] !== to.files[path])
          .sort();
  return (
    <>
      <Header
        projectName={props.projectName}
        actorName={props.actorName}
        title="Releases"
        description="Inspect immutable artifacts and atomically restore a previous Production pointer."
      />
      <section className="cms-overview__panel" aria-labelledby="releases-title">
        <div className="cms-dashboard__section-heading">
          <div>
            <span>Immutable delivery</span>
            <h2 id="releases-title">Release timeline</h2>
          </div>
          <StatusBadge tone="live">{props.releases.length} releases</StatusBadge>
        </div>
        {props.releases.length === 0 ? (
          <div className="cms-empty">
            <h2>No releases yet</h2>
            <p>Publishing Staging creates the first immutable release.</p>
          </div>
        ) : (
          <ol className="cms-overview__release-list">
            {props.releases.map((release) => {
              const environments = props.pointers
                .filter((pointer) => pointer.releaseId === release.id)
                .map((pointer) => pointer.environment);
              return (
                <li key={release.id}>
                  <div>
                    <strong>{release.id}</strong>
                    <small>
                      {Object.keys(release.files).length} files ·{" "}
                      {environments.join(" · ") || "immutable"}
                    </small>
                    <dl>
                      <div>
                        <dt>Source revision</dt>
                        <dd>
                          <code>
                            {typeof release.manifest.gitCommit === "string"
                              ? release.manifest.gitCommit
                              : "unknown"}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>Routes and tags</dt>
                        <dd>
                          {Array.isArray(release.manifest.tags)
                            ? release.manifest.tags.join(" · ") || "No route tags"
                            : "No route tags"}
                        </dd>
                      </div>
                      <div>
                        <dt>Delivery</dt>
                        <dd>
                          Storage verified ·{" "}
                          {environments.length > 0
                            ? `active on ${environments.join(" and ")}`
                            : "not selected by a pointer"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <a
                    className="cms-button"
                    download={`${release.id}.manifest.json`}
                    href={`data:application/json;charset=utf-8,${encodeURIComponent(
                      JSON.stringify(release.manifest, null, 2),
                    )}`}
                  >
                    Download manifest
                  </a>
                  {production !== undefined &&
                    production.releaseId !== release.id &&
                    rollback !== undefined && (
                      <Button
                        tone="danger"
                        isDisabled={operation === "working"}
                        onPress={() => {
                          if (!window.confirm(`Restore Production to ${release.id}?`)) return;
                          setOperation("working");
                          void rollback({
                            releaseId: release.id,
                            expectedPointerRevision: production.revision,
                          })
                            .then(() => setOperation("complete"))
                            .catch(() => setOperation("error"));
                        }}
                      >
                        Restore
                      </Button>
                    )}
                </li>
              );
            })}
          </ol>
        )}
        {props.releases.length > 1 && (
          <section className="cms-release-compare" aria-labelledby="release-compare-title">
            <h3 id="release-compare-title">Compare releases</h3>
            <div>
              <label>
                From
                <select
                  value={compareFrom}
                  onChange={(event) =>
                    setCompareFrom(event.currentTarget.value as StoredRelease["id"])
                  }
                >
                  {props.releases.map((release) => (
                    <option key={release.id} value={release.id}>
                      {release.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                To
                <select
                  value={compareTo}
                  onChange={(event) =>
                    setCompareTo(event.currentTarget.value as StoredRelease["id"])
                  }
                >
                  {props.releases.map((release) => (
                    <option key={release.id} value={release.id}>
                      {release.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {changedFiles.length === 0 ? (
              <p>The selected releases contain identical artifacts.</p>
            ) : (
              <ul>
                {changedFiles.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {operation === "complete" && <p role="status">The Production pointer was restored.</p>}
        {operation === "error" && <p role="alert">Production could not be restored.</p>}
      </section>
    </>
  );
}

function AssetsView(props: CmsOverviewAppProps): ReactElement {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? props.assets
      : props.assets.filter((asset) =>
          `${asset.fileName} ${asset.mimeType} ${asset.altText ?? ""}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
  }, [props.assets, query]);
  return (
    <>
      <Header
        projectName={props.projectName}
        actorName={props.actorName}
        title="Assets"
        description="Browse files stored independently from Git content and immutable releases."
      />
      <section className="cms-overview__panel" aria-labelledby="assets-title">
        <div className="cms-dashboard__section-heading">
          <div>
            <span>Storage library</span>
            <h2 id="assets-title">Asset gallery</h2>
          </div>
          <StatusBadge tone="draft">{props.assets.length} assets</StatusBadge>
        </div>
        <label className="cms-overview__search">
          <span>Search assets</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="File name, type or alt text"
          />
        </label>
        {filtered.length === 0 ? (
          <div className="cms-empty">
            <h2>No matching assets</h2>
            <p>Upload an asset from a Change so its metadata and usage are reviewed together.</p>
          </div>
        ) : (
          <ul className="cms-overview__asset-grid">
            {filtered.map((asset) => (
              <li key={asset.id}>
                <div className="cms-overview__asset-preview">
                  {asset.mimeType.startsWith("image/") ? (
                    <img src={asset.url} alt={asset.altText ?? ""} loading="lazy" />
                  ) : (
                    <span aria-hidden="true">
                      {asset.mimeType.split("/")[1]?.toUpperCase() ?? "FILE"}
                    </span>
                  )}
                </div>
                <strong>{asset.fileName}</strong>
                <small>
                  {asset.mimeType} ·{" "}
                  {new Intl.NumberFormat("en", { notation: "compact" }).format(asset.size)} B
                </small>
                <small>{asset.altText ?? "Alt text not set"}</small>
                <code>{asset.checksum.slice(0, 16)}…</code>
              </li>
            ))}
          </ul>
        )}
        <p className="cms-overview__hint">
          Open a Change to upload files, edit metadata, select assets in fields, inspect usages or
          safely delete unreferenced objects.
        </p>
      </section>
    </>
  );
}

function SettingsView(props: CmsOverviewAppProps): ReactElement {
  const production = props.pointers.find((pointer) => pointer.environment === "production");
  const staging = props.pointers.find((pointer) => pointer.environment === "staging");
  return (
    <>
      <Header
        projectName={props.projectName}
        actorName={props.actorName}
        title="Settings"
        description="Review the Git-backed project configuration and delivery environments."
      />
      <section className="cms-overview__panel" aria-labelledby="settings-title">
        <h2 id="settings-title">Project configuration</h2>
        <dl className="cms-overview__facts">
          <div>
            <dt>Registry digest</dt>
            <dd>
              <code>{props.registryDigest}</code>
            </dd>
          </div>
          <div>
            <dt>Staging pointer</dt>
            <dd>
              <code>{staging?.releaseId ?? "not published"}</code>
            </dd>
          </div>
          <div>
            <dt>Production pointer</dt>
            <dd>
              <code>{production?.releaseId ?? "not published"}</code>
            </dd>
          </div>
          <div>
            <dt>Content model</dt>
            <dd>
              Managed in <code>cms.config.ts</code> and reviewed through Git.
            </dd>
          </div>
        </dl>
        <p>
          Team membership and CMS roles are managed in{" "}
          <a href="/cms/team">Team &amp; permissions</a>. Scheduling, locale, SEO and redirects are
          edited inside a Change so they follow the same review workflow.
        </p>
      </section>
    </>
  );
}

function DeveloperView(props: CmsOverviewAppProps): ReactElement {
  return (
    <>
      <Header
        projectName={props.projectName}
        actorName={props.actorName}
        title="Developer"
        description="Technical identifiers for diagnostics, adapters and deployment verification."
      />
      <section className="cms-overview__panel" aria-labelledby="developer-title">
        <h2 id="developer-title">Runtime diagnostics</h2>
        <dl className="cms-overview__facts">
          <div>
            <dt>Registry digest</dt>
            <dd>
              <code>{props.registryDigest}</code>
            </dd>
          </div>
          <div>
            <dt>Staging revision</dt>
            <dd>
              <code>{props.stagingRevision}</code>
            </dd>
          </div>
          <div>
            <dt>Assets</dt>
            <dd>{props.assets.length}</dd>
          </div>
          <div>
            <dt>Immutable releases</dt>
            <dd>{props.releases.length}</dd>
          </div>
        </dl>
        <p>
          Run <code>cms doctor --live</code> locally for credentials, GitHub App, R2 and deployment
          checks. Secrets are intentionally never exposed in this browser view.
        </p>
      </section>
    </>
  );
}

export function CmsOverviewApp(props: CmsOverviewAppProps): ReactElement {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return (
    <main
      className={`cms-app cms-dashboard cms-overview cms-overview--${props.view}`}
      data-cms-hydrated={hydrated}
    >
      {props.view === "staging" ? (
        <StagingView {...props} />
      ) : props.view === "releases" ? (
        <ReleasesView {...props} />
      ) : props.view === "assets" ? (
        <AssetsView {...props} />
      ) : props.view === "settings" ? (
        <SettingsView {...props} />
      ) : (
        <DeveloperView {...props} />
      )}
    </main>
  );
}
