import { isoTimestamp, type Actor, type ActorId } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import type { Change, ChangeId, GitCommitSha } from "@git-native-cms/core";
import { buildChangeBranchName, commitAuthor, normalizeGitRef, planChangeMerge } from "./index.js";

const actor: Actor = {
  id: "actor_1" as ActorId,
  githubId: 1,
  login: "Ada Lovelace",
  displayName: "Ada",
  roles: ["author"],
  source: "ui",
};

describe("git helpers", () => {
  it("builds safe user-facing Change refs", () => {
    expect(buildChangeBranchName({ actor, name: "Pricing refresh!", suffix: "01KABC" })).toBe(
      "cms/ada-lovelace/pricing-refresh-01kabc",
    );
  });

  it("rejects ambiguous refs", () => {
    expect(() => normalizeGitRef("../main")).toThrow();
  });

  it("plans normal and Emergency Change merges without leaking Git details into callers", () => {
    const change = {
      id: "chg_test" as ChangeId,
      name: "Critical correction",
      ownerId: actor.id,
      baseBranch: "main",
      baseCommit: "a".repeat(40) as GitCommitSha,
      branchName: "hotfix/ada/critical-0001",
      status: "approved",
      emergency: true,
      createdAt: isoTimestamp(new Date("2026-07-27T12:00:00.000Z")),
      updatedAt: isoTimestamp(new Date("2026-07-27T12:00:00.000Z")),
    } satisfies Change;
    expect(planChangeMerge(change)).toEqual({
      head: change.branchName,
      base: "main",
      strategy: "squash",
      deleteBranch: true,
      forwardSyncRequired: true,
    });
    expect(commitAuthor(actor)).toEqual({
      name: "Ada",
      email: "1+ada-lovelace@users.noreply.github.com",
    });
  });
});
