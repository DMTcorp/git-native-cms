import {
  contractPassed,
  GitProviderContract,
  ReviewPortContract,
} from "@git-native-cms/adapter-kit";
import type { Actor, GitCommitSha } from "@git-native-cms/core";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubGitProvider,
  GitHubIdentityProvider,
  GitHubReviewPort,
  GitHubTeamProvisioning,
  withGitHubErrorNormalization,
  type GitHubRequester,
} from "./index.js";

interface FixtureCommit {
  readonly tree: string;
}

describe("GitHub request errors", () => {
  it("exposes installation rate limits as retryable Git errors", async () => {
    const reset = 1_788_290_400;
    const requester = withGitHubErrorNormalization({
      async request() {
        throw Object.assign(new Error("API rate limit exceeded for installation ID 149379007."), {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset),
            },
          },
        });
      },
    });

    await expect(requester.request("GET /rate_limit", {})).rejects.toMatchObject({
      code: "CMS_GITHUB_429",
      category: "git",
      retryable: true,
      context: { resetAt: new Date(reset * 1_000).toISOString() },
    });
  });
});

class GitHubFixtureRequester implements GitHubRequester {
  private sequence = 1;
  private readonly refs = new Map([["main", "a".repeat(40)]]);
  private readonly commits = new Map<string, FixtureCommit>([["a".repeat(40), { tree: "tree-1" }]]);
  private readonly trees = new Map<string, Map<string, string>>([["tree-1", new Map()]]);
  private readonly blobs = new Map<string, string>();
  private readonly pullRequests: Record<string, unknown>[] = [];
  private readonly mergedBefore = new Map<number, string>();
  private readonly hiddenRefReads = new Map<string, number>();
  private readonly staleRefReads = new Map<
    string,
    { readonly sha: string; readonly remaining: number }
  >();

  constructor(
    private readonly visibilityLagReads = 0,
    private readonly staleAfterPatchReads = 0,
  ) {}

