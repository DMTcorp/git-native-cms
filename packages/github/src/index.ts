import type {
  GitFile,
  GitProvider,
  GitRef,
  IdentityProfile,
  IdentityProvider,
  PullRequest,
  ReviewCheck,
  ReviewComment,
  ReviewPort,
  TeamInvitation,
  TeamMember,
  TeamProvisioningPort,
  OrganizationTeam,
} from "@git-native-cms/application";
import { CmsError, type GitCommitSha } from "@git-native-cms/core";
import { commitAuthor, normalizeGitRef } from "@git-native-cms/git";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";

export interface GitHubRequester {
  request(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly data: unknown }>;
}

export function withGitHubErrorNormalization(requester: GitHubRequester): GitHubRequester {
  return {
    async request(route, parameters) {
      try {
        return await requester.request(route, parameters);
      } catch (cause) {
        const status = statusCode(cause);
        const message = cause instanceof Error ? cause.message : String(cause);
        const remaining = responseHeader(cause, "x-ratelimit-remaining");
        if (
          (status === 403 || status === 429) &&
          (remaining === "0" || /(?:secondary )?rate limit/iu.test(message))
        ) {
          const resetSeconds = Number(responseHeader(cause, "x-ratelimit-reset"));
          const retryAfterSeconds = Number(responseHeader(cause, "retry-after"));
          throw new CmsError({
            code: "CMS_GITHUB_429",
            message: "The GitHub App API limit is exhausted. Retry after GitHub resets it.",
            category: "git",
            retryable: true,
            context: {
              ...(Number.isFinite(resetSeconds)
                ? { resetAt: new Date(resetSeconds * 1_000).toISOString() }
                : {}),
              ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
            },
            cause,
          });
        }
        throw cause;
      }
    },
  };
}

interface GitHubProviderOptions {
  readonly requester: GitHubRequester;
  readonly owner: string;
  readonly repository: string;
}

export async function createGitHubAppRequester(input: {
  readonly appId: number;
  readonly privateKey: string;
  readonly installationId: number;
  readonly baseUrl?: string;
}): Promise<GitHubRequester> {
  const EnterpriseOctokit =
    input.baseUrl === undefined ? Octokit : Octokit.defaults({ baseUrl: input.baseUrl });
  const app = new App({
    appId: input.appId,
    privateKey: input.privateKey,
    Octokit: EnterpriseOctokit,
  });
  const octokit = await app.getInstallationOctokit(input.installationId);
  return withGitHubErrorNormalization({
    request: (route, parameters) => octokit.request(route as never, parameters as never),
  });
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export class GitHubIdentityProvider implements IdentityProvider {
  constructor(
    private readonly options: {
      readonly owner: string;
      readonly repository: string;
      readonly baseUrl?: string;
      readonly fetch?: typeof globalThis.fetch;
    },
  ) {}

  async resolve(accessToken: string, signal?: AbortSignal): Promise<IdentityProfile> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const baseUrl = this.options.baseUrl ?? "https://api.github.com";
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": "2022-11-28",
    };
    const [userResponse, repositoryResponse, teamsResponse] = await Promise.all([
      fetcher(apiUrl(baseUrl, "/user"), {
        headers,
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      }),
      fetcher(
        apiUrl(
          baseUrl,
          `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}`,
        ),
        {
          headers,
          redirect: "error",
          ...(signal === undefined ? {} : { signal }),
        },
      ),
      fetcher(apiUrl(baseUrl, "/user/teams?per_page=100"), {
        headers,
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      }),
    ]);
    if (!userResponse.ok || !repositoryResponse.ok) {
      throw new CmsError({
        code: "CMS_AUTH_009",
        message: "The GitHub account cannot access the configured content repository.",
        category: "authorization",
        retryable: false,
      });
    }
    const user = record(await userResponse.json());
    const repository = record(await repositoryResponse.json());
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new CmsError({
        code: "CMS_AUTH_010",
        message: "GitHub returned an invalid user identity.",
        category: "authentication",
        retryable: false,
      });
    }
    const permissions =
      typeof repository.permissions === "object" && repository.permissions !== null
        ? (repository.permissions as Readonly<Record<string, boolean>>)
        : {};
    const teamsValue: unknown = teamsResponse.ok ? await teamsResponse.json() : [];
    const teams = Array.isArray(teamsValue)
      ? teamsValue.flatMap((value) => {
          if (typeof value !== "object" || value === null) return [];
          const team = value as Readonly<Record<string, unknown>>;
          const organization =
            typeof team.organization === "object" && team.organization !== null
              ? (team.organization as Readonly<Record<string, unknown>>)
              : {};
          return typeof team.slug === "string" &&
            typeof organization.login === "string" &&
            organization.login.toLocaleLowerCase() === this.options.owner.toLocaleLowerCase()
            ? [`${organization.login}/${team.slug}`]
            : [];
        })
      : [];
    return {
      externalId: String(user.id),
      login: user.login,
      displayName: typeof user.name === "string" ? user.name : user.login,
      capabilities: permissions,
      teams: teams.sort(),
    };
  }
}

