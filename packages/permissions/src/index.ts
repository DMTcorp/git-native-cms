import { CmsError, type Actor, type RoleName } from "@git-native-cms/core";

export type CmsAction =
  | "project.read"
  | "change.create"
  | "change.edit"
  | "change.submit"
  | "change.review"
  | "change.approve"
  | "staging.add"
  | "staging.publish"
  | "release.rollback"
  | "asset.upload"
  | "asset.delete"
  | "team.manage"
  | "settings.technical";

const ROLE_ACTIONS: Readonly<Record<string, ReadonlySet<CmsAction>>> = {
  viewer: new Set(["project.read"]),
  author: new Set([
    "project.read",
    "change.create",
    "change.edit",
    "change.submit",
    "asset.upload",
  ]),
  editor: new Set([
    "project.read",
    "change.create",
    "change.edit",
    "change.submit",
    "change.review",
    "asset.upload",
  ]),
  translator: new Set(["project.read", "change.create", "change.edit", "change.submit"]),
  reviewer: new Set(["project.read", "change.review", "change.approve"]),
  publisher: new Set([
    "project.read",
    "change.review",
    "change.approve",
    "staging.add",
    "staging.publish",
    "release.rollback",
  ]),
  developer: new Set([
    "project.read",
    "change.create",
    "change.edit",
    "change.submit",
    "asset.upload",
    "asset.delete",
    "settings.technical",
  ]),
  administrator: new Set([
    "project.read",
    "change.create",
    "change.edit",
    "change.submit",
    "change.review",
    "change.approve",
    "staging.add",
    "staging.publish",
    "release.rollback",
    "asset.upload",
    "asset.delete",
    "team.manage",
    "settings.technical",
  ]),
};

export interface ResourcePolicy {
  readonly allow?: readonly CmsAction[];
  readonly deny?: readonly CmsAction[];
  readonly ownerOnly?: readonly CmsAction[];
}

export interface PermissionExplanation {
  readonly allowed: boolean;
  readonly action: CmsAction;
  readonly reason: string;
  readonly matchedRoles: readonly RoleName[];
}

export class AuthorizationService {
  explain(
    actor: Actor,
    action: CmsAction,
    options: { readonly policy?: ResourcePolicy; readonly ownerId?: string } = {},
  ): PermissionExplanation {
    const matchedRoles = actor.roles.filter((role) => ROLE_ACTIONS[String(role)]?.has(action));
    if (options.policy?.deny?.includes(action) === true) {
      return {
        allowed: false,
        action,
        reason: "The resource policy denies this action.",
        matchedRoles,
      };
    }
    if (
      options.policy?.ownerOnly?.includes(action) === true &&
      options.ownerId !== undefined &&
      actor.id !== options.ownerId
    ) {
      return {
        allowed: false,
        action,
        reason: "Only the Change owner can perform this action.",
        matchedRoles,
      };
    }
    const allowedByRole = matchedRoles.length > 0;
    const allowedByPolicy = options.policy?.allow?.includes(action) ?? true;
    return {
      allowed: allowedByRole && allowedByPolicy,
      action,
      reason: allowedByRole
        ? allowedByPolicy
          ? "Allowed by the actor's effective role."
          : "The resource policy does not allow this action."
        : "None of the actor's roles grants this action.",
      matchedRoles,
    };
  }

  assert(
    actor: Actor,
    action: CmsAction,
    options: { readonly policy?: ResourcePolicy; readonly ownerId?: string } = {},
  ): void {
    const explanation = this.explain(actor, action, options);
    if (!explanation.allowed) {
      throw new CmsError({
        code: "CMS_PERMISSION_004",
        message: explanation.reason,
        category: "authorization",
        retryable: false,
        context: { action, actorId: actor.id },
      });
    }
  }
}
