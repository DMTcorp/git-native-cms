import type {
  GitFile,
  GitProvider,
  GitRef,
  PullRequest,
  ReviewCheck,
  ReviewComment,
  ReviewPort,
} from "@git-native-cms/application";
import { CmsError, type GitCommitSha } from "@git-native-cms/core";
import { normalizeGitRef } from "@git-native-cms/git";
import { App } from "@octokit/app";

export interface GitHubRequester {
  request(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly data: unknown }>;
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
}): Promise<GitHubRequester> {
  const app = new App({ appId: input.appId, privateKey: input.privateKey });
  const octokit = await app.getInstallationOctokit(input.installationId);
  return {
    request: (route, parameters) => octokit.request(route as never, parameters as never),
  };
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

export class GitHubGitProvider implements GitProvider {
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

  async resolveRef(ref: string): Promise<GitRef> {
    const name = normalizeGitRef(ref);
    const response = await this.requester.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      this.parameters({ ref: `heads/${name}` }),
    );
    const object = record(record(response.data).object);
    return { name, sha: shaFrom(object) };
  }

  async createBranch(input: {
    readonly branch: string;
    readonly from: GitCommitSha;
  }): Promise<GitRef> {
    const branch = normalizeGitRef(input.branch);
    try {
      return await this.resolveRef(branch);
    } catch {
      await this.requester.request(
        "POST /repos/{owner}/{repo}/git/refs",
        this.parameters({ ref: `refs/heads/${branch}`, sha: input.from }),
      );
      return this.resolveRef(branch);
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
  }): Promise<readonly GitFile[]> {
    const ref = await this.resolveRef(input.ref);
    const treeResponse = await this.requester.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      this.parameters({ tree_sha: ref.sha, recursive: "1" }),
    );
    const tree = record(treeResponse.data).tree;
    if (!Array.isArray(tree)) return [];
    const paths = tree
      .map(record)
      .filter(
        (entry) =>
          entry.type === "blob" &&
          typeof entry.path === "string" &&
          entry.path.startsWith(input.prefix),
      )
      .map((entry) => entry.path as string);
    const files = await Promise.all(paths.map((path) => this.readFile({ ref: input.ref, path })));
    return files.filter((file): file is GitFile => file !== undefined);
  }

  async commitFiles(input: Parameters<GitProvider["commitFiles"]>[0]): Promise<GitRef> {
    const current = await this.resolveRef(input.branch);
    if (current.sha !== input.expectedSha) {
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
          this.parameters({ content: file.content, encoding: "utf-8" }),
        );
        return { path: file.path, mode: "100644", type: "blob", sha: shaFrom(blob.data) };
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
        author: {
          name: input.author.displayName,
          email: `${input.author.githubId}+${input.author.login}@users.noreply.github.com`,
        },
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
    await this.requester.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      this.parameters({ pull_number: input.number, event: "APPROVE", body: input.body ?? "" }),
    );
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
    return {
      id: String(data.id),
      author: stringFrom(user.login, "unknown"),
      body: stringFrom(data.body, ""),
      createdAt: stringFrom(data.created_at, new Date(0).toISOString()),
    };
  }
}