export class GitHubTeamProvisioning implements TeamProvisioningPort {
  constructor(
    private readonly options: {
      readonly requester: GitHubRequester;
      readonly organization: string;
    },
  ) {}

  private parameters(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return { org: this.options.organization, ...extra };
  }

  async listMembers(signal?: AbortSignal): Promise<readonly TeamMember[]> {
    const response = await this.options.requester.request(
      "GET /orgs/{org}/members",
      this.parameters({
        role: "all",
        per_page: 100,
        ...(signal === undefined ? {} : { request: { signal } }),
      }),
    );
    if (!Array.isArray(response.data)) return [];
    const members = await Promise.all(
      response.data.map(async (value): Promise<TeamMember | undefined> => {
        const user = record(value);
        if (typeof user.id !== "number" || typeof user.login !== "string") return undefined;
        const membership = await this.options.requester.request(
          "GET /orgs/{org}/memberships/{username}",
          this.parameters({
            username: user.login,
            ...(signal === undefined ? {} : { request: { signal } }),
          }),
        );
        const role = record(membership.data).role === "admin" ? "admin" : "member";
        return {
          id: String(user.id),
          login: user.login,
          displayName: typeof user.name === "string" ? user.name : user.login,
          ...(typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {}),
          organizationRole: role,
        };
      }),
    );
    return members
      .filter((member): member is TeamMember => member !== undefined)
      .sort((left, right) => left.login.localeCompare(right.login));
  }

