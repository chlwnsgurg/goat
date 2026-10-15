export type DestinationId =
  | "home"
  | "bot"
  | "decisions"
  | "usage"
  | "pullRequests"
  | "memory"
  | "scheduled"
  | "settings";

/** Rail width in CSS pixels; the shell also subtracts it from the sidebar's width limits. */
export const DESTINATION_RAIL_WIDTH_PX = 56;

const isWithin = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/**
 * Picks the rail destination for a URL. `isBotRoute` comes from `isGoatBotRoute`, because
 * /bot redirects to the bot's own thread URL, which would otherwise read as Home.
 */
export function resolveActiveDestination(
  pathname: string,
  context: { readonly isBotRoute: boolean },
): DestinationId {
  if (context.isBotRoute) return "bot";
  if (pathname === "/decisions") return "decisions";
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pullRequests";
  if (isWithin(pathname, "/settings/memory")) return "memory";
  if (isWithin(pathname, "/settings/scheduled-tasks")) return "scheduled";
  if (isWithin(pathname, "/settings") || pathname.startsWith("/projects/")) return "settings";
  return "home";
}
