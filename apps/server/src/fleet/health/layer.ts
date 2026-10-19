import * as Layer from "effect/Layer";

import * as FleetHostStates from "./FleetHostStates.ts";
import * as Health from "./Health.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import * as Rescheduler from "./Rescheduler.ts";

/** Health and Rescheduler for the goal controller and the fleet tools, over one monitor. */
export const layer = Layer.mergeAll(Health.layer, Rescheduler.layer).pipe(
  Layer.provideMerge(HostHealthMonitor.layer),
  Layer.provideMerge(Layer.mergeAll(FleetHostStates.layer, FleetHostStates.layerClaims)),
);
