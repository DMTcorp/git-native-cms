# Git-native Visual CMS — kompletna specyfikacja implementacyjna

**Status dokumentu:** specyfikacja wykonawcza  
**Model produktu:** w 100% open source, self-hosted, bez osobnej aplikacji backendowej  
**Oficjalne integracje:** Next.js App Router i Astro  
**Źródło prawdy dla treści:** osobne repozytorium GitHub  
**Workflow:** `Change branch → staging → main → publication job → immutable JSON release → storage/CDN`  
**Główna grupa użytkowników:** nietechniczni redaktorzy, marketing, tłumacze, reviewerzy i publisherzy  
**Interfejs AI:** MCP, korzystający z tych samych commandów domenowych i tych samych uprawnień co UI

---

# 1. Cel produktu

Produkt jest wizualnym, Git-native CMS-em osadzanym bezpośrednio w aplikacji frontendowej. Nie jest osobnym SaaS-em ani osobnym panelem wymagającym dedykowanego backendu. Po instalacji dodaje do hostującego projektu:

- graficzny panel CMS pod `/cms`,
- route pełnego preview pod `/__cms/preview/*`,
- serwerowe API pod `/api/cms/*`,
- callbacki uwierzytelnienia GitHub App,
- endpoint webhooków GitHub,
- opcjonalny endpoint MCP,
- adapter publikacji treści do storage/CDN,
- integrację z komponentami i sekcjami zdefiniowanymi w tym samym repozytorium frontendu.

CMS ma umożliwiać:

1. budowanie dowolnych stron z zarejestrowanych sekcji;
2. edycję inline oraz w inspectorze;
3. zarządzanie Pages, Posts i dowolnymi Collections;
4. zarządzanie Globals, Settings, Reusable Blocks, SEO, i18n, redirectami i assetami;
5. pracę zespołową przez logiczne jednostki `Change`;
6. review, staging, publikację, scheduling i rollback;
7. obsługę nietechnicznych użytkowników bez eksponowania pojęć Git;
8. wykonywanie tych samych operacji przez MCP i agentów AI;
9. generowanie atomowych, immutable release’ów JSON dla globalnego CDN-u;
10. zachowanie pełnej historii, audytowalności oraz możliwości ręcznej pracy z repozytorium.

---

# 2. Zasady architektoniczne

## 2.1. Brak osobnego backendu

Nie powstaje osobna aplikacja typu NestJS, Fastify albo Express wdrażana niezależnie od frontendu.

Operacje uprzywilejowane działają poprzez możliwości serwerowe hostującego frameworka:

- Next.js Route Handlers, server-only modules, cookies i middleware;
- Astro endpoints, middleware, actions/integrations oraz server adapter;
- wspólny handler oparty na standardowych `Request` i `Response`.

Warstwa serwerowa jest częścią SDK i zostaje zamontowana w projekcie użytkownika za pomocą cienkiego route’u.

## 2.2. Core framework-agnostic

Żaden moduł domenowy nie może importować:

- `next/*`,
- `astro`,
- Reacta,
- DOM-u,
- Node-specific API, jeśli nie znajduje się w dedykowanym adapterze.

Core musi działać w:

- Node.js,
- Bun,
- przeglądarce,
- workerze,
- testach bez frameworka.

## 2.3. Ports and adapters

Każda integracja zewnętrzna jest portem z adapterem:

- Git provider;
- framework server adapter;
- content repository;
- asset storage;
- release storage;
- CDN invalidation;
- image processing;
- authentication;
- session store;
- scheduler;
- translation provider;
- webhook destination;
- renderer.

Domena nie może wywoływać Octokita, Next.js albo S3 bezpośrednio.

## 2.4. Command-based domain

UI, HTTP API, CLI, GitHub Actions i MCP mają używać tych samych commandów domenowych:

```ts
createChange(...)
updateDocument(...)
submitChange(...)
addChangeToStaging(...)
publishStaging(...)
rollbackRelease(...)
```

Nie wolno implementować osobnej logiki biznesowej w:

- komponentach React,
- route handlerach,
- toolach MCP,
- workflow GitHub Actions.

Każdy transport jedynie:

1. parsuje input;
2. buduje actor/context;
3. uruchamia command;
4. mapuje wynik na transportowy response.

## 2.5. Explicit schemas, no magic discovery

Sekcje i content types są jawnie rejestrowane. CLI może automatycznie odnajdywać pliki według konwencji, lecz nie może analizować dowolnych komponentów i zgadywać ich znaczenia.

## 2.6. Zero CMS runtime na publicznych stronach

Standardowy użytkownik publicznej strony nie pobiera kodu edytora ani preview bridge.

- renderer produkcyjny może działać na serwerze lub podczas buildu;
- klientowy bridge jest ładowany tylko w trybie preview;
- bundle `/cms` jest oddzielnym entrypointem i osobnym chunkiem.

## 2.7. Git jako durable content store

Git przechowuje:

- content,
- konfigurację projektu,
- branche zmian,
- review PR,
- historię commitów,
- definicję stagingu i main,
- metadata Change,
- publication manifests,
- migracje i schema lock.

IndexedDB przechowuje tylko stan tymczasowy:

- niezsynchronizowane patche,
- undo/redo,
- recovery snapshot,
- preferencje UI.

Object storage przechowuje:

- assety,
- przetworzone warianty,
- preview release’y,
- staging release’y,
- production release’y.

## 2.8. Nie używać nazw Git w podstawowym UI

Mapowanie:

| UI CMS          | Implementacja Git           |
| --------------- | --------------------------- |
| Change          | branch                      |
| Save version    | commit                      |
| Send for review | pull request                |
| Approve         | PR review                   |
| Add to staging  | merge do `staging`          |
| Publish         | merge `staging` do `main`   |
| Version         | commit/release              |
| Restore         | revert lub pointer rollback |

Tryb „Technical details” może pokazywać branch, SHA i link do GitHub.

---

# 3. Docelowa architektura systemu

```text
┌──────────────────────────────────────────────────────────────┐
│ Host frontend application                                    │
│                                                              │
│ Public website                                               │
│ /, /pricing, /blog/...                                       │
│                                                              │
│ CMS editor                                                   │
│ /cms/*                                                       │
│                                                              │
│ Preview renderer                                             │
│ /__cms/preview/*                                             │
│                                                              │
│ CMS server handler                                           │
│ /api/cms/*                                                   │
│                                                              │
│ MCP endpoint / local MCP transport                           │
│ /api/cms/mcp or cms mcp                                      │
└──────────────────────────────┬───────────────────────────────┘
                               │
                        framework adapter
                               │
┌──────────────────────────────▼───────────────────────────────┐
│ Application layer                                            │
│ commands, queries, policies, workflows, authorization        │
└───────────────┬──────────────────┬───────────────────────────┘
                │                  │
┌───────────────▼────────┐ ┌───────▼──────────────────────────┐
│ GitHub App adapter     │ │ Storage adapters                 │
│ identity, repos, PRs,  │ │ S3/R2/MinIO/local, CDN, assets   │
│ branches, commits      │ │ immutable releases               │
└───────────────┬────────┘ └───────┬──────────────────────────┘
                │                  │
┌───────────────▼────────┐ ┌───────▼──────────────────────────┐
│ Frontend repository   │ │ Content repository               │
│ components, schemas,  │ │ YAML/Markdown/JSON, changes,      │
│ renderer, manifests   │ │ staging, main                    │
└────────────────────────┘ └───────────────────────────────────┘
```

---

# 4. Monorepo projektu open-source

Zastosować `pnpm` workspaces i Turborepo. Repozytorium produktu:

```text
git-native-cms/
├── apps/
│   ├── docs/
│   ├── playground-next/
│   ├── playground-astro/
│   ├── example-next-enterprise/
│   ├── example-astro-static/
│   ├── visual-regression/
│   └── e2e-fixtures/
│
├── packages/
│   ├── core/
│   ├── schema/
│   ├── protocol/
│   ├── document-model/
│   ├── content-codecs/
│   ├── content-repository/
│   ├── application/
│   ├── permissions/
│   ├── git/
│   ├── github/
│   ├── auth/
│   ├── sessions/
│   ├── server/
│   ├── editor/
│   ├── editor-ui/
│   ├── editor-bridge/
│   ├── react/
│   ├── astro-renderer/
│   ├── next/
│   ├── astro/
│   ├── assets/
│   ├── image-pipeline/
│   ├── release-builder/
│   ├── delivery/
│   ├── seo/
│   ├── localization/
│   ├── search/
│   ├── diff/
│   ├── migrations/
│   ├── mcp/
│   ├── cli/
│   ├── testing/
│   ├── observability/
│   └── adapter-kit/
│
├── tooling/
│   ├── eslint-config/
│   ├── typescript-config/
│   ├── vitest-config/
│   ├── playwright-config/
│   ├── changesets-config/
│   └── scripts/
│
├── .changeset/
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── CODEOWNERS
│   ├── dependabot.yml
│   └── release.yml
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── eslint.config.mjs
├── prettier.config.mjs
├── vitest.workspace.ts
├── playwright.config.ts
├── CONTRIBUTING.md
├── ARCHITECTURE.md
├── SECURITY.md
├── GOVERNANCE.md
├── CODE_OF_CONDUCT.md
├── LICENSE
└── README.md
```

## 4.1. Reguły zależności między paczkami

Warstwy:

```text
schema / protocol / core
        ↓
document-model / codecs / permissions
        ↓
application
        ↓
git / github / assets / delivery / auth / sessions
        ↓
server / mcp / cli
        ↓
next / astro
        ↓
editor integrations
```

Niedozwolone:

- `core` importuje `application`;
- `application` importuje `next`, `astro`, `editor`;
- `editor-ui` importuje GitHub adapter;
- `next` zawiera reguły workflow;
- `mcp` bezpośrednio modyfikuje repo;
- `react` importuje Next.js.

Wymusić reguły ESLint `boundaries` oraz test architektury analizujący dependency graph.

---

# 5. Konwencje kodu

## 5.1. TypeScript

- strict mode;
- `noUncheckedIndexedAccess`;
- `exactOptionalPropertyTypes`;
- `noImplicitOverride`;
- `useUnknownInCatchVariables`;
- ESM;
- brak `any` poza jawnie udokumentowanymi boundary adapters;
- publiczne funkcje posiadają jawne typy zwrotne;
- błędy jako typed domain errors;
- wartości identyfikatorów jako branded types.

Przykład:

```ts
export type ChangeId = string & { readonly __brand: "ChangeId" };
export type DocumentId = string & { readonly __brand: "DocumentId" };
export type GitCommitSha = string & { readonly __brand: "GitCommitSha" };
```

## 5.2. Rozmiar modułów

Nie ustalać arbitralnego limitu linii, lecz wymusić jedną odpowiedzialność:

- komponent UI odpowiada za jedną powierzchnię;
- hook koordynuje jeden use case;
- command handler obsługuje jeden command;
- repository adapter obsługuje jeden port;
- mapper nie wykonuje I/O;
- walidator nie modyfikuje danych.

Każdy feature UI posiada osobny katalog:

```text
features/change-editor/
├── api/
├── components/
├── hooks/
├── model/
├── routes/
├── state/
├── tests/
└── index.ts
```

## 5.3. Public exports

Każda paczka ma jawne `exports` w `package.json`. Nie publikować przypadkowo wewnętrznych plików.

Przykład:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./server": "./dist/server.js",
    "./client": "./dist/client.js",
    "./editor": "./dist/editor.js",
    "./testing": "./dist/testing.js"
  }
}
```

## 5.4. Error model

```ts
interface CmsErrorShape {
  code: string;
  message: string;
  category:
    | "validation"
    | "authorization"
    | "authentication"
    | "conflict"
    | "git"
    | "storage"
    | "network"
    | "configuration"
    | "internal";
  retryable: boolean;
  context?: Record<string, unknown>;
  cause?: unknown;
}
```

Przykładowe kody:

```text
CMS_AUTH_001
CMS_PERMISSION_004
CMS_CHANGE_003
CMS_GIT_012
CMS_SCHEMA_017
CMS_PUBLISH_008
CMS_PREVIEW_005
CMS_STORAGE_009
```

UI mapuje kody na przyjazne komunikaty i instrukcje naprawy.

---

# 6. Paczki i ich odpowiedzialności

## 6.1. `@cms/schema`

Jedyny DSL do definiowania pól, sekcji, content types, globals i settings.

```text
packages/schema/src/
├── fields/
│   ├── text.ts
│   ├── rich-text.ts
│   ├── number.ts
│   ├── boolean.ts
│   ├── select.ts
│   ├── date.ts
│   ├── datetime.ts
│   ├── slug.ts
│   ├── link.ts
│   ├── asset.ts
│   ├── reference.ts
│   ├── object.ts
│   ├── list.ts
│   ├── blocks.ts
│   ├── json.ts
│   └── index.ts
├── definitions/
│   ├── define-section.ts
│   ├── define-collection.ts
│   ├── define-page-type.ts
│   ├── define-post-type.ts
│   ├── define-global.ts
│   ├── define-settings.ts
│   ├── define-template.ts
│   └── define-workflow.ts
├── compiler/
│   ├── schema-ast.ts
│   ├── compile-json-schema.ts
│   ├── compile-editor-manifest.ts
│   └── compile-types.ts
├── validation/
├── migrations/
└── index.ts
```

API:

```ts
const hero = defineSection({
  name: "hero",
  version: 1,
  label: "Hero",
  category: "Heroes",
  description: "Primary page introduction.",
  fields: {
    heading: fields.text({
      required: true,
      localized: true,
      inline: true,
      maxLength: 90,
    }),
    description: fields.richText({
      localized: true,
      inline: true,
      allowedNodes: ["paragraph", "link", "strong"],
    }),
    image: fields.asset({
      accept: ["image/*"],
      aspectRatio: [4, 3],
    }),
    variant: fields.select({
      options: [
        { value: "split", label: "Split" },
        { value: "centered", label: "Centered" },
      ],
      defaultValue: "split",
    }),
  },
  defaults: {
    heading: "Add a heading",
    variant: "split",
  },
  constraints: {
    allowedParents: ["page"],
    minInstances: 0,
    maxInstances: 1,
    recommendedPosition: "first",
  },
});
```

DSL kompiluje się do stabilnego AST, a następnie do:

- JSON Schema;
- editor manifest;
- TypeScript types;
- MCP descriptions;
- validation rules;
- migration metadata.

Nie opierać głównego API na Zod. Udostępnić opcjonalny adapter `fromZod`.

## 6.2. `@cms/protocol`

Definiuje wersjonowane kontrakty transportowe:

```text
protocol/src/
├── version.ts
├── api/
│   ├── requests.ts
│   ├── responses.ts
│   └── events.ts
├── preview/
│   ├── messages.ts
│   ├── capabilities.ts
│   └── handshake.ts
├── manifest/
├── mcp/
├── webhooks/
└── codecs/
```

Każda wiadomość:

```ts
interface ProtocolEnvelope<TType extends string, TPayload> {
  protocolVersion: string;
  type: TType;
  requestId?: string;
  timestamp: string;
  payload: TPayload;
}
```

Protokoły wersjonować niezależnie od wersji npm.

## 6.3. `@cms/core`

Pure domain entities i value objects:

```text
core/src/
├── entities/
│   ├── change.ts
│   ├── document.ts
│   ├── section.ts
│   ├── content-type.ts
│   ├── release.ts
│   ├── actor.ts
│   ├── role.ts
│   ├── review.ts
│   ├── comment.ts
│   └── environment.ts
├── value-objects/
├── events/
├── errors/
├── policies/
└── index.ts
```

Nie wykonuje I/O.

## 6.4. `@cms/document-model`

Odpowiada za edycję dokumentów:

- immutable document state;
- typed patches;
- undo/redo;
- patch inversion;
- patch compaction;
- three-way merge;
- semantic conflict detection;
- dirty paths;
- field-level validation;
- stable IDs.

Patch union:

```ts
type ContentPatch =
  | { op: "set"; path: ContentPath; value: unknown }
  | { op: "unset"; path: ContentPath }
  | { op: "insert"; path: ContentPath; index: number; value: unknown }
  | { op: "remove"; path: ContentPath; index?: number }
  | { op: "move"; path: ContentPath; from: number; to: number }
  | { op: "replace-reference"; path: ContentPath; ref: ContentRef };
