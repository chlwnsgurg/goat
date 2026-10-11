import type { DraftSshDestination } from "../composerDraftStore";
import type { SavedSshWorktreeOption } from "../lib/sshWorktree";
import type { EnvMode } from "./BranchToolbar.logic";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuItem,
} from "./ui/menu";

export interface WorkspaceMenuItemsProps {
  envMode: EnvMode;
  locked: boolean;
  forceNewWorktree: boolean;
  localLabel: string;
  sshDestination: DraftSshDestination | null;
  sshOptions: ReadonlyArray<SavedSshWorktreeOption>;
  sshDisabledReason: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  onSshDestinationChange: (destination: DraftSshDestination) => void;
}
export function WorkspaceMenuItems(props: WorkspaceMenuItemsProps) {
  return (
    <MenuGroup>
      <MenuGroupLabel>Workspace</MenuGroupLabel>
      <MenuRadioGroup value={props.sshDestination ? "ssh" : props.envMode}>
        <MenuRadioItem
          value="local"
          closeOnClick
          disabled={props.locked || props.forceNewWorktree}
          onClick={() => props.onEnvModeChange("local")}
        >
          {props.localLabel}
        </MenuRadioItem>
        <MenuRadioItem
          value="worktree"
          closeOnClick
          disabled={props.locked}
          onClick={() => props.onEnvModeChange("worktree")}
        >
          New worktree
        </MenuRadioItem>
      </MenuRadioGroup>
      {props.sshOptions.length > 0 ? (
        <MenuSub>
          <MenuSubTrigger
            disabled={props.locked || props.forceNewWorktree || props.sshDisabledReason !== null}
            title={props.sshDisabledReason ?? undefined}
          >
            Worktree on SSH
          </MenuSubTrigger>
          <MenuSubPopup>
            {props.sshOptions.map((option) => (
              <MenuItem
                key={`${option.destination.environmentId}:${option.destination.connectionId}`}
                disabled={option.disabledReason !== null}
                closeOnClick
                title={option.disabledReason ?? undefined}
                onClick={() => props.onSshDestinationChange(option.destination)}
              >
                <span>{option.label}</span>
                {option.destination.connectionId === props.sshDestination?.connectionId &&
                option.destination.environmentId === props.sshDestination?.environmentId ? (
                  <span aria-label="Selected"> ✓</span>
                ) : null}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
    </MenuGroup>
  );
}
