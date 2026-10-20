/**
 * Fleet goals as one unit for the server: the store, the controller on the shared Scheduler,
 * the tools' service, and the default fleet layers (fleet/defaults.ts). Self-healing and resources
 * replace a default by providing Placement, Health, Rescheduler or Fallback above this layer.
 */
import * as Layer from "effect/Layer";

import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import * as RemoteReportService from "../../remoteReports/RemoteReportService.ts";
import * as ThreadResultService from "../../threadResults/ThreadResultService.ts";
import * as FleetDefaults from "../defaults.ts";
import * as GoalController from "./GoalController.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";
import * as GoalWorkerRuntime from "./GoalWorkerRuntime.ts";

const layerRuntime = GoalWorkerRuntime.layer.pipe(
  Layer.provide(ThreadLaunchMcpService.layer),
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(RemoteReportService.layer),
  Layer.provide(ThreadResultService.layer),
);

const layerCore = GoalController.layer.pipe(
  Layer.provideMerge(GoalService.layer),
  Layer.provideMerge(layerRuntime),
  Layer.provideMerge(GoalStore.layer),
  Layer.provideMerge(FleetDefaults.layer),
);

export const layer = GoalController.layerRunning.pipe(Layer.provideMerge(layerCore));