```

Każdy patch ma metadata:

```ts
interface PatchMetadata {
  id: string;
  actorId: ActorId;
  createdAt: string;
  source: "editor" | "inline" | "mcp" | "migration" | "import";
  description?: string;
}
```

## 6.5. `@cms/content-codecs`

Parsery i serializery:

- YAML;
- Markdown z frontmatter;
- JSON;
- rich-text AST;
- deterministic formatting;
- source locations dla błędów;
- preservation mode, jeśli możliwe;
- canonical mode dla commitów CMS-a.

Struktura:

```text
content-codecs/src/
├── yaml/
├── markdown/
├── json/
├── rich-text/
├── source-map/
└── canonicalize/
```

Serializacja musi być deterministyczna, żeby ograniczyć szum w diffach.

## 6.6. `@cms/content-repository`

Port operujący na logicznych dokumentach, nie na GitHub API:

```ts
interface ContentRepository {
  listDocuments(input: ListDocumentsInput): Promise<Page<DocumentSummary>>;
  readDocument(input: ReadDocumentInput): Promise<ContentDocument>;
  writeDocuments(input: WriteDocumentsInput): Promise<WriteResult>;
  deleteDocuments(input: DeleteDocumentsInput): Promise<DeleteResult>;
  readProjectConfig(ref: GitRef): Promise<ProjectConfig>;
  readRegistryLock(ref: GitRef): Promise<RegistryLock>;
}
```

Adapter mapuje ścieżki repo na dokumenty.

## 6.7. `@cms/application`

Najważniejsza paczka. Zawiera use cases.

```text
application/src/
├── ports/
│   ├── git-provider.ts
│   ├── content-repository.ts
│   ├── asset-store.ts
│   ├── release-store.ts
│   ├── session-store.ts
│   ├── identity-provider.ts
│   ├── scheduler.ts
│   ├── notifier.ts
│   └── clock.ts
├── commands/
│   ├── changes/
│   ├── documents/
│   ├── reviews/
│   ├── staging/
│   ├── publishing/
│   ├── assets/
│   ├── localization/
│   ├── migrations/
│   └── team/
├── queries/
├── authorization/
├── validators/
├── services/
├── transactions/
└── events/
```

Przykład command handlera:

```ts
class CreateChangeHandler {
  constructor(
    private readonly git: GitProvider,
    private readonly authorization: AuthorizationService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: CreateChangeCommand, context: RequestContext) {
    await this.authorization.assert(context.actor, "change.create");

    const base = await this.git.resolveRef(command.baseBranch);
    const change = Change.create({
      id: this.idGenerator.changeId(),
      name: command.name,
      owner: context.actor,
      baseCommit: base.sha,
      createdAt: this.clock.now(),
    });

    const branchName = buildChangeBranchName(change, context.actor);
    await this.git.createBranch({ branchName, from: base.sha });
    await this.git.commitFiles({
      branch: branchName,
      files: [serializeChangeMetadata(change)],
      author: context.actor.gitIdentity,
      message: `Create change "${change.name}"`,
    });

    return change;
  }
}
```

## 6.8. `@cms/permissions`

- role definitions;
- team mapping;
- field/content-type restrictions;
- ownership rules;
- effective permission calculation;
- policy evaluation;
- action explanations.

Uprawnienia są przecięciem:

```text
GitHub capability ∩ CMS role ∩ resource policy ∩ workflow state
```

## 6.9. `@cms/git`

Framework-agnostic Git abstractions i helpery:

- ref normalization;
- branch naming;
- commit author mapping;
- semantic diff;
- merge planning;
- branch cleanup;
- change metadata;
- release metadata.

## 6.10. `@cms/github`

GitHub App adapter:

```text
github/src/
├── app-auth/
├── user-auth/
├── installation/
├── repositories/
├── branches/
├── contents/
├── commits/
├── pulls/
├── reviews/
├── checks/
├── deployments/
├── teams/
├── webhooks/
├── rate-limit/
└── errors/
```

Wykorzystuje installation tokeny do operacji botowych i user token wyłącznie tam, gdzie potrzebna jest akcja „on behalf of user”.

Funkcje:

- create/fetch branch;
- Git Data API tworzące blob/tree/commit/ref;
- PR create/update/merge;
- review and comments;
- branch protection checks;
- team membership;
- webhook verification;
- retry z idempotency key;
- rate limit handling;
- GitHub Enterprise base URL.

## 6.11. `@cms/auth`

GitHub App OAuth/user authorization:

- login initiation;
- state + PKCE;
- callback;
- user profile;
- installation membership;
- logout;
- CSRF;
- session actor hydration.

Nie przechowywać tokenu w LocalStorage.

## 6.12. `@cms/sessions`

Domyślna implementacja bez bazy:

- encrypted, signed, HTTP-only cookie;
- krótka sesja z rotacją;
- server-side token envelope, jeśli rozmiar danych przekracza bezpieczny limit;
- opcjonalny adapter KV/Redis/database.

Session payload nie zawiera private key ani installation tokenów.

## 6.13. `@cms/server`

Standardowy Web API handler niezależny od frameworka:

```ts
const response = await cmsServer.handle(request, serverContext);
```

Router wewnętrzny:

```text
/api/cms/auth/login
/api/cms/auth/callback
/api/cms/auth/logout
/api/cms/session
/api/cms/bootstrap
/api/cms/changes
/api/cms/changes/:id
/api/cms/changes/:id/documents
/api/cms/changes/:id/review
/api/cms/changes/:id/staging
/api/cms/staging
/api/cms/publishing
/api/cms/releases
/api/cms/assets
/api/cms/search
/api/cms/team
/api/cms/github/webhook
/api/cms/mcp
```

Route’y transportowe są cienkie. Każdy endpoint:

- wymaga request ID;
- zwraca typed envelope;
- mapuje domain errors na HTTP;
- loguje audyt;
- waliduje CSRF dla mutations;
- stosuje rate limiting adapter;
- nie zwraca sekretów.

## 6.14. `@cms/editor-ui`

Własny design system CMS-a oparty na accessible primitives, ale bez zależności domenowych.

```text
editor-ui/src/
├── tokens/
├── primitives/
│   ├── button/
│   ├── input/
│   ├── textarea/
│   ├── select/
│   ├── combobox/
│   ├── dialog/
│   ├── popover/
│   ├── tooltip/
│   ├── tabs/
│   ├── menu/
│   ├── toast/
│   └── splitter/
├── composites/
│   ├── property-field/
│   ├── tree/
│   ├── command-menu/
│   ├── status-badge/
│   ├── empty-state/
│   ├── data-table/
│   ├── diff-view/
│   ├── timeline/
│   ├── inspector-group/
│   └── responsive-preview-frame/
├── hooks/
├── icons/
├── styles/
└── testing/
```

Zasady:

- neutralny, narzędziowy wygląd;
- canvas dominuje nad chrome UI;
- pełne keyboard navigation;
- WCAG AA;
- light/dark/system;
- tokeny CSS z prefixem `--cms-*`;
- zero globalnego resetu;
- CSS layers;
- motion ograniczane przez `prefers-reduced-motion`;
- brak kolorów zakodowanych w feature components.

## 6.15. `@cms/editor`

Aplikacja React SPA osadzana w `/cms`.

Stack:

- React + TypeScript;
- TanStack Router;
- TanStack Query;
- Zustand wyłącznie dla ephemeral editor state;
- React Hook Form dla pojedynczych inspektorów;
- dnd-kit;
- Lexical lub Tiptap jako adapter rich text;
- IndexedDB przez mały własny port;
- Web Workers dla diff/validation/index.

Struktura:

```text
editor/src/
├── app/
│   ├── create-editor-app.tsx
│   ├── providers/
│   ├── router/
│   ├── layouts/
│   ├── error-boundaries/
│   └── boot/
├── features/
│   ├── authentication/
│   ├── dashboard/
│   ├── changes/
│   ├── content-browser/
│   ├── visual-editor/
│   ├── inspector/
│   ├── inline-editing/
│   ├── collections/
│   ├── globals/
│   ├── settings/
│   ├── reusable-blocks/
│   ├── seo/
│   ├── localization/
│   ├── assets/
│   ├── comments/
│   ├── review/
│   ├── staging/
│   ├── publishing/
│   ├── releases/
│   ├── redirects/
│   ├── team/
│   ├── project-settings/
│   ├── integrations/
│   └── developer-tools/
├── entities/
│   ├── change/
│   ├── document/
│   ├── asset/
│   ├── actor/
│   ├── release/
│   └── registry/
├── shared/
│   ├── api/
│   ├── state/
│   ├── hooks/
│   ├── keyboard/
│   ├── workers/
│   ├── telemetry/
│   └── utilities/
└── index.ts
```

## 6.16. `@cms/editor-bridge`

Kod uruchamiany w route preview:

- handshake z parent editor;
- `MessageChannel`;
- section registry runtime;
- selection/hover;
- DOM anchors;
- inline editable fields;
- navigation interception;
- responsive viewport;
- patch application;
- error reporting;
- screenshot mode.

Overlay implementować jako Web Components z Shadow DOM, aby CSS klienta go nie nadpisywał.

## 6.17. `@cms/react`

- `createReactRegistry`;
- `CmsPageRenderer`;
- `CmsSectionBoundary`;
- `CmsPreviewProvider`;
- hooks preview;
- server-compatible renderer;
- client bridge jako osobny export.

## 6.18. `@cms/astro-renderer`

- registry komponentów Astro;
- mapping sekcji do `.astro`;
- renderer dla komponentów React osadzonych w Astro;
- preview anchor instrumentation;
- capabilities per renderer.

## 6.19. `@cms/next`

Oficjalna pełna integracja App Router.

Exports:

```text
@cms/next
@cms/next/server
@cms/next/editor
@cms/next/preview
@cms/next/client
@cms/next/testing
```

CLI generuje wyłącznie:

```text
app/cms/[[...path]]/page.tsx
app/__cms/preview/[[...slug]]/page.tsx
app/api/cms/[[...path]]/route.ts
cms.config.ts
```

## 6.20. `@cms/astro`

Astro integration:

- config hook;
- virtual modules;
- middleware;
- endpoint mounting;
- editor page;
- preview route;
- build hooks;
- static/server capability detection.

Pełny produkcyjny `/cms` wymaga server runtime. W `output: static` wspierać:

- lokalny editor;
- oddzielny generated server adapter;
- albo jasno zgłaszany brak server capabilities.

## 6.21. `@cms/assets` i `@cms/image-pipeline`

Porty:

```ts
interface AssetStore {
  createUpload(input: CreateUploadInput): Promise<UploadTarget>;
  finalizeUpload(input: FinalizeUploadInput): Promise<Asset>;
  readAsset(id: AssetId): Promise<Asset>;
  deleteAsset(id: AssetId): Promise<void>;
  listAssets(input: ListAssetsInput): Promise<Page<Asset>>;
}
```

Asset storage jest capability niezależnym od repozytorium contentowego i release storage. Produkcyjnie
korzysta z osobnego bucketu/prefixu oraz osobnego publicznego originu. Dokumenty nie zapisują kopii
pliku ani tymczasowego signed URL, tylko stabilną referencję:

```ts
interface AssetReference {
  readonly id: AssetId;
  readonly url: string;
  readonly mimeType: string;
  readonly fileName: string;
  readonly altText?: string;
}
```

Editor udostępnia pełną galerię assetów:

- przeglądanie miniaturek i plików z paginacją;
- wyszukiwanie po nazwie, typie i alt text;
- filtrowanie zgodne z `fields.asset({ accept })`;
- bezpośredni upload do storage oraz bezpieczne finalizowanie;
- wybór istniejącego assetu z inspectora sekcji/bloku;
- natychmiastową aktualizację preview przez ten sam patch stream;
- podgląd wariantów, wymiarów, rozmiaru i usage graph;
- usunięcie tylko wtedy, gdy asset nie jest używany przez Change ani immutable release;
- pełną obsługę klawiatury, focus management i czytelny empty/error state.

Każde pole sekcji lub content type zadeklarowane jako `fields.asset()` renderuje asset picker.
Picker zapisuje `AssetReference` pod właściwą ścieżką RFC 6901, więc wybór media działa jednakowo
dla zwykłych bloków, Reusable Blocks, Globals i dokumentów kolekcji.

Providerzy:

- local filesystem;
- Git repo;
- S3-compatible;
- R2;
- MinIO;
- GCS/Azure później przez adapter kit.

Pipeline:

- MIME sniffing;
- virus scanning hook;
- EXIF stripping;
- dimensions;
- hash/deduplication;
- AVIF/WebP;
- responsive sizes;
- focal point;
- crop presets;
- alt text;
- usage graph;
- signed URLs.

## 6.22. `@cms/release-builder`

Buduje deterministic immutable release:

1. checkout/odczyt exact SHA;
2. parse;
3. schema validation;
4. reference resolution;
5. locale fallback;
6. dynamic query materialization;
7. dependency graph;
8. SEO artifacts;
9. redirect graph;
10. sitemap data;
11. file hashing;
12. release manifest;
13. write to temporary prefix;
14. verify;
15. atomically update pointer.

## 6.23. `@cms/delivery`

Content client:

```ts
const client = createContentClient({
  environment: "production",
  source: cdnSource({
    baseUrl: process.env.CMS_CONTENT_URL,
  }),
});
```

Tryby:

- filesystem;
- Git during build;
- CDN release;
- custom source.

SDK obsługuje:

- immutable cache;
- `current.json`;
- ETag;
- request coalescing;
- stale cache;
- typed access;
- optional fallback to previous release;
- preview release token.

## 6.24. `@cms/seo`

- metadata model;
- inheritance;
- title templates;
- canonical;
- Open Graph;
- Twitter metadata;
- robots;
- structured data;
- hreflang;
- sitemap;
- quality checks;
- duplicate title detection;
- broken internal links;
- redirect loops.

## 6.25. `@cms/localization`

Model:

- locale;
- language;
- market;
- source locale;
- fallback chain;
- translation group;
- translation status;
- outdated detection;
- structural overrides;
- XLIFF import/export;
- provider ports.

Statusy:

```text
missing
machine_translated
translated
reviewed
approved
outdated
```

## 6.26. `@cms/search`

Bez bazy jako indeks budowany:

- w Web Workerze dla otwartego change;
- podczas CI/release do JSON index;
- opcjonalnie przez provider external search.

Wspiera:

- full-text;
- command palette;
- find usages;
- references;
- content graph;
- asset usage;
- broken reference search.

## 6.27. `@cms/mcp`

MCP server wystawia resources, prompts i tools.

Resources:

```text
cms://project
cms://registry/sections
cms://registry/content-types
cms://changes/{id}
cms://documents/{id}
cms://content-graph
cms://permissions/current-user
```

Tools:

```text
list_changes
create_change
get_change
list_documents
get_document
create_page
update_document
add_section
move_section
remove_section
search_content
find_usages
validate_change
create_preview
submit_for_review
add_review_comment
approve_change
add_to_staging
get_staging_status
publish_staging
list_releases
rollback_release
```

Każdy tool uruchamia application command/query. Publikacja i rollback wymagają uprawnienia oraz jawnego confirmation contract.

Prompts:

```text
create_landing_page
localize_page
update_global_pricing
audit_seo
prepare_campaign_change
summarize_change
```

Transporty:

- stdio dla lokalnego desktop klienta;
- Streamable HTTP dla route `/api/cms/mcp`.

## 6.28. `@cms/cli`

Polecenia:

```text
cms init
cms dev
cms doctor
cms github setup
cms registry build
cms registry validate
cms content validate
cms content migrate
cms release build
cms release publish
cms mcp
cms generate
cms upgrade
cms codemod
cms adapter inspect
```

CLI jest idempotentne i posiada dry-run.

---

# 7. Repozytorium contentowe

Docelowa struktura:

```text
content-repo/
├── .cms/
│   ├── project.yaml
│   ├── permissions.yaml
│   ├── workflows.yaml
│   ├── environments.yaml
│   ├── schema-lock.json
│   ├── registry-lock.json
│   ├── release.yaml
│   └── migrations/
│
├── content/
│   ├── pages/
│   ├── posts/
│   ├── collections/
│   ├── globals/
│   ├── settings/
│   └── reusable-blocks/
│
├── redirects/
├── taxonomy/
├── assets/
│   └── metadata/
├── localization/
│   ├── locales.yaml
│   ├── markets.yaml
│   └── glossary.yaml
└── README.md
```

Pages i Posts są domyślnie zainstalowanymi content types, lecz można je wyłączyć lub usunąć.

## 7.1. Przykładowa Page

```text
content/pages/pricing/
├── index.yaml
└── locales/
    ├── en-US.yaml
    └── pl-PL.yaml
