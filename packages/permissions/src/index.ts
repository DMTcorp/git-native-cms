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
  | "asset.edit"
  | "asset.delete"
  | "team.manage"
  | "settings.technical";

export const CMS_ACTIONS: readonly CmsAction[] = [
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
  "asset.edit",
  "asset.delete",
  "team.manage",
  "settings.technical",
];

export function isCmsAction(value: unknown): value is CmsAction {
  return typeof value === "string" && CMS_ACTIONS.includes(value as CmsAction);
}

const ROLE_ACTIONS: Readonly<Record<string, ReadonlySet<CmsAction>>> = {
  viewer: new Set(["project.read"]),
  author: new Set([
    "project.read",
    "change.create",
    "change.edit",
    "change.submit",
    "asset.upload",
    "asset.edit",
  ]),
  editor: new Set([
    "project.read",
    "change.create",
    "change.edit",
    "change.submit",
    "change.review",
    "asset.upload",
    "asset.edit",
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
    "asset.edit",
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
    "asset.edit",
    "asset.delete",
    "team.manage",
    "settings.technical",
  ]),
};

export interface CustomRoleDefinition {
  readonly name: RoleName;
  readonly actions: readonly CmsAction[];
}

export interface ResourcePolicy {
  readonly allow?: readonly CmsAction[];
  readonly deny?: readonly CmsAction[];
  readonly ownerOnly?: readonly CmsAction[];
  readonly contentTypes?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly fields?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

export interface TeamRoleMapping {
  readonly team: string;
  readonly roles: readonly RoleName[];
}

export interface PermissionConfiguration {
  readonly mappings: readonly TeamRoleMapping[];
  readonly customRoles: readonly CustomRoleDefinition[];
}

export function parsePermissionConfiguration(value: unknown): PermissionConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CmsError({
      code: "CMS_PERMISSION_001",
      message: "Permissions configuration must be an object.",
      category: "validation",
      retryable: false,
    });
  }
  const record = value as Readonly<Record<string, unknown>>;
  const mappingsValue = record.mappings ?? [];
  const customRolesValue = record.customRoles ?? [];
  if (!Array.isArray(mappingsValue) || !Array.isArray(customRolesValue)) {
    throw new CmsError({
      code: "CMS_PERMISSION_001",
      message: "Permission mappings and customRoles must be arrays.",
      category: "validation",
      retryable: false,
    });
  }
  const mappings = mappingsValue.map((entry): TeamRoleMapping => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CmsError({
        code: "CMS_PERMISSION_002",
        message: "Each permission mapping must be an object.",
        category: "validation",
        retryable: false,
      });
    }
    const mapping = entry as Readonly<Record<string, unknown>>;
    if (
      typeof mapping.team !== "string" ||
      !Array.isArray(mapping.roles) ||
      !mapping.roles.every((role) => typeof role === "string")
    ) {
      throw new CmsError({
        code: "CMS_PERMISSION_002",
        message: "Each permission mapping requires a team and string roles.",
        category: "validation",
        retryable: false,
      });
    }
    return { team: mapping.team, roles: mapping.roles as readonly RoleName[] };
  });
  const customRoles = customRolesValue.map((entry): CustomRoleDefinition => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CmsError({
        code: "CMS_PERMISSION_003",
        message: "Each custom role must be an object.",
        category: "validation",
        retryable: false,
      });
    }
    const role = entry as Readonly<Record<string, unknown>>;
    if (
      typeof role.name !== "string" ||
      role.name.length === 0 ||
      !Array.isArray(role.actions) ||
      !role.actions.every(isCmsAction)
    ) {
      throw new CmsError({
        code: "CMS_PERMISSION_003",
        message: "Each custom role requires a name and valid CMS actions.",
        category: "validation",
        retryable: false,
      });
    }
    return { name: role.name as RoleName, actions: role.actions };
  });
  return { mappings, customRoles };
}

export function effectiveRoles(
  actorRoles: readonly RoleName[],
  teams: readonly string[],
  mappings: readonly TeamRoleMapping[],
): readonly RoleName[] {
  return [
    ...new Map(
      [
        ...actorRoles,
        ...mappings
          .filter((mapping) => teams.includes(mapping.team))
          .flatMap((mapping) => mapping.roles),
      ].map((role) => [String(role), role]),
    ).values(),
  ];
}

export interface PermissionExplanation {
  readonly allowed: boolean;
  readonly action: CmsAction;
  readonly reason: string;
  readonly matchedRoles: readonly RoleName[];
}

export class AuthorizationService {
  private readonly roleActions: Readonly<Record<string, ReadonlySet<CmsAction>>>;

  constructor(customRoles: readonly CustomRoleDefinition[] = []) {
    this.roleActions = {
      ...ROLE_ACTIONS,
      ...Object.fromEntries(
        customRoles.map((role) => [String(role.name), new Set(role.actions)]),
      ),
    };
  }

  explain(
    actor: Actor,
    action: CmsAction,
    options: {
      readonly policy?: ResourcePolicy;
      readonly ownerId?: string;
      readonly contentType?: string;
      readonly field?: string;
    } = {},
  ): PermissionExplanation {
    const matchedRoles = actor.roles.filter((role) => this.roleActions[String(role)]?.has(action));
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
    if (
      options.contentType !== undefined &&
      (options.policy?.contentTypes?.deny?.includes(options.contentType) === true ||
        (options.policy?.contentTypes?.allow !== undefined &&
          !options.policy.contentTypes.allow.includes(options.contentType)))
    ) {
      return {
        allowed: false,
        action,
        reason: `The resource policy does not allow content type ${options.contentType}.`,
        matchedRoles,
      };
    }
    if (
      options.field !== undefined &&
      (options.policy?.fields?.deny?.includes(options.field) === true ||
        (options.policy?.fields?.allow !== undefined &&
          !options.policy.fields.allow.includes(options.field)))
    ) {
      return {
        allowed: false,
        action,
        reason: `The resource policy does not allow field ${options.field}.`,
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
    options: {
      readonly policy?: ResourcePolicy;
      readonly ownerId?: string;
      readonly contentType?: string;
      readonly field?: string;
    } = {},
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
