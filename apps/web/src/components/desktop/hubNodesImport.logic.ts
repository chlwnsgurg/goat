import {
  connectionRoutes,
  isDesktopLocalConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import type { HubNodeImportProfile, HubNodesImportInput } from "@goat/contracts";
import * as Option from "effect/Option";

export function catalogToImportInput(
  catalog: Iterable<ConnectionCatalogEntry>,
): HubNodesImportInput {
  const profiles: HubNodeImportProfile[] = [];
  for (const entry of catalog) {
    const routes = connectionRoutes(entry);
    if (
      !entry.enabled ||
      routes.some(
        ({ target }) =>
          target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target),
      )
    )
      continue;
    for (const route of routes) {
      const profile = Option.getOrNull(route.profile);
      if (profile?._tag !== "SshConnectionProfile" || profile.target.alias.startsWith("boat-"))
        continue;
      profiles.push({
        environmentId: entry.target.environmentId,
        label: (entry.target.label.trim() || profile.target.alias).slice(0, 120),
        ssh: {
          alias: profile.target.alias,
          hostname: profile.target.hostname,
          username: profile.target.username,
          port: profile.target.port,
        },
      });
      if (profiles.length === 500)
        return { source: "desktop-catalog", catalog: { state: "readable", profiles } };
    }
  }
  return { source: "desktop-catalog", catalog: { state: "readable", profiles } };
}
