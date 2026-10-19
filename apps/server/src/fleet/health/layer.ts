import * as Layer from "effect/Layer";

import * as FleetHealthStore from "./FleetHealthStore.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import * as Rescheduler from "./Rescheduler.ts";

/**
 * Health and Rescheduler for the MCP tools and, later, the goal controller. Both read one store,
 * and the Rescheduler's Scheduler source also drives Health's sampling.
 */
export const layer = Rescheduler.layer.pipe(
  Layer.provideMerge(HostHealthMonitor.layer),
  Layer.provideMerge(FleetHealthStore.layer),
);