```

`index.yaml`:

```yaml
id: page_pricing
type: pages
schemaVersion: 1
route:
  path: /pricing
layout:
  navigation: primary
  footer: primary
sections:
  - id: sec_hero
    type: pricingHero
    version: 2
  - id: sec_plans
    type: pricingGrid
    version: 3
    bindings:
      plans:
        collection: plans
        query:
          status: active
  - id: sec_faq
    type: reference
    ref: reusable-blocks/pricing-faq
seo:
  canonical: /pricing
publication:
  firstPublishedAt: 2026-01-01T10:00:00Z
```

`locales/en-US.yaml`:

```yaml
locale: en-US
fields:
  sec_hero:
    heading: Simple pricing for growing businesses
    description: Choose the plan that fits your workflow.
  sec_plans:
    heading: Compare plans
```

## 7.2. Global pricing

```text
content/collections/plans/
├── lite/
│   ├── index.yaml
│   └── locales/
├── plus/
└── premium/
```

Cena nie jest kopiowana do stron. Strony referują `plans`.

## 7.3. Globals

```text
content/globals/navigation/primary/
├── index.yaml
└── locales/
```

Elementy list posiadają stabilne IDs, aby lokalizacje nie opierały się na indeksach.

## 7.4. Change metadata

Na każdym branchu change:

```yaml
# .cms/change.yaml
id: chg_01K...
name: Pricing refresh
description: New pricing page, global prices and navigation.
owner:
  githubId: 123
  login: adam