  private next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private branch(parameters: Readonly<Record<string, unknown>>): string {
    const ref = typeof parameters.ref === "string" ? parameters.ref : "";
    return ref.replace(/^refs\/heads\/|^heads\//u, "");
  }

  async request(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly data: unknown }> {
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const name = this.branch(parameters);
      const hiddenReads = this.hiddenRefReads.get(name) ?? 0;
      if (hiddenReads > 0) {
        this.hiddenRefReads.set(name, hiddenReads - 1);
        throw { status: 404 };
      }
      const stale = this.staleRefReads.get(name);
      if (stale !== undefined && stale.remaining > 0) {
        this.staleRefReads.set(name, { ...stale, remaining: stale.remaining - 1 });
        return { data: { ref: `refs/heads/${name}`, object: { sha: stale.sha } } };
      }
      const sha = this.refs.get(name);
      if (sha === undefined) throw { status: 404 };
      return { data: { ref: `refs/heads/${name}`, object: { sha } } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/matching-refs/{ref}") {
      const prefix = this.branch(parameters);
      return {
        data: [...this.refs.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha } })),
      };
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") {
      const name = this.branch(parameters);
      this.refs.set(name, String(parameters.sha));
      this.hiddenRefReads.set(name, this.visibilityLagReads);
      return { data: { ref: `refs/heads/${name}`, object: { sha: parameters.sha } } };
    }
    if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}") {
      this.refs.delete(this.branch(parameters));
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
      const sha = String(parameters.commit_sha);
      const commit = this.commits.get(sha);
      if (commit === undefined) throw { status: 404 };
      return { data: { sha, tree: { sha: commit.tree } } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/blobs") {
      const sha = this.next("blob");
      this.blobs.set(sha, String(parameters.content));
      return { data: { sha } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/trees") {
      const base = this.trees.get(String(parameters.base_tree)) ?? new Map<string, string>();
      const next = new Map(base);
      for (const entry of parameters.tree as {
        readonly path: string;
        readonly sha: string | null;
      }[]) {
        if (entry.sha === null) next.delete(entry.path);
        else next.set(entry.path, entry.sha);
      }
      const sha = this.next("tree");
      this.trees.set(sha, next);
      return { data: { sha } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/commits") {
      const sha = this.sequence.toString(16).padStart(40, "0");
      this.sequence += 1;
      this.commits.set(sha, { tree: String(parameters.tree) });
      return { data: { sha } };
    }
    if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
      const name = this.branch(parameters);
      const previous = this.refs.get(name);
      this.refs.set(name, String(parameters.sha));
      if (previous !== undefined && this.staleAfterPatchReads > 0) {
        this.staleRefReads.set(name, {
          sha: previous,
          remaining: this.staleAfterPatchReads,
        });
      }
      return { data: { object: { sha: parameters.sha } } };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      const ref = String(parameters.ref);
      const commitSha = this.refs.get(ref) ?? ref;
      const commit = this.commits.get(commitSha);
      const blobSha =
        commit === undefined
          ? undefined
          : this.trees.get(commit.tree)?.get(String(parameters.path));
      const content = blobSha === undefined ? undefined : this.blobs.get(blobSha);
      if (content === undefined) throw { status: 404 };
      return { data: { type: "file", sha: blobSha, content: btoa(content) } };
    }
    if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
      const commit = this.commits.get(String(parameters.tree_sha));
      const tree = commit === undefined ? undefined : this.trees.get(commit.tree);
      return {
        data: {
          tree: [...(tree ?? new Map<string, string>()).entries()].map(([path, sha]) => ({
            type: "blob",
            path,
            sha,
          })),
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls") {
      return {
        data: this.pullRequests.filter(
          (pullRequest) =>
            (pullRequest.head as { ref: string }).ref ===
              String(parameters.head).split(":").at(-1) &&
            (pullRequest.base as { ref: string }).ref === parameters.base,
        ),
      };
    }
    if (route === "POST /repos/{owner}/{repo}/pulls") {
      const pullRequest = {
        number: this.pullRequests.length + 1,
        html_url: `https://github.example.test/pull/${this.pullRequests.length + 1}`,
        state: "open",
        merged_at: null,
        head: { ref: parameters.head },
        base: { ref: parameters.base },
      };
      this.pullRequests.push(pullRequest);
      return { data: pullRequest };
    }
    if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
      const pullRequest = this.pullRequests.find(
        (candidate) => candidate.number === parameters.pull_number,
      );
      if (pullRequest === undefined) throw { status: 404 };
      const head = (pullRequest.head as { ref: string }).ref;
      const base = (pullRequest.base as { ref: string }).ref;
      const headSha = this.refs.get(head);
      const baseSha = this.refs.get(base);
      if (headSha === undefined || baseSha === undefined || headSha !== parameters.sha) {
        return { data: { merged: false, message: "Head changed." } };
      }
      this.mergedBefore.set(Number(pullRequest.number), baseSha);
      this.refs.set(base, headSha);
      pullRequest.state = "closed";
      pullRequest.merged_at = new Date(0).toISOString();
      return { data: { merged: true, sha: headSha } };
    }
    if (route === "POST /graphql") {
      const query = String(parameters.query);
      const variables = parameters.variables as Readonly<Record<string, unknown>>;
      if (query.includes("query CmsPullRequestId")) {
        const number = Number(variables.number);
        const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
        return {
          data: {
            data: {
              repository: {
                pullRequest: pullRequest === undefined ? null : { id: `PR_${String(number)}` },
              },
            },
          },
        };
      }
      if (query.includes("mutation CmsRevertPullRequest")) {
        const originalNumber = Number(String(variables.pullRequestId).replace("PR_", ""));
        const original = this.pullRequests.find((candidate) => candidate.number === originalNumber);
        const before = this.mergedBefore.get(originalNumber);
        if (original === undefined || before === undefined) throw { status: 422 };
        const base = (original.base as { ref: string }).ref;
        const branch = `revert-${String(originalNumber)}`;
        this.refs.set(branch, before);
        const number = this.pullRequests.length + 1;
        const pullRequest = {
          number,
          html_url: `https://github.example.test/pull/${String(number)}`,
          state: "open",
          merged_at: null,
          head: { ref: branch },
          base: { ref: base },
        };
        this.pullRequests.push(pullRequest);
        return {
          data: {
            data: {
              revertPullRequest: {
                revertPullRequest: {
                  number,
                  url: pullRequest.html_url,
                  headRefName: branch,
                  baseRefName: base,
                  state: "OPEN",
                  merged: false,
                },
              },
            },
          },
        };
      }
    }
    throw new Error(`Unhandled fixture route: ${route}`);
  }
}

