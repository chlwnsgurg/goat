import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Self-healing vocabulary shared by goat_host_status, the fleet health tools, and the goal
 * controller. Conditions follow Kubernetes node conditions: each one is a fact about a host
 * with the time it became true, and several can hold at once.
 */

export const FleetHostConditionType = Schema.Literals([
  "Ready",
  "Unreachable",
  "Cordoned",
  "Draining",
  "VersionMismatch",
  "QuotaExhausted",
]);
export type FleetHostConditionType = typeof FleetHostConditionType.Type;

export const FleetHostCondition = Schema.Struct({
  type: FleetHostConditionType,
  /** When the condition became true (ISO 8601). */
  since: Schema.String,
  /** The provider instance at its limit, for QuotaExhausted. */
  instanceId: Schema.optional(Schema.String),
  message: Schema.String,
});
export type FleetHostCondition = typeof FleetHostCondition.Type;

const FleetHostAlias = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
  description: "SSH host alias from goat_ssh_host_list, or a linked host name.",
});

const FleetReason = Schema.String.check(Schema.isMaxLength(500));

export const GoatHostCordonInput = Schema.Struct({
  host: FleetHostAlias,
  reason: Schema.optional(FleetReason),
});
export type GoatHostCordonInput = typeof GoatHostCordonInput.Type;

export const GoatHostUncordonInput = Schema.Struct({ host: FleetHostAlias });
export type GoatHostUncordonInput = typeof GoatHostUncordonInput.Type;

export const GoatHostDrainInput = Schema.Struct({
  host: FleetHostAlias,
  force: Schema.optional(Schema.Boolean).annotate({
    description:
      "Move self-healing workers now, interrupting their current turn. Default false: each moves after its current turn ends.",
  }),
  reason: Schema.optional(FleetReason),
});
export type GoatHostDrainInput = typeof GoatHostDrainInput.Type;

/** What the rescheduler does next for a worker. */
export const FleetRescheduleAction = Schema.Literals([
  "wait",
  "steer",
  "restart",
  "move",
  "give_up",
]);
export type FleetRescheduleAction = typeof FleetRescheduleAction.Type;

export const FleetWorkerPhase = Schema.Literals([
  "watching",
  "push_requested",
  "launching",
  "exhausted",
]);
export type FleetWorkerPhase = typeof FleetWorkerPhase.Type;

export const FleetWorkerView = Schema.Struct({
  workerId: Schema.String,
  host: Schema.String,
  threadId: ThreadId,
  generation: Schema.Number,
  branch: Schema.NullOr(Schema.String),
  phase: FleetWorkerPhase,
  attempts: Schema.Number,
  lastReason: Schema.NullOr(Schema.String),
  nextAttemptAt: Schema.NullOr(Schema.String),
});
export type FleetWorkerView = typeof FleetWorkerView.Type;

export const GoatHostScheduleResult = Schema.Struct({
  host: Schema.String,
  cordoned: Schema.Boolean,
  draining: Schema.Boolean,
  conditions: Schema.Array(FleetHostCondition),
  /** Self-healing workers on the host, with what drain did to each. */
  workers: Schema.Array(FleetWorkerView),
  message: Schema.String,
});
export type GoatHostScheduleResult = typeof GoatHostScheduleResult.Type;

export const GoatThreadRescheduleInput = Schema.Struct({
  host: FleetHostAlias,
  threadId: ThreadId,
  targetHost: Schema.optional(FleetHostAlias),
  reason: FleetReason,
});
export type GoatThreadRescheduleInput = typeof GoatThreadRescheduleInput.Type;

export const GoatThreadRescheduleResult = Schema.Struct({
  action: FleetRescheduleAction,
  worker: FleetWorkerView,
  message: Schema.String,
});
export type GoatThreadRescheduleResult = typeof GoatThreadRescheduleResult.Type;
