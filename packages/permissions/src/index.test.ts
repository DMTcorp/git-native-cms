import type { Actor, ActorId, RoleName } from "@git-native-cms/core";
import { describe, expect, it } from "vitest";
import {
  AuthorizationService,
  effectiveRoles,
  parsePermissionConfiguration,
} from "./index.js";

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

  it("maps GitHub teams and enforces content-type and field restrictions", () => {
    expect(
      effectiveRoles(
        ["viewer"],
        ["content-editors"],
        [
          { team: "content-editors", roles: ["editor"] },
          { team: "publishers", roles: ["publisher"] },
        ],
      ),
    ).toEqual(["viewer", "editor"]);
    const service = new AuthorizationService();
    expect(
      service.explain(actor, "change.edit", {
        contentType: "settings",
        field: "apiKey",
        policy: {
          contentTypes: { allow: ["pages", "settings"] },
          fields: { deny: ["apiKey"] },
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "The resource policy does not allow field apiKey.",
    });
  });

  it("supports project-defined custom roles without changing application handlers", () => {
    const campaignPublisher = "campaign-publisher" as RoleName;
    const service = new AuthorizationService([
      {
        name: campaignPublisher,
        actions: ["project.read", "change.review", "staging.publish"],
      },
    ]);
    const customActor: Actor = { ...actor, roles: [campaignPublisher] };

    expect(service.explain(customActor, "staging.publish")).toMatchObject({
      allowed: true,
      matchedRoles: [campaignPublisher],
    });
    expect(service.explain(customActor, "release.rollback").allowed).toBe(false);
  });

  it("parses audited team mappings and custom role actions from Git", () => {
    const configuration = parsePermissionConfiguration({
      version: 1,
      mappings: [{ team: "DMTcorp/campaign", roles: ["campaign-publisher"] }],
      customRoles: [
        {
          name: "campaign-publisher",
          actions: ["project.read", "change.approve", "staging.publish"],
        },
      ],
    });
    expect(configuration).toEqual({
      mappings: [{ team: "DMTcorp/campaign", roles: ["campaign-publisher"] }],
      customRoles: [
        {
          name: "campaign-publisher",
          actions: ["project.read", "change.approve", "staging.publish"],
        },
      ],
    });
    expect(
      new AuthorizationService(configuration.customRoles).explain(
        { ...actor, roles: configuration.customRoles.map((role) => role.name) },
        "staging.publish",
      ).allowed,
    ).toBe(true);
    expect(() =>
      parsePermissionConfiguration({
        customRoles: [{ name: "unsafe", actions: ["release.delete-everything"] }],
      }),
    ).toThrow("valid CMS actions");
  });
});