describe("GitHub Git Data adapter contract", () => {
  it("uses the create-ref response without waiting for the new branch to become readable", async () => {
    const routes: string[] = [];
    const sha = "b".repeat(40);
    const requester: GitHubRequester = {
      async request(route) {
        routes.push(route);
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
          throw { status: 404 };
        }
        if (route === "POST /repos/{owner}/{repo}/git/refs") {
          return {
            data: {
              ref: "refs/heads/rollback/eventually-consistent",
              object: { sha },
            },
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const provider = new GitHubGitProvider({
      requester,
      owner: "DMTcorp",
      repository: "fixture",
    });

    await expect(
      provider.createBranch({
        branch: "rollback/eventually-consistent",
        from: sha as GitCommitSha,
      }),
    ).resolves.toEqual({
      name: "rollback/eventually-consistent",
      sha,
    });
    expect(routes).toEqual([
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "POST /repos/{owner}/{repo}/git/refs",
    ]);
  });

  it("retries the exact-SHA check while a fresh branch is propagating", async () => {
    const actor: Actor = {
      id: "act_github_retry" as Actor["id"],
      githubId: 43,
      login: "retry",
      displayName: "Retry Fixture",
      roles: ["administrator"],
      source: "cli",
    };
    const provider = new GitHubGitProvider({
      requester: new GitHubFixtureRequester(2),
      owner: "DMTcorp",
      repository: "fixture",
    });
    const created = await provider.createBranch({
      branch: "rollback/eventually-readable",
      from: "a".repeat(40) as GitCommitSha,
    });

    await expect(
      provider.commitFiles({
        branch: created.name,
        expectedSha: created.sha,
        files: [{ path: ".cms/rollback.yaml", content: "releaseId: rel_fixture\n" }],
        message: "Record rollback",
        author: actor,
        idempotencyKey: "rollback:fixture",
      }),
    ).resolves.toMatchObject({
      name: "rollback/eventually-readable",
    });
  });

  it("retries the exact-SHA check while an updated ref still reads as its parent", async () => {
    const actor: Actor = {
      id: "act_github_stale_ref" as Actor["id"],
      githubId: 44,
      login: "stale-ref",
      displayName: "Stale Ref Fixture",
      roles: ["administrator"],
      source: "cli",
    };
    const provider = new GitHubGitProvider({
      requester: new GitHubFixtureRequester(0, 2),
      owner: "DMTcorp",
      repository: "fixture",
    });
    const created = await provider.createBranch({
      branch: "change/eventually-updated",
      from: "a".repeat(40) as GitCommitSha,
    });
    const first = await provider.commitFiles({
      branch: created.name,
      expectedSha: created.sha,
      files: [{ path: "content/first.yaml", content: "title: First\n" }],
      message: "First write",
      author: actor,
      idempotencyKey: "stale-ref:first",
    });

    await expect(
      provider.commitFiles({
        branch: created.name,
        expectedSha: first.sha,
        files: [{ path: ".cms/change.yaml", content: "status: draft\n" }],
        message: "Follow-up metadata",
        author: actor,
        idempotencyKey: "stale-ref:metadata",
      }),
    ).resolves.toMatchObject({
      name: created.name,
    });
  });

  it("passes the shared GitProvider contract against recorded response shapes", async () => {
    const actor: Actor = {
      id: "act_github_fixture" as Actor["id"],
      githubId: 42,
      login: "fixture",
      displayName: "GitHub Fixture",
      roles: ["administrator"],
      source: "cli",
    };
    const results = await GitProviderContract({
      provider: new GitHubGitProvider({
        requester: new GitHubFixtureRequester(),
        owner: "DMTcorp",
        repository: "fixture",
      }),
      baseRef: "main",
      branch: "contract/github",
      actor,
    });
    expect(
      contractPassed(results),
      results
        .filter((result) => !result.passed)
        .map((result) => `${result.name}: ${result.details ?? "failed"}`)
        .join("\n"),
    ).toBe(true);
  });
});

describe("GitHub review adapter contract", () => {
  it("persists comments, resolved markers, reviewer assignment and checks", async () => {
    const comments: Record<string, unknown>[] = [];
    let requestedUsers: string[] = [];
    let requestedTeams: string[] = [];
    const requester: GitHubRequester = {
      async request(route, parameters) {
        if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
          const comment = {
            id: comments.length + 1,
            body: parameters.body,
            created_at: "2026-07-27T12:00:00.000Z",
            user: { login: "contract-reviewer" },
          };
          comments.push(comment);
          return { data: comment };
        }
        if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
          return { data: comments };
        }
        if (route === "GET /repos/{owner}/{repo}/issues/comments/{comment_id}") {
          return {
            data: comments.find((comment) => String(comment.id) === String(parameters.comment_id)),
          };
        }
        if (route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}") {
          const index = comments.findIndex(
            (comment) => String(comment.id) === String(parameters.comment_id),
          );
          const current = comments[index];
          if (current === undefined) throw new Error("comment missing");
          const updated = { ...current, body: parameters.body };
          comments[index] = updated;
          return { data: updated };
        }
        if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") {
          requestedUsers = parameters.reviewers as string[];
          requestedTeams = parameters.team_reviewers as string[];
          return { data: {} };
        }
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              requested_reviewers: requestedUsers.map((login) => ({ login })),
              requested_teams: requestedTeams.map((slug) => ({ slug })),
            },
          };
        }
        if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
          return {
            data: {
              check_runs: [
                {
                  name: "cms-contract",
                  status: "completed",
                  conclusion: "success",
                  html_url: "https://github.example.test/checks/1",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      },
    };
    const results = await ReviewPortContract({
      review: new GitHubReviewPort({
        requester,
        owner: "DMTcorp",
        repository: "fixture",
      }),
      pullRequestNumber: 1,
      ref: "a".repeat(40) as GitCommitSha,
    });
    expect(
      contractPassed(results),
      results
        .filter((result) => !result.passed)
        .map((result) => `${result.name}: ${result.details ?? "failed"}`)
        .join("\n"),
    ).toBe(true);
    expect(String(comments[0]?.body)).toContain("<!-- cms-resolved -->");
  });
});

