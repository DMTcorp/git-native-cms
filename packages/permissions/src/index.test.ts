import type { Actor, ActorId } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import { AuthorizationService } from "./index.js";

const actor: Actor = {
  id: "actor_1" as ActorId,
  githubId: 1,
  login: "editor",
  displayName: "Editor",
  roles: ["editor"],
  source: "ui",
};

describe("permissions", () => {
  it("calculates effective permissions and explains denial", () => {
    const service = new AuthorizationService();
    expect(service.explain(actor, "change.edit").allowed).toBe(true);
    expect(service.explain(actor, "staging.publish")).toMatchObject({
      allowed: false,
      reason: "None of the actor's roles grants this action.",
    });
  });
});
