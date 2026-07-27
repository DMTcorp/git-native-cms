import { contractPassed, GitProviderContract } from "@git-native-cms/adapter-kit";
import type { Actor } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { GitHubGitProvider, type GitHubRequester } from "./index.js";

interface FixtureCommit {
  readonly tree: string;
}

class GitHubFixtureRequester implements GitHubRequester {
  private sequence = 1;
  private readonly refs = new Map([["main", "a".repeat(40)]]);
  private readonly commits = new Map<string, FixtureCommit>([["a".repeat(40), { tree: "tree-1" }]]);
  private readonly trees = new Map<string, Map<string, string>>([["tree-1", new Map()]]);
  private readonly blobs = new Map<string, string>();
  private readonly pullRequests: Record<string, unknown>[] = [];

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
      this.refs.set(this.branch(parameters), String(parameters.sha));
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
    throw new Error(`Unhandled fixture route: ${route}`);
  }
}

describe("GitHub Git Data adapter contract", () => {
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