describe("GitHub user identity adapter", () => {
  it("uses the Enterprise API base URL and resolves repository capabilities plus teams", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/user")) {
        return Response.json({ id: 42, login: "ada", name: "Ada Lovelace" });
      }
      if (url.includes("/repos/DMTcorp/content")) {
        return Response.json({ permissions: { push: true, maintain: false } });
      }
      if (url.includes("/user/teams")) {
        return Response.json([
          { slug: "editors", organization: { login: "DMTcorp" } },
          { slug: "external", organization: { login: "OtherOrg" } },
        ]);
      }
      return new Response(null, { status: 404 });
    });
    const provider = new GitHubIdentityProvider({
      owner: "DMTcorp",
      repository: "content",
      baseUrl: "https://github.enterprise.test/api/v3",
      fetch: fetcher,
    });

    await expect(provider.resolve("user-token")).resolves.toEqual({
      externalId: "42",
      login: "ada",
      displayName: "Ada Lovelace",
      capabilities: { push: true, maintain: false },
      teams: ["DMTcorp/editors"],
    });
    expect(
      fetcher.mock.calls.every(([request]) => {
        const url =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url;
        return url.startsWith("https://github.enterprise.test/api/v3/");
      }),
    ).toBe(true);
  });
});

describe("GitHub organization provisioning adapter", () => {
  it("lists members and teams, sends invitations, and assigns team membership", async () => {
    const calls: {
      readonly route: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    }[] = [];
    const requester: GitHubRequester = {
      async request(route, parameters) {
        calls.push({ route, parameters });
        if (route === "GET /orgs/{org}/members") {
          return { data: [{ id: 42, login: "ada", avatar_url: "https://avatars.test/42" }] };
        }
        if (route === "GET /orgs/{org}/memberships/{username}") {
          return { data: { role: "admin", state: "active" } };
        }
        if (route === "GET /orgs/{org}/teams") {
          return {
            data: [{ id: 7, slug: "editors", name: "Editors", description: "CMS editors" }],
          };
        }
        if (route === "POST /orgs/{org}/invitations") {
          return { data: { id: 99, email: parameters.email } };
        }
        if (route === "PUT /orgs/{org}/teams/{team_slug}/memberships/{username}") {
          return { data: { state: "active", role: parameters.role } };
        }
        throw new Error(`Unexpected route ${route}`);
      },
    };
    const provisioning = new GitHubTeamProvisioning({
      requester,
      organization: "DMTcorp",
    });
    await expect(provisioning.listMembers()).resolves.toEqual([
      {
        id: "42",
        login: "ada",
        displayName: "ada",
        avatarUrl: "https://avatars.test/42",
        organizationRole: "admin",
      },
    ]);
    await expect(provisioning.listTeams()).resolves.toEqual([
      { id: "7", slug: "editors", name: "Editors", description: "CMS editors" },
    ]);
    await expect(
      provisioning.invite({ email: "grace@example.test", role: "direct_member" }),
    ).resolves.toMatchObject({
      id: "99",
      email: "grace@example.test",
      status: "pending",
    });
    await provisioning.addMemberToTeam({
      teamSlug: "editors",
      username: "grace",
      role: "member",
    });
    expect(calls.at(-1)).toMatchObject({
      route: "PUT /orgs/{org}/teams/{team_slug}/memberships/{username}",
      parameters: {
        org: "DMTcorp",
        team_slug: "editors",
        username: "grace",
        role: "member",
      },
    });
  });
});