contributors:
  - githubId: 123
base:
  branch: main
  commit: abc123
status: draft
createdAt: 2026-07-27T10:00:00Z
```

Status jest informacyjny; prawdziwy workflow jest wyliczany także ze stanu branch/PR.

---

# 8. Frontend repository i rejestr komponentów

```text
frontend/
├── cms.config.ts
├── src/
│   ├── cms/
│   │   ├── registry.ts
│   │   ├── sections/
│   │   ├── collections/
│   │   ├── globals/
│   │   ├── settings/
│   │   ├── templates/
│   │   ├── fields/
│   │   └── migrations/
│   └── components/
└── .cms/
    └── generated/
        ├── manifest.json
        ├── content-types.d.ts
        └── registry-lock.json
```

Rejestr:

```ts
export const registry = createReactRegistry({
  sections: [
    registerReactSection(heroDefinition, Hero),
    registerReactSection(pricingGridDefinition, PricingGrid),
  ],
  collections: [pages(), posts(), plans],
  globals: [primaryNavigation, primaryFooter],
  settings: [siteSettings, seoSettings],
  templates: [pricingTemplate],
});
```

Manifest jest generowany podczas build/CI i przypisany do frontend commit SHA.

CMS blokuje publikację contentu używającego sekcji niewspieranej przez produkcyjny manifest frontendu.

---

# 9. Workflow editorial

## 9.1. Branche

```text
main
staging
cms/<user-slug>/<change-slug>-<suffix>
hotfix/<user-slug>/<change-slug>-<suffix>
```

- `main`: dokładny content intended for production;
- `staging`: kandydat następnego wspólnego wydania;
- `cms/*`: izolowane zmiany;
- `hotfix/*`: wyjątkowa ścieżka z `main` bezpośrednio do `main`.

## 9.2. New Change

Użytkownik:

1. klika `New change`;
2. podaje nazwę i opcjonalny opis;
3. system tworzy branch z aktualnego `main`;
4. dodaje `.cms/change.yaml`;
5. otwiera workspace.

W jednym Change można zmienić:

- stronę;
- globalne ceny;
- nawigację;
- SEO;
- locale;
- redirect;
- assety.

## 9.3. Zapisywanie

Warstwy:

1. in-memory field state;
2. IndexedDB recovery;
3. debounce semantic patches;
4. remote snapshot na branchu;
5. logiczne commity przy:
   - zmianie dokumentu,
   - explicit save version,
   - submit review,
   - dłuższej bezczynności.

Commity nie mogą powstawać per znak.

## 9.4. Preview Change

Preview renderuje branch Change z frontendem:

- matching frontend branch, jeśli istnieje;
- inaczej frontend `main`;
- możliwość jawnego wyboru frontend ref.

Preview pokazuje cały serwis w kontekście Change.

## 9.5. Review

`Send for review` tworzy PR:

```text
cms/... → staging
```

Review ma:

- summary;
- semantic diff;
- visual diff;
- changed documents;
- affected usages;
- warnings;
- comments przypięte do document/section/field;
- checks.

## 9.6. Add to staging

Po approval publisher merge’uje PR do `staging`. Branch Change jest usuwany.

Staging publication job generuje staging release JSON.

## 9.7. Publish staging

Publisher uruchamia PR:

```text
staging → main
```

Po merge do `main`:

1. production job buduje immutable release;
2. zapisuje release;
3. atomowo przełącza production pointer;
4. wywołuje revalidation;
5. zapisuje deployment status;
6. synchronizuje staging do main;
7. oznacza Changes jako published.

Reguła produktu:

> Wszystko na stagingu jest częścią następnego wspólnego wydania.

## 9.8. Hotfix

- tworzy się z `main`;
- review bezpośrednio do `main`;
- po publikacji system forward-merguje lub rebasuje zmianę do `staging`;
- UI oznacza ścieżkę jako Emergency change.

## 9.9. Rollback

Operational rollback:

- zmiana `production/current.json` na poprzedni release;
- natychmiastowa revalidation.

Repository reconciliation:

- automatyczny revert PR do `main`;
- synchronizacja stagingu;
- pełny audit.

---

# 10. Publication pipeline

## 10.1. GitHub Actions

Repo contentowe otrzymuje generowane workflow:

```text
.github/workflows/
├── cms-validate-change.yml
├── cms-publish-staging.yml
├── cms-publish-production.yml
├── cms-scheduled-publications.yml
├── cms-migrations.yml
└── cms-cleanup.yml
```

## 10.2. Trigger production

```yaml
on:
  push:
    branches: [main]
```

Job uruchamia:

```text
cms release build --ref $GITHUB_SHA --environment production
cms release publish --environment production
```

## 10.3. Release layout

```text
/releases/<release-id>/
├── manifest.json
├── pages/
├── collections/
├── globals/
├── settings/
├── reusable-blocks/
├── redirects.json
├── sitemap.json
├── content-index.json
├── dependency-graph.json
└── checksums.json

/environments/production/current.json
/environments/staging/current.json
```

## 10.4. Atomicity

Release uploaduje się do tymczasowego immutable prefixu. Pointer zmienia się dopiero po:

- przesłaniu wszystkich plików;
- walidacji checksums;
- odczycie kontrolnym;
- optional smoke test.

## 10.5. Revalidation event

```json
{
  "event": "content.release.published",
  "environment": "production",
  "releaseId": "rel_...",
  "previousReleaseId": "rel_...",
  "gitCommit": "...",
  "changed": {
    "paths": ["/pricing"],
    "tags": ["cms:page:pricing", "cms:collection:plans"]
  }
}
```

Webhook podpisany HMAC i posiada timestamp/replay protection.

---

# 11. HTTP API

## 11.1. Kontrakt

- standard Web Request/Response;
- JSON;
- typed error envelope;
- CSRF dla mutacji;
- same-origin default;
- request ID;
- optimistic concurrency `expectedRevision`;
- pagination cursor;
- idempotency key dla operacji tworzących Git state.

## 11.2. Bootstrap

`GET /api/cms/bootstrap`

Zwraca:

- current user;
- roles;
- project;
- capabilities;
- branches;
- environments;
- registry manifest;
- framework adapter capabilities;
- feature flags.

## 11.3. Changes

```text
GET    /changes
POST   /changes
GET    /changes/:id
PATCH  /changes/:id
DELETE /changes/:id
POST   /changes/:id/submit
POST   /changes/:id/approve
POST   /changes/:id/request-changes
POST   /changes/:id/add-to-staging
POST   /changes/:id/archive
```

## 11.4. Documents

```text
GET    /changes/:id/documents
GET    /changes/:id/documents/:documentId
PATCH  /changes/:id/documents/:documentId
POST   /changes/:id/documents
DELETE /changes/:id/documents/:documentId
POST   /changes/:id/commit
```

PATCH przyjmuje patche, nie cały dokument.

## 11.5. Preview

```text
POST /preview/sessions
GET  /preview/sessions/:id
POST /preview/sessions/:id/refresh
```

Token preview:

- krótko ważny;
- signed;
- związany z actor, change, frontend ref i locale;
- nie ujawnia GitHub tokena.

## 11.6. Staging/publishing

```text
GET  /staging
POST /staging/publish
GET  /releases
POST /releases/:id/rollback
POST /releases/:id/revalidate
```

## 11.7. Assets

```text
POST   /assets/uploads
POST   /assets/uploads/:id/finalize
GET    /assets
GET    /assets/:id
PATCH  /assets/:id
DELETE /assets/:id
GET    /assets/:id/usages
```

---

# 12. Użytkownicy, logowanie i role

## 12.1. Identity

GitHub user ID jest stabilnym identyfikatorem. Login jest tylko display value.

Logowanie:

```text
/cms
→ Continue with GitHub
→ GitHub App user authorization
→ callback
→ repo/installation membership check
→ encrypted session cookie
```

## 12.2. Provisioning

Team w CMS jest widokiem:

- członków GitHub organization/repository;
- GitHub teams;
- mapowań w `.cms/permissions.yaml`.

Zaproszenie może:

1. zaprosić do GitHub organization;
2. dodać do teamu;
3. utworzyć mapowanie CMS role;
4. wysłać link do `/cms`.

## 12.3. Role

- Viewer;
- Author;
- Editor;
- Translator;
- Reviewer;
- Publisher;
- Developer;
- Administrator.

Wspierać custom roles.

## 12.4. Commit authorship

- Author: użytkownik;
- Committer: CMS GitHub App;
- metadata Change-ID;
- czytelne commit messages;
- audit event.

## 12.5. Sesje

- HTTP-only;
- Secure;
- SameSite=Lax/Strict zależnie od callback;
- rotacja;
- absolute i idle expiry;
- logout invalidation;
- CSRF token powiązany z sesją.

---

# 13. Graficzny edytor — UX i komponenty

## 13.1. Główny layout

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Topbar: Change · locale · viewport · preview · review · publish     │
├───────────────┬───────────────────────────────────┬─────────────────┤
│ Navigation    │ Canvas / real frontend preview    │ Inspector       │
│               │                                   │                 │
│ Content tree  │                                   │ Fields          │
│ Pages         │                                   │ Layout          │
│ Collections   │                                   │ Visibility      │
│ Globals       │                                   │ SEO             │
│ Assets        │                                   │ Advanced        │
├───────────────┴───────────────────────────────────┴─────────────────┤
│ Save status · validation · collaborators · activity                 │
└─────────────────────────────────────────────────────────────────────┘
```

Panele są resizeable i mogą być ukrywane.

## 13.2. Route map

```text
/cms
/cms/changes
/cms/changes/new
/cms/changes/:changeId
/cms/changes/:changeId/pages/:documentId
/cms/changes/:changeId/collections/:type/:entryId
/cms/changes/:changeId/globals/:type/:entryId
/cms/staging
/cms/releases
/cms/assets
/cms/team
/cms/settings
/cms/developer
```

## 13.3. Dashboard

Sekcje:

- My changes;
- Needs my review;
- Approved;
- On staging;
- Recent releases;
- validation incidents;
- shortcuts.

## 13.4. New Change dialog

Pola:

- name;
- description;
- base (`Production` domyślnie);
- collaborators;
- optional target date.

Po utworzeniu użytkownik trafia do Change workspace.

## 13.5. Content tree

- wirtualizowane listy;
- search;
- typy contentu;
- status locale;
- changed indicator;
- drag reorder sekcji;
- keyboard actions;
- context menu;
- create/duplicate/delete.

## 13.6. Canvas

iframe tego samego frontendu:

- rzeczywisty routing;
- rzeczywiste global CSS;
- prawdziwe fonty;
- responsive modes;
- zoom;
- reload;
- open standalone;
- simulate locale/market/date/audience;
- click-to-select;
- inline editing;
- add section insertion points;
- visual comments;
- error overlay.

## 13.7. Inspector

Generowany z field schema:

- TextFieldEditor;
- RichTextFieldEditor;
- NumberFieldEditor;
- SelectFieldEditor;
- AssetFieldEditor;
- LinkFieldEditor;
- ReferenceFieldEditor;
- ObjectFieldEditor;
- ListFieldEditor;
- BlocksFieldEditor;
- DateTimeFieldEditor;
- JsonFieldEditor;
- custom field iframe extension.

Każdy field editor jest pluginem rejestru.

## 13.8. Inline editing

Dla pól `inline: true`:

- text;
- rich text;
- CTA label;
- alt text, jeśli wybrane;
- brak inline dla złożonych relacji.

Inline state korzysta z tego samego patch command co inspector.

## 13.9. Add Section

Biblioteka sekcji:

- kategorie;
- screenshot thumbnail;
- variants;
- description;
- usage guidance;
- search;
- recent/favorites;
- compatibility warnings.

Miniatury generowane w CI ze Story/section preview routes.

## 13.10. Change summary

Automatyczne, deterministyczne summary z semantic diff, opcjonalnie ulepszone przez AI.

Pokazuje:

- utworzone/usunięte dokumenty;
- zmienione globals;
- zmiany cen;
- routing;
- locale;
- affected usages;
- warnings;
- assets;
- SEO;
- redirects.

## 13.11. Review UI

- side-by-side visual diff;
- responsive screenshots;
- field diff;
- comments;
- approve/request changes;
- resolved threads;
- checks;
- reviewer assignment;
- audit timeline.

## 13.12. Staging UI

- Changes included;
- staging release;
- test checklist;
- validation;
- lock batch;
- publish;
- remove/revert change przed publish;
- link do staging website.

## 13.13. Release UI

- release timeline;
- Git SHA;
- manifest;
- changed routes/tags;
- status storage/CDN/revalidation;
- rollback;
- compare releases;
- download manifest.

---

# 14. Stan edytora i wydajność

## 14.1. Podział stanu

TanStack Query:

- server data;
- changes;
- documents;
- release status;
- assets;
- users.

Zustand:

- selected section;
- hovered section;
- active panel;
- viewport;
- zoom;
- open dialogs;
- local patch queue;
- iframe connection.

React Hook Form:

- tylko formularz zaznaczonego obiektu;
- nie cały dokument.

Document model store:

- canonical editable document;
- patches;
- undo/redo;
- dirty paths;
- validation.

## 14.2. Wydajność

- field-level subscriptions;
- patch do iframe zamiast całego dokumentu;
- no iframe reload podczas edycji;
- virtualized lists;
- lazy feature chunks;
- Web Worker diff/validation;
- request batching;
- IndexedDB write debounce;
- memoized schema form;
- asset upload poza React state;
- cancellation przez AbortController.

Budżety:

- normal public CMS runtime: 0 KB;
- preview bridge: minimalny osobny chunk;
- editor initial shell bez rich text/asset heavy chunks;
- lazy load rich text, assets, diff, releases.

---

# 15. Preview protocol

## 15.1. Handshake

1. editor tworzy iframe z preview token;
2. iframe wysyła `preview.ready`;
3. parent weryfikuje origin i session ID;
4. tworzy `MessageChannel`;
5. przekazuje port;
6. capability negotiation.

## 15.2. Wiadomości

```text
editor.initialize
editor.apply-patches
editor.select-section
editor.set-viewport-context
editor.navigate
editor.request-screenshot

preview.ready
preview.document-loaded
preview.section-hovered
preview.section-selected
preview.inline-patch
preview.navigation
preview.runtime-error
preview.validation-error
preview.height-changed
```

Każda wiadomość walidowana runtime schema.

## 15.3. Bezpieczeństwo

- exact allowed origins;
- token scoped do change;
- brak `*` targetOrigin;
- CSP frame ancestors;
- nonce/session binding;
- input validation;
- expiry;
- navigation allowlist.

---

# 16. SEO

Każdy routowalny content type może włączyć feature `seo`.

Dziedziczenie:

```text
document → content type → locale/market → project defaults
```

Obsługa:

- title;
- title template;
- description;
- canonical;
- robots;
- social;
- structured data;
- hreflang;
- sitemap inclusion;
- OG image;
- breadcrumb data.

Quality gates:

- missing/duplicate title;
- lengths;
- canonical errors;
- noindex in sitemap;
- broken links;
- invalid structured data;
- missing social image;
- hreflang inconsistencies;
- redirect loops/chains;
- slug collision.

Zmiana sluga proponuje 301.

---

# 17. i18n i markets

Rozdzielić:

- language;
- locale;
- market;
- domain;
- currency;
- audience.

Domyślna storage strategy:

```text
document structure + separate locale files
```

Locale overrides struktury są jawne i audytowane.

Preview toolbar:

- locale;
- market;
- date/time;
- customer state;
- feature flags.

Translation workflow, AI suggestions, glossary i XLIFF są częścią produktu, ale przez porty.

---

# 18. Collections, Pages, Posts, Globals i Settings

## 18.1. Pages

- routing;
- sections;
- layout;
- SEO;
- locale;
- template;
- preview.

## 18.2. Posts

- rich text;
- optional sections;
- author;
- taxonomy;
- dates;
- SEO;
- routing.

## 18.3. Collections

Dowolne structured entries:

- offers;
- promotions;
- plans;
- products;
- testimonials;
- jobs;
- events;
- locations;
- authors.

## 18.4. Globals

- navigation;
- footer;
- announcement bar;
- cookie banner;
- global CTA.

CMS pokazuje wpływ zmiany na wszystkie usage.

## 18.5. Settings

- site;
- SEO;
- social;
- analytics;
- legal;
- localization;
- integrations.

Techniczne settings mają osobne permissions.

## 18.6. Reusable blocks

Instancje sekcji używane na wielu stronach, z:

- usage graph;
- optional overrides;
- detach/copy;
- warning o globalnym wpływie.

---

# 19. Scheduling

Bez własnego schedulera:

- publication schedule zapisywany w repo;
- GitHub Action uruchamiany cyklicznie;
- idempotentny command;
- lock przez GitHub environment/concurrency;
- audit result.

Rozróżnić:

- publishAt;
- unpublishAt;
- availabilityFrom/Until;
- visibility schedule.

Scheduled publication może dotyczyć staging batch lub hotfix.

---

# 20. MCP i AI safety

Agent działa jako zalogowany actor.

Poziomy:

- read;
- edit draft;
- create preview;
- submit review;
- approve;
- staging;
- publish.

Default:

- agent może tworzyć Change i preview;
- nie może publikować bez explicit permission;
- tool results zawierają summary i preview URL;
- destructive actions wymagają confirmation token;
- prompt injection z contentu nie może zmienić permissions;
- audit source=`mcp`.

AI nie zapisuje surowego YAML, tylko wykonuje typed operations.

---

# 21. Instalacja

## 21.1. Next.js

```bash
pnpm add @cms/next
pnpm cms init
pnpm cms github setup
pnpm dev
```

Generowane pliki są cienkie.

`cms.config.ts`:

```ts
export default defineCms({
  configVersion: 1,
  editor: { path: "/cms" },
  preview: { path: "/__cms/preview" },
  api: { path: "/api/cms" },
  content: githubContentRepository({
    owner: "acme",
    repository: "marketing-content",
    mainBranch: "main",
    stagingBranch: "staging",
  }),
  registry,
  assets: s3Assets({...}),
  delivery: s3Delivery({...}),
});
```

## 21.2. Astro

```bash
pnpm add @cms/astro
pnpm cms init
```

Integracja w `astro.config`.

CLI wykrywa static/server i wyświetla capability plan.

## 21.3. GitHub App setup

Automatyczny manifest flow.

Minimal permissions:

- metadata read;
- contents read/write;
- pull requests read/write;
- checks read/write;
- deployments read/write;
- members read, jeśli team mapping;
- actions read/write tylko jeśli wymagane.

Webhooki:

- installation;
- installation_repositories;
- push;
- pull_request;
- pull_request_review;
- pull_request_review_comment;
- check_run/check_suite;
- deployment/deployment_status;
- membership/team, jeśli dostępne.

---

# 22. Aktualizacje

## 22.1. Wersje

Osobno:

- package version;
- protocol version;
- config version;
- registry manifest version;
- content schema version;
- section version;
- release format version.

## 22.2. Upgrade

```bash
pnpm cms upgrade
```

Flow:

1. dependency compatibility check;
2. backup branch;
3. config codemod;
4. generated route check;
5. registry regeneration;
6. content migration branch;
7. validation;
8. report;
9. manual actions.

## 22.3. Migracje treści

Każda sekcja ma chain migracji.

Migracje wykonują się na nowym Change/PR, nigdy bezpośrednio na main.

## 22.4. Codemody

AST-based, nie regex.

## 22.5. `cms doctor`

Sprawdza:

- config;
- routes;
- environment;
- GitHub App;
- permissions;
- repo branches;
- webhooks;
- registry;
- schema;
- storage;
- CDN;
- actions;
- protocol compatibility;
- security headers.

---

# 23. Testowanie

## 23.1. Unit tests

Dla:

- domain entities;
- policies;
- serializers;
- patch model;
- merge/conflicts;
- release builder;
- auth helpers;
- permission evaluation.

## 23.2. Contract tests

Każdy adapter port musi przejść wspólny zestaw contract tests:

```text
GitProviderContract
AssetStoreContract
ReleaseStoreContract
FrameworkAdapterContract
RendererContract
SessionStoreContract
```

## 23.3. Integration tests

- GitHub API mocked + recorded fixtures;
- Git Data commit flow;
- OAuth callback;
- webhook signatures;
- branch/PR workflow;
- S3-compatible MinIO;
- release pointer.

## 23.4. E2E Playwright

Scenariusze:

1. login;
2. New Change;
3. create page;
4. add sections;
5. edit global pricing;
6. navigation update;
7. preview;
8. submit review;
9. approve;
10. add staging;
11. staging release;
12. publish;
13. CDN content;
14. rollback;
15. i18n;
16. permissions;
17. conflict resolution;
18. MCP-created change.

Testy Next i Astro.

## 23.5. Visual regression

- editor screens;
- section library;
- inspector;
- comments;
- review diff;
- responsive canvas;
- dark/light.

## 23.6. Security tests

- CSRF;
- session fixation;
- token leakage;
- webhook replay;
- path traversal;
- malicious YAML;
- prototype pollution;
- XSS rich text;
- SVG upload;
- zip bomb;
- SSRF asset import;
- open redirect;
- origin spoofing preview;
- permission escalation.

## 23.7. Performance tests

- 10k entries;
- 1k pages;
- 100 sections page;
- large locale set;
- large dependency graph;
- release build;
- editor typing latency;
- patch throughput;
- asset library.

---

# 24. CI/CD projektu open-source

Workflow:

```text
lint
typecheck
unit
contract
integration
e2e-next
e2e-astro
visual
security
bundle-size
api-extractor
architecture-boundaries
release
```

- Changesets;
- provenance;
- signed releases;
- npm trusted publishing;
- SBOM;
- dependency review;
- CodeQL;
- Renovate/Dependabot;
- canary on main;
- stable via changeset release PR.

---

# 25. Observability

Bez centralnej telemetrii wymaganej.

Lokalne structured logs:

```ts
{
  (level, event, requestId, actorId, changeId, repository, durationMs, errorCode);
}
```

Adapters:

- console;
- OpenTelemetry;
- custom logger.

Nie logować:

- access tokens;
- private keys;
- session cookies;
- pełnego contentu domyślnie.

Audit events są częścią Git/PR timeline i dodatkowo mogą zostać zapisane do `.cms/audit` lub zewnętrznego adaptera.

---

# 26. Dokumentacja

Strona docs:

- quick start Next;
- quick start Astro;
- concepts;
- sections;
- fields;
- collections;
- Git workflow;
- permissions;
- GitHub App;
- storage;
- delivery;
- publishing;
- i18n;
- SEO;
- MCP;
- security;
- adapter authoring;
- migrations;
- troubleshooting;
- architecture decision records.

Każda publiczna funkcja ma TSDoc.

Przykłady są testowane w CI.

---

# 27. Kolejność implementacji pełnego produktu

To nie jest redukcja scope’u. Jest to kolejność budowania kompletnego systemu.

## Etap 1 — foundation

- monorepo;
- tooling;
- schema AST;
- protocol;
- core;
- document model;
- codecs;
- architecture tests.

## Etap 2 — GitHub domain

- GitProvider port;
- GitHub App;
- OAuth;
- sessions;
- repository content adapter;
- Change commands;
- PR workflow;
- permissions.

## Etap 3 — renderer and preview

- React registry;
- preview bridge;
- iframe protocol;
- Next adapter;
- Astro adapter;
- section instrumentation.

## Etap 4 — editor shell

- editor-ui;
- routing;
- dashboard;
- Change workspace;
- content browser;
- canvas;
- inspector;
- IndexedDB recovery.

## Etap 5 — full content modeling

- Pages;
- Posts;
- Collections;
- Globals;
- Settings;
- Reusable Blocks;
- references;
- templates;
- dynamic queries.

## Etap 6 — review and staging

- semantic diff;
- comments;
- approval;
- staging;
- GitHub checks;
- conflict detection/resolution.

## Etap 7 — releases and delivery

- release builder;
- S3/R2/MinIO;
- staging/production publication;
- pointers;
- delivery SDK;
- revalidation;
- rollback.

## Etap 8 — assets

- uploads;
- metadata;
- variants;
- image pipeline;
- usage graph;
- storage-backed asset gallery;
- schema-driven media picker dla bloków i content types;
- asset UI.

Gate: upload do osobnego storage → asset pojawia się w galerii → pole `fields.asset()` filtruje
kompatybilne media → wybór aktualizuje preview bez reloadu → zapis Change utrwala stabilną
referencję → użyty lub opublikowany asset nie może zostać usunięty.

## Etap 9 — SEO/i18n/search

- full SEO;
- redirects;
- sitemap;
- locales/markets;
- translation workflow;
- search/content graph.

## Etap 10 — MCP

- resources;
- tools;
- prompts;
- auth;
- confirmations;
- audit.

## Etap 11 — scheduling and integrations

- GitHub Actions scheduler;
- webhooks;
- deployment providers;
- translation providers;
- analytics hooks.

## Etap 12 — hardening

- full security suite;
- accessibility;
- performance;
- docs;
- examples;
- migration/codemod;
- adapter kit;
- release governance.

Każdy etap kończy się działającym pionowym przepływem i testami. Nie pozostawiać „temporary architecture”, która wymaga później przepisania core.

---

# 28. Definition of Done całego produktu

Projekt jest gotowy, gdy:

1. instalacja Next i Astro działa zgodnie z dokumentacją;
2. użytkownik GitHub może zalogować się bez ręcznej konfiguracji tokenów;
3. nietechniczny editor tworzy Change, stronę i sekcje;
4. może zmienić global pricing i navigation w jednym Change;
5. pełne preview pokazuje spójny stan;
6. review posiada semantic i visual diff;
7. approval merge’uje do staging;
8. staging publikuje immutable release;
9. staging → main publikuje production release;
10. produkcja czyta JSON z CDN/storage;
11. rollback pointera działa atomowo;
12. Pages, Posts, Collections, Globals, Settings i Reusable Blocks są kompletne;
13. SEO, i18n, redirects, assets i scheduling działają;
14. MCP wykonuje te same operacje z tymi samymi permissions;
15. publiczny frontend nie ładuje editor runtime;
16. wszystkie porty mają contract tests;
17. Next i Astro mają E2E;
18. WCAG AA;
19. `cms doctor` wykrywa błędną instalację;
20. `cms upgrade` wykonuje migracje i codemody;
21. dokumentacja pozwala zainstalować projekt od zera;
22. nie istnieją moduły obchodzące application layer;
23. nie istnieje feature logic w route handlerach ani komponentach prezentacyjnych;
24. release jest reprodukowalny dla tego samego SHA i configu;
25. bezpieczeństwo zostało zweryfikowane testami.

---

# 29. Instrukcja dla agenta implementującego

Agent ma:

1. traktować ten dokument jako nadrzędny kontrakt;
2. nie upraszczać architektury przez łączenie warstw;
3. nie tworzyć osobnego backendu;
4. nie wiązać core z Next/Astro/React;
5. implementować porty przed adapterami;
6. implementować use case jako command/query przed HTTP/UI/MCP;
7. dodawać testy wraz z każdym modułem;
8. utrzymywać publiczne API małe i stabilne;
9. nie eksportować internal modules;
10. nie tworzyć dużych „god components” ani „service.ts” z wieloma domenami;
11. stosować dependency inversion;
12. generować deterministic output;
13. nie przechowywać sekretów w browserze;
14. nie używać raw Git terminology w podstawowym UI;
15. aktualizować `ARCHITECTURE.md` i ADR przy decyzjach zmieniających kontrakty;
16. nie wprowadzać biblioteki bez uzasadnienia i adaptera;
17. każdą operację mutującą implementować idempotentnie, gdy może zostać powtórzona;
18. zapewnić anulowanie operacji sieciowych;
19. nie ignorować błędów i nie używać pustych catch;
20. zakończyć każdy etap kompletnym pionowym use case’em, a nie zestawem niepołączonych modułów.

---

# 30. Ostateczny model produktu

```text
Developer:
instaluje @cms/next lub @cms/astro
rejestruje prawdziwe komponenty i ich schemas

Editor:
loguje się przez GitHub
tworzy New Change
wizualnie buduje strony i edytuje dane
wysyła do review

Reviewer:
porównuje content i wygląd
komentuje i zatwierdza

Publisher:
dodaje Changes na staging
testuje pełne wydanie
publikuje staging do main

System:
buduje immutable JSON release
wysyła do storage/CDN
atomowo przełącza pointer
revaliduje frontend

Agent AI:
działa przez MCP
używa tych samych commandów i permissions
tworzy Change, preview i review bez obchodzenia workflow
```

To jest jeden spójny produkt: wizualny CMS, system editorial workflow, Git history, content delivery platform i AI interface — bez osobnego backendu, lecz z bezpieczną warstwą serwerową montowaną w hostującym frontendzie.
