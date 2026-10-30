import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const NamedWorkspaceId = TrimmedNonEmptyString.pipe(Schema.brand("NamedWorkspaceId"));
export type NamedWorkspaceId = typeof NamedWorkspaceId.Type;

export const NamedWorkspaceCheckout = Schema.Struct({
  projectId: ProjectId,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headCommit: TrimmedNonEmptyString,
});
export type NamedWorkspaceCheckout = typeof NamedWorkspaceCheckout.Type;

export const NamedWorkspaceThreadPlacement = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: Schema.NullOr(IsoDateTime),
  pinOrderKey: Schema.NullOr(TrimmedNonEmptyString),
  activeOrderKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type NamedWorkspaceThreadPlacement = typeof NamedWorkspaceThreadPlacement.Type;

export const NamedWorkspace = Schema.Struct({
  id: NamedWorkspaceId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  version: NonNegativeInt,
  status: Schema.Literals(["active", "archiving", "archived", "restoring"]),
  checkouts: Schema.Array(NamedWorkspaceCheckout),
  retainedCheckoutPaths: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  associationChoices: Schema.Array(
    Schema.Struct({ projectId: ProjectId, choice: Schema.Literals(["add", "separate"]) }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  threadPlacements: Schema.Array(NamedWorkspaceThreadPlacement).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
});
export type NamedWorkspace = typeof NamedWorkspace.Type;

const command = { commandId: CommandId, workspaceId: NamedWorkspaceId };
const placement = { ...command, threadId: ThreadId };
export const NamedWorkspaceMutation = Schema.Union([
  Schema.Struct({ ...command, type: Schema.Literal("create"), name: NamedWorkspace.fields.name }),
  Schema.Struct({ ...command, type: Schema.Literal("rename"), name: NamedWorkspace.fields.name }),
  Schema.Struct({
    ...command,
    type: Schema.Literal("attach"),
    projectId: ProjectId,
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...command, type: Schema.Literal("detach"), path: TrimmedNonEmptyString }),
  Schema.Struct({
    ...command,
    type: Schema.Literal("set-project-association"),
    projectId: ProjectId,
    choice: Schema.NullOr(Schema.Literals(["add", "separate"])),
  }),
  Schema.Struct({
    ...command,
    type: Schema.Literal("associate-project"),
    projectId: ProjectId,
    branch: TrimmedNonEmptyString,
    remember: Schema.Boolean,
    automatic: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ ...command, type: Schema.Literal("archive") }),
  Schema.Struct({ ...command, type: Schema.Literal("restore") }),
  Schema.Struct({
    ...placement,
    type: Schema.Literal("pin-thread"),
    orderKey: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ ...placement, type: Schema.Literal("unpin-thread") }),
  Schema.Struct({
    ...placement,
    type: Schema.Literal("reorder-pinned-thread"),
    orderKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...placement,
    type: Schema.Literal("reorder-active-thread"),
    orderKey: TrimmedNonEmptyString,
  }),
]);
export type NamedWorkspaceMutation = typeof NamedWorkspaceMutation.Type;

export const NamedWorkspaceSuggestion = Schema.Struct({
  workspaceId: NamedWorkspaceId,
  branch: TrimmedNonEmptyString,
  path: Schema.NullOr(TrimmedNonEmptyString),
  choice: Schema.NullOr(Schema.Literals(["add", "separate"])),
});
export type NamedWorkspaceSuggestion = typeof NamedWorkspaceSuggestion.Type;

export const NamedWorkspaceBlocker = Schema.Struct({
  code: Schema.Literals([
    "active_work",
    "terminal",
    "local_changes",
    "ignored_files",
    "missing_project",
    "invalid_checkout",
    "changed_branch",
    "changed_head",
  ]),
  message: TrimmedNonEmptyString,
});
export type NamedWorkspaceBlocker = typeof NamedWorkspaceBlocker.Type;

export const NamedWorkspaceArchivePreview = Schema.Struct({
  workspaceId: NamedWorkspaceId,
  threadCount: NonNegativeInt,
  checkouts: Schema.Array(
    Schema.Struct({
      ...NamedWorkspaceCheckout.fields,
      exists: Schema.Boolean,
      retained: Schema.optionalKey(Schema.Boolean),
      blockers: Schema.Array(NamedWorkspaceBlocker),
    }),
  ),
});
export type NamedWorkspaceArchivePreview = typeof NamedWorkspaceArchivePreview.Type;

export class NamedWorkspaceError extends Schema.TaggedError<NamedWorkspaceError>()(
  "NamedWorkspaceError",
  {
    reason: Schema.Literals([
      "not_found",
      "conflict",
      "invalid_checkout",
      "blocked",
      "storage",
      "operation_failed",
    ]),
    workspaceId: Schema.optional(NamedWorkspaceId),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
