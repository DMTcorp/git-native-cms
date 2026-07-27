import type { Actor, ActorId } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { buildChangeBranchName, normalizeGitRef } from "./index.js";

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
});