  async listTeams(signal?: AbortSignal): Promise<readonly OrganizationTeam[]> {
    const response = await this.options.requester.request(
      "GET /orgs/{org}/teams",
      this.parameters({
        per_page: 100,
        ...(signal === undefined ? {} : { request: { signal } }),
      }),
    );
    if (!Array.isArray(response.data)) return [];
    return response.data
      .flatMap((value): OrganizationTeam[] => {
        const team = record(value);
        return typeof team.id === "number" &&
          typeof team.slug === "string" &&
          typeof team.name === "string"
          ? [
              {
                id: String(team.id),
                slug: team.slug,
                name: team.name,
                ...(typeof team.description === "string" ? { description: team.description } : {}),
              },
            ]
          : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async invite(input: Parameters<TeamProvisioningPort["invite"]>[0]): Promise<TeamInvitation> {
    if ((input.email === undefined) === (input.inviteeId === undefined)) {
      throw new CmsError({
        code: "CMS_TEAM_001",
        message: "Invite exactly one GitHub user ID or email address.",
        category: "validation",
        retryable: false,
      });
    }
    const response = await this.options.requester.request(
      "POST /orgs/{org}/invitations",
      this.parameters({
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.inviteeId === undefined ? {} : { invitee_id: input.inviteeId }),
        role: input.role,
        ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
      }),
    );
    const invitation = record(response.data);
    if (typeof invitation.id !== "number") {
      throw new CmsError({
        code: "CMS_TEAM_002",
        message: "GitHub did not return an organization invitation.",
        category: "network",
        retryable: true,
      });
    }
    const invitee =
      typeof invitation.invitee === "object" && invitation.invitee !== null
        ? record(invitation.invitee)
        : {};
    return {
      id: String(invitation.id),
      ...(typeof invitation.email === "string" ? { email: invitation.email } : {}),
      ...(typeof invitee.login === "string" ? { login: invitee.login } : {}),
      role: input.role,
      status: "pending",
    };
  }

  async addMemberToTeam(
    input: Parameters<TeamProvisioningPort["addMemberToTeam"]>[0],
  ): Promise<void> {
    await this.options.requester.request(
      "PUT /orgs/{org}/teams/{team_slug}/memberships/{username}",
      this.parameters({
        team_slug: input.teamSlug,
        username: input.username,
        role: input.role,
        ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
      }),
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("Unexpected GitHub response.");
  return value as Record<string, unknown>;
}

function shaFrom(value: unknown): GitCommitSha {
  const sha = record(value).sha;
  if (typeof sha !== "string") throw new Error("GitHub response did not contain a SHA.");
  return sha as GitCommitSha;
}

function stringFrom(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value.replaceAll("\n", "")), (char) => char.charCodeAt(0)),
  );
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

function responseHeader(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) return undefined;
  const response = error.response;
  if (typeof response !== "object" || response === null || !("headers" in response)) {
    return undefined;
  }
  const headers = response.headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const value = (headers as Readonly<Record<string, unknown>>)[name];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

async function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class GitHubGitProvider implements GitProvider {
  private static readonly BLOB_CACHE_LIMIT = 2_048;
  private readonly requester: GitHubRequester;
  private readonly owner: string;
  private readonly repository: string;
  private readonly revertRequests = new Map<string, PullRequest>();
  private readonly blobCache = new Map<string, string>();

  constructor(options: GitHubProviderOptions) {
    this.requester = options.requester;
    this.owner = options.owner;
    this.repository = options.repository;
  }

  private parameters(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return { owner: this.owner, repo: this.repository, ...extra };
  }

  private rememberBlob(sha: string, content: string): void {
    this.blobCache.delete(sha);
    this.blobCache.set(sha, content);
    while (this.blobCache.size > GitHubGitProvider.BLOB_CACHE_LIMIT) {
      const oldest = this.blobCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.blobCache.delete(oldest);
    }
  }

  async resolveRef(ref: string): Promise<GitRef> {
    if (/^[a-f0-9]{40}$/iu.test(ref)) {
      return { name: ref, sha: ref as GitCommitSha };
    }
    const name = normalizeGitRef(ref);
    const response = await this.requester.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      this.parameters({ ref: `heads/${name}` }),
    );
    const object = record(record(response.data).object);
    return { name, sha: shaFrom(object) };
  }

  async listBranches(input: {
    readonly prefix?: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly GitRef[]> {
    const prefix = input.prefix ?? "";
    const response = await this.requester.request(
      "GET /repos/{owner}/{repo}/git/matching-refs/{ref}",
      this.parameters({ ref: `heads/${prefix}` }),
    );
    if (!Array.isArray(response.data)) return [];
    return response.data
      .map((value) => {
        const data = record(value);
        const ref = typeof data.ref === "string" ? data.ref.replace(/^refs\/heads\//u, "") : "";
        const object = record(data.object);
        return ref.length > 0 && typeof object.sha === "string"
          ? { name: ref, sha: object.sha as GitCommitSha }
          : undefined;
      })
      .filter((value): value is GitRef => value !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createBranch(input: {
    readonly branch: string;
    readonly from: GitCommitSha;
  }): Promise<GitRef> {
    const branch = normalizeGitRef(input.branch);
    try {
      return await this.resolveRef(branch);
    } catch {
      const response = await this.requester.request(
        "POST /repos/{owner}/{repo}/git/refs",
        this.parameters({ ref: `refs/heads/${branch}`, sha: input.from }),
      );
      return { name: branch, sha: shaFrom(record(response.data).object) };
    }
  }

  async deleteBranch(input: { readonly branch: string }): Promise<void> {
    await this.requester.request(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      this.parameters({ ref: `heads/${normalizeGitRef(input.branch)}` }),
    );
  }

  async readFile(input: {
    readonly ref: string;
    readonly path: string;
  }): Promise<GitFile | undefined> {
    try {
      const response = await this.requester.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        this.parameters({ path: input.path, ref: input.ref }),
      );
      const data = record(response.data);
      if (data.type !== "file" || typeof data.content !== "string") return undefined;
      return {
        path: input.path,
        content: decodeBase64(data.content),
        ...(typeof data.sha === "string" ? { sha: data.sha as GitCommitSha } : {}),
      };
    } catch (error) {
      if (record(error).status === 404) return undefined;
      throw error;
    }
  }

  async listFiles(input: {
    readonly ref: string;
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly GitFile[]> {
    const ref = await this.resolveRef(input.ref);
    const treeResponse = await this.requester.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      this.parameters({ tree_sha: ref.sha, recursive: "1" }),
    );
    const tree = record(treeResponse.data).tree;
    if (!Array.isArray(tree)) return [];
    const entries = tree
      .map(record)
      .filter(
        (entry) =>
          entry.type === "blob" &&
          typeof entry.path === "string" &&
          typeof entry.sha === "string" &&
          entry.path.startsWith(input.prefix),
      )
      .map((entry) => ({ path: entry.path as string, sha: entry.sha as GitCommitSha }));
    return Promise.all(
      entries.map(async (entry) => {
        let content = this.blobCache.get(entry.sha);
        if (content === undefined) {
          const response = await this.requester.request(
            "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
            this.parameters({
              file_sha: entry.sha,
              ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
            }),
          );
          const data = record(response.data);
          if (typeof data.content !== "string") {
            throw new Error("GitHub blob response did not contain content.");
          }
          content =
            data.encoding === "base64" || data.encoding === undefined
              ? decodeBase64(data.content)
              : data.content;
          this.rememberBlob(entry.sha, content);
        }
        return { path: entry.path, content, sha: entry.sha };
      }),
    );
  }

  async commitFiles(input: Parameters<GitProvider["commitFiles"]>[0]): Promise<GitRef> {
    let current: GitRef | undefined;
    const retryDelays = [0, 100, 250, 500, 1_000, 2_000] as const;
    for (const [index, delay] of retryDelays.entries()) {
      if (delay > 0) await waitFor(delay, input.signal);
      try {
        const observed = await this.resolveRef(input.branch);
        if (observed.sha === input.expectedSha) {
          current = observed;
          break;
        }
      } catch (error) {
        if (statusCode(error) !== 404 || index === retryDelays.length - 1) throw error;
      }
    }
    if (current === undefined) {
      throw new CmsError({
        code: "CMS_GIT_012",
        message: "The Change moved while saving.",
        category: "conflict",
        retryable: true,
      });
    }
    const commitResponse = await this.requester.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      this.parameters({ commit_sha: current.sha }),
    );
    const baseTree = shaFrom(record(commitResponse.data).tree);
    const treeEntries = await Promise.all(
      input.files.map(async (file) => {
        if (file.content === null)
          return { path: file.path, mode: "100644", type: "blob", sha: null };
        const blob = await this.requester.request(
          "POST /repos/{owner}/{repo}/git/blobs",
          this.parameters({ content: file.content, encoding: file.encoding ?? "utf-8" }),
        );
        const blobSha = shaFrom(blob.data);
        this.rememberBlob(
          blobSha,
          file.encoding === "base64" ? decodeBase64(file.content) : file.content,
        );
        return { path: file.path, mode: "100644", type: "blob", sha: blobSha };
      }),
    );
    const tree = await this.requester.request(
      "POST /repos/{owner}/{repo}/git/trees",
      this.parameters({ base_tree: baseTree, tree: treeEntries }),
    );
    const commit = await this.requester.request(
      "POST /repos/{owner}/{repo}/git/commits",
      this.parameters({
        message: input.message,
        tree: shaFrom(tree.data),
        parents: [current.sha],
        author: commitAuthor(input.author),
      }),
    );
    const sha = shaFrom(commit.data);
    await this.requester.request(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      this.parameters({ ref: `heads/${normalizeGitRef(input.branch)}`, sha, force: false }),
    );
    return { name: input.branch, sha };
  }

  async createPullRequest(
    input: Parameters<GitProvider["createPullRequest"]>[0],
  ): Promise<PullRequest> {
    const existing = await this.requester.request(
      "GET /repos/{owner}/{repo}/pulls",
      this.parameters({ head: `${this.owner}:${input.head}`, base: input.base, state: "open" }),
    );
    if (Array.isArray(existing.data) && existing.data.length > 0) {
      return this.pullRequest(existing.data[0]);
    }
    const response = await this.requester.request(
      "POST /repos/{owner}/{repo}/pulls",
      this.parameters({ head: input.head, base: input.base, title: input.title, body: input.body }),
    );
    return this.pullRequest(response.data);
  }

  async createRevertPullRequest(
    input: Parameters<GitProvider["createRevertPullRequest"]>[0],
  ): Promise<PullRequest> {
    const cached = this.revertRequests.get(input.idempotencyKey);
    if (cached !== undefined) return cached;
    const lookup = await this.requester.request("POST /graphql", {
      query: `query CmsPullRequestId($owner: String!, $repository: String!, $number: Int!) {
          repository(owner: $owner, name: $repository) {
            pullRequest(number: $number) { id }
          }
        }`,
      variables: {
        owner: this.owner,
        repository: this.repository,
        number: input.pullRequestNumber,
      },
    });
    const lookupEnvelope = record(lookup.data);
    const lookupData = record(lookupEnvelope.data ?? lookupEnvelope);
    const pullRequestId = record(record(lookupData.repository).pullRequest).id;
    if (typeof pullRequestId !== "string") {
      throw new CmsError({
        code: "CMS_GIT_018",
        message: "The staged Change pull request could not be resolved for reverting.",
        category: "git",
        retryable: false,
      });
    }
    const reverted = await this.requester.request("POST /graphql", {
      query: `mutation CmsRevertPullRequest(
        $pullRequestId: ID!,
        $title: String!,
        $body: String!,
        $clientMutationId: String!
      ) {
        revertPullRequest(input: {
          pullRequestId: $pullRequestId,
          title: $title,
          body: $body,
          draft: false,
          clientMutationId: $clientMutationId
        }) {
          revertPullRequest {
            number
            url
            headRefName
            baseRefName
            state
            merged
          }
        }
      }`,
      variables: {
        pullRequestId,
        title: input.title,
        body: input.body,
        clientMutationId: input.idempotencyKey,
      },
    });
    const revertEnvelope = record(reverted.data);
    const revertData = record(revertEnvelope.data ?? revertEnvelope);
    const pullRequest = record(record(revertData.revertPullRequest).revertPullRequest);
    if (
      typeof pullRequest.number !== "number" ||
      typeof pullRequest.url !== "string" ||
      typeof pullRequest.headRefName !== "string" ||
      typeof pullRequest.baseRefName !== "string"
    ) {
      throw new CmsError({
        code: "CMS_GIT_019",
        message: "GitHub did not create a valid revert pull request.",
        category: "git",
        retryable: true,
      });
    }
    const result: PullRequest = {
      number: pullRequest.number,
      url: pullRequest.url,
      head: pullRequest.headRefName,
      base: pullRequest.baseRefName,
      state:
        pullRequest.merged === true ? "merged" : pullRequest.state === "OPEN" ? "open" : "closed",
    };
    this.revertRequests.set(input.idempotencyKey, result);
    return result;
  }

  private pullRequest(value: unknown): PullRequest {
    const data = record(value);
    if (typeof data.number !== "number" || typeof data.html_url !== "string") {
      throw new Error("Unexpected pull request response.");
    }
    return {
      number: data.number,
      url: data.html_url,
      head: String(record(data.head).ref),
      base: String(record(data.base).ref),
      state: data.merged_at == null ? (data.state === "open" ? "open" : "closed") : "merged",
    };
  }

  async approvePullRequest(input: Parameters<GitProvider["approvePullRequest"]>[0]): Promise<void> {
    try {
      await this.requester.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        this.parameters({ pull_number: input.number, event: "APPROVE", body: input.body ?? "" }),
      );
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { readonly status?: number }).status
          : undefined;
      if (status !== 422) throw error;
      await this.requester.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        this.parameters({
          issue_number: input.number,
          body: [
            `Approval recorded in Git-native CMS by @${input.actor.login}.`,
            input.body ?? "",
            "",
            "<!-- git-native-cms-approval -->",
          ]
            .filter((line) => line.length > 0)
            .join("\n\n"),
        }),
      );
    }
  }

  async mergePullRequest(input: Parameters<GitProvider["mergePullRequest"]>[0]): Promise<GitRef> {
    const response = await this.requester.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      this.parameters({
        pull_number: input.number,
        merge_method: input.strategy,
        sha: input.expectedHeadSha,
      }),
    );
    const data = record(response.data);
    if (data.merged !== true || typeof data.sha !== "string") {
      throw new CmsError({
        code: "CMS_GIT_020",
        message:
          typeof data.message === "string" ? data.message : "GitHub did not merge the Change.",
        category: "git",
        retryable: false,
      });
    }
    return { name: "merged", sha: data.sha as GitCommitSha };
  }
}

export class GitHubReviewPort implements ReviewPort {
  private readonly requester: GitHubRequester;
  private readonly owner: string;
  private readonly repository: string;

