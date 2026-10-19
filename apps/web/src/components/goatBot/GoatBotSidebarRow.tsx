import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useContext } from "react";

import { GOAT_BOT_PATH, isGoatBotRoute } from "~/globalAgentRoute";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { useGoatBotPreferred } from "./GoatBotModeButton";
import { GoatBotChannelContext } from "./goatBotChannelPort";
import { useGoatBotHome } from "./useGoatBotHome";
import { useGoatBotWaitingCount } from "./useGoatBotWaitingCount";
import { useGoatBotReadMenu } from "./useGoatBotReadMenu";
import { Badge } from "../ui/badge";

/** GOAT Bot's pinned place at the top of the thread list, hidden in thread mode. */
export function GoatBotSidebarRow() {
  useGoatBotHome();
  const port = useContext(GoatBotChannelContext);
  const enabled = useGoatBotPreferred();
  return enabled ? <GoatBotSidebarObserver key={port ? "port" : "none"} /> : null;
}

/**
 * Observes the bot without creating a bot thread. The parent row claims and syncs the cluster
 * home; creation or adoption of a stopped global agent still waits until the bot is opened.
 */
function GoatBotSidebarObserver() {
  const count = useGoatBotWaitingCount();
  const readMenu = useGoatBotReadMenu(count);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const active = isGoatBotRoute(pathname, resolveThreadRouteTarget(params), botRef);
  const { isMobile, setOpenMobile } = useSidebar();
  const handleClick = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <SidebarGroup className="z-[1]">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={active}
            aria-current={active ? "page" : undefined}
            onClick={handleClick}
            {...readMenu}
            render={<Link to={GOAT_BOT_PATH} />}
          >
            <GoatBotAvatar size="sm" />
            <span className="flex-1 truncate">GOAT Bot</span>
            {count !== undefined && count > 0 ? (
              <Badge size="sm" variant="secondary">
                {count}
              </Badge>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
