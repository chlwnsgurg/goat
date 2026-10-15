import { createFileRoute } from "@tanstack/react-router";
import { MemorySettings } from "../components/settings/MemorySettings";
import { validateMemorySettingsSearch } from "../components/settings/MemorySettings.logic";
export const Route = createFileRoute("/settings/memory")({
  validateSearch: validateMemorySettingsSearch,
  component: MemoryRoute,
});
function MemoryRoute() {
  return <MemorySettings target={Route.useSearch()} />;
}
