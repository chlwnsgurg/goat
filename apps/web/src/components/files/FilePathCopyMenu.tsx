import { Copy } from "~/components/solar/nodes";
import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { copyFilePath, resolveFilePathCopyTargets } from "~/filePathCopy";

/** Path copying stays available even when no editor or shell actions are supported. */
export function FilePathCopyMenu(props: { filePath: string; workspaceRoot: string }) {
  const { relativePath, fullPath } = resolveFilePathCopyTargets(props);
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="icon-sm" aria-label="Copy file path" />}
      >
        <MorphIcon className="size-3.5" icon={Copy} />
      </MenuTrigger>
      <MenuPopup align="end">
        {relativePath !== null ? (
          <MenuItem onClick={() => void copyFilePath(relativePath, "Relative path")}>
            Copy relative path
          </MenuItem>
        ) : null}
        {fullPath !== null ? (
          <MenuItem onClick={() => void copyFilePath(fullPath, "Full path")}>
            Copy full path
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