  constructor(options: GitHubProviderOptions) {
    this.requester = options.requester;
    this.owner = options.owner;
    this.repository = options.repository;
  }

  private parameters(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    return { owner: this.owner, repo: this.repository, ...extra };
  }

  async addComment(input: Parameters<ReviewPort["addComment"]>[0]): Promise<ReviewComment> {
    const location =
      input.path === undefined
        ? ""
        : `\n\n<!-- cms-location:${input.path}${input.line === undefined ? "" : `:${input.line}`} -->`;
    const response = await this.requester.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      this.parameters({
        issue_number: input.pullRequestNumber,
        body: `${input.body}${location}`,
      }),
    );
    return this.comment(response.data);
  }

  async listComments(pullRequestNumber: number): Promise<readonly ReviewComment[]> {
    const response = await this.requester.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      this.parameters({ issue_number: pullRequestNumber, per_page: 100 }),
    );
    return Array.isArray(response.data) ? response.data.map((value) => this.comment(value)) : [];
  }

  async resolveComment(input: Parameters<ReviewPort["resolveComment"]>[0]): Promise<ReviewComment> {
    const existing = await this.requester.request(
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}",
      this.parameters({ comment_id: Number(input.commentId) || input.commentId }),
    );
    const data = record(existing.data);
    const body = stringFrom(data.body, "");
    const resolutionMarker = "<!-- cms-resolved -->";
    const nextBody = input.resolved
      ? body.includes(resolutionMarker)
        ? body
        : `${body}\n\n${resolutionMarker}`
      : body.replace(/\n*<!-- cms-resolved -->/gu, "");
    const response = await this.requester.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      this.parameters({
        comment_id: Number(input.commentId) || input.commentId,
        body: nextBody,
      }),
    );
    return this.comment(response.data);
  }

  async assignReviewers(
    input: Parameters<ReviewPort["assignReviewers"]>[0],
  ): Promise<Awaited<ReturnType<ReviewPort["assignReviewers"]>>> {
    await this.requester.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      this.parameters({
        pull_number: input.pullRequestNumber,
        reviewers: [...new Set(input.users)].sort(),
        team_reviewers: [...new Set(input.teams)].sort(),
      }),
    );
    return {
      users: [...new Set(input.users)].sort(),
      teams: [...new Set(input.teams)].sort(),
    };
  }

  async listReviewers(
    pullRequestNumber: number,
  ): Promise<Awaited<ReturnType<ReviewPort["listReviewers"]>>> {
    const response = await this.requester.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      this.parameters({ pull_number: pullRequestNumber }),
    );
    const data = record(response.data);
    const requestedReviewers = Array.isArray(data.requested_reviewers)
      ? data.requested_reviewers
      : [];
    const requestedTeams = Array.isArray(data.requested_teams) ? data.requested_teams : [];
    return {
      users: requestedReviewers
        .map((value) => record(value).login)
        .filter((value): value is string => typeof value === "string")
        .sort(),
      teams: requestedTeams
        .map((value) => record(value).slug)
        .filter((value): value is string => typeof value === "string")
        .sort(),
    };
  }

  async listChecks(ref: GitCommitSha): Promise<readonly ReviewCheck[]> {
    const response = await this.requester.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      this.parameters({ ref, per_page: 100 }),
    );
    const runs = record(response.data).check_runs;
    if (!Array.isArray(runs)) return [];
    return runs.map((value) => {
      const check = record(value);
      const status =
        check.status === "queued" || check.status === "in_progress" ? check.status : "completed";
      const allowedConclusions = ["success", "failure", "cancelled", "skipped", "neutral"];
      const conclusion =
        typeof check.conclusion === "string" && allowedConclusions.includes(check.conclusion)
          ? (check.conclusion as ReviewCheck["conclusion"])
          : undefined;
      return {
        name: stringFrom(check.name, "GitHub check"),
        status,
        ...(conclusion === undefined ? {} : { conclusion }),
        required: true,
        ...(typeof check.html_url === "string" ? { url: check.html_url } : {}),
      };
    });
  }

  private comment(value: unknown): ReviewComment {
    const data = record(value);
    const user = record(data.user);
    const sourceBody = stringFrom(data.body, "");
    const location = /<!-- cms-location:([^:\n]+)(?::(\d+))? -->/u.exec(sourceBody);
    return {
      id: String(data.id),
      author: stringFrom(user.login, "unknown"),
      body: sourceBody
        .replace(/\n*<!-- cms-location:[^>]+ -->/gu, "")
        .replace(/\n*<!-- cms-resolved -->/gu, "")
        .trim(),
      ...(location?.[1] === undefined ? {} : { path: location[1] }),
      ...(location?.[2] === undefined ? {} : { line: Number(location[2]) }),
      createdAt: stringFrom(data.created_at, new Date(0).toISOString()),
      resolved: sourceBody.includes("<!-- cms-resolved -->"),
    };
  }
}
