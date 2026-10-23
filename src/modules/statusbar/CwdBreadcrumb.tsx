import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  copyToClipboard,
  REVEAL_LABEL,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import {
  COMPACT_CONTENT,
  COMPACT_ITEM,
} from "@/modules/explorer/lib/menuItemClass";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  ArrowDown01Icon,
  Folder01Icon,
  Home03Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  createContext,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { inSeparatorsOf, pathInside, segmentsFromCwd } from "./lib/pathUtils";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  /** The workspace folder that "Copy Relative Path" is relative to. */
  root?: string | null;
  onCd: (path: string) => void;
  onOpenTerminal?: (path: string) => void;
};

type PathMenuContext = {
  /** The path the breadcrumb shows, whose separators copies keep. */
  shown: string;
  root: string | null;
  onOpenTerminal?: (path: string) => void;
};

const PathMenuContext = createContext<PathMenuContext | null>(null);

/**
 * Right-click menu of one breadcrumb segment: `path` is the folder (or, for a
 * file's own segment, the file) it stands for, spelled as the segments are.
 */
function PathMenu({
  path,
  folder = path,
  children,
}: {
  path: string;
  /** Where "Open in Terminal" starts: the folder itself, or a file's folder. */
  folder?: string;
  children: ReactElement;
}) {
  const context = useContext(PathMenuContext);
  if (!context) return children;
  const native = inSeparatorsOf(path, context.shown);
  const relative = pathInside(context.root, path);
  const onOpenTerminal = context.onOpenTerminal;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={COMPACT_CONTENT}>
        {onOpenTerminal ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenTerminal(folder)}
          >
            Open in Terminal
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void revealInFinder(native)}
        >
          {REVEAL_LABEL}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(native)}
        >
          Copy Path
        </ContextMenuItem>
        {relative ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() =>
              void copyToClipboard(inSeparatorsOf(relative, context.shown))
            }
          >
            Copy Relative Path
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

export function CwdBreadcrumb({
  cwd,
  filePath,
  home,
  root = null,
  onCd,
  onOpenTerminal,
}: Props) {
  const shown = filePath || cwd;
  if (!shown) {
    return (
      <span className="text-xs text-muted-foreground/70">no directory</span>
    );
  }
  return (
    <PathMenuContext.Provider value={{ shown, root, onOpenTerminal }}>
      <BreadcrumbPath cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
    </PathMenuContext.Provider>
  );
}

function BreadcrumbPath({
  cwd,
  filePath,
  home,
  onCd,
}: Pick<Props, "cwd" | "filePath" | "home" | "onCd">) {
  // File mode: dir segments navigate; filename is the terminal leaf.
  if (filePath) {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const segments = segmentsFromCwd(dir, home);
    const first = segments[0];
    const middle = segments.slice(1);
    return (
      <Breadcrumb>
        <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
          {first ? (
            <BreadcrumbSegment
              label={first.label}
              isHome={first.isHome}
              path={first.fullPath}
              onClick={() => onCd(first.fullPath)}
            />
          ) : null}
          {middle.length > 0 ? (
            <CollapsedSegments segments={middle} onCd={onCd} />
          ) : null}
          {middle.map((s) => (
            <span key={s.fullPath} className="contents max-md:hidden">
              <BreadcrumbSegment
                label={s.label}
                isHome={s.isHome}
                path={s.fullPath}
                onClick={() => onCd(s.fullPath)}
              />
            </span>
          ))}
          <BreadcrumbItem>
            <PathMenu path={filePath} folder={dir}>
              <BreadcrumbPage className="text-foreground">
                {name}
              </BreadcrumbPage>
            </PathMenu>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  if (!cwd) return null;

  const segments = segmentsFromCwd(cwd, home);
  const current = segments[segments.length - 1];
  const parents = segments.slice(0, -1);

  const firstParent = parents[0];
  const middleParents = parents.slice(1);
  return (
    <Breadcrumb>
      <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
        {firstParent ? (
          <BreadcrumbSegment
            label={firstParent.label}
            isHome={firstParent.isHome}
            path={firstParent.fullPath}
            onClick={() => onCd(firstParent.fullPath)}
          />
        ) : null}
        {middleParents.length > 0 ? (
          <CollapsedSegments segments={middleParents} onCd={onCd} />
        ) : null}
        {middleParents.map((s) => (
          <span key={s.fullPath} className="contents max-md:hidden">
            <BreadcrumbSegment
              label={s.label}
              isHome={s.isHome}
              path={s.fullPath}
              onClick={() => onCd(s.fullPath)}
            />
          </span>
        ))}
        <BreadcrumbItem>
          <CurrentSegmentDropdown
            label={current.label}
            path={current.fullPath}
            onCd={onCd}
          />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbSegment({
  label,
  path,
  isHome,
  onClick,
}: {
  label: string;
  path: string;
  isHome: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <BreadcrumbItem>
        <PathMenu path={path}>
          <BreadcrumbLink asChild>
            <button type="button" onClick={onClick} className="cursor-pointer">
              <Badge
                variant="outline"
                className="gap-1 text-muted-foreground hover:text-foreground"
              >
                {isHome ? (
                  <HugeiconsIcon
                    icon={Home03Icon}
                    className="size-3"
                    strokeWidth={1.75}
                  />
                ) : null}
                {isHome ? "Home" : label}
              </Badge>
            </button>
          </BreadcrumbLink>
        </PathMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </>
  );
}

function CurrentSegmentDropdown({
  label,
  path,
  onCd,
}: {
  label: string;
  path: string;
  onCd: (p: string) => void;
}) {
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const dirs = await invoke<string[]>("list_subdirs", {
        path,
        showHidden,
        workspace: currentWorkspaceEnv(),
      });
      setChildren(dirs);
    } catch (e) {
      setError(String(e));
      setChildren([]);
    }
  }, [path, showHidden]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <PathMenu path={path}>
        <DropdownMenuTrigger asChild>
          <BreadcrumbPage className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent">
            {label === "~" ? (
              <>
                <HugeiconsIcon
                  icon={Home03Icon}
                  className="size-3"
                  strokeWidth={1.75}
                />
                Home
              </>
            ) : (
              label
            )}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              className="size-3 opacity-70"
              strokeWidth={2}
            />
          </BreadcrumbPage>
        </DropdownMenuTrigger>
      </PathMenu>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {children === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : children.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {error ?? "No subfolders"}
          </div>
        ) : (
          children.map((name) => (
            <DropdownMenuItem
              key={name}
              onSelect={() =>
                onCd(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`)
              }
            >
              <HugeiconsIcon
                icon={Folder01Icon}
                className="size-3.5 text-muted-foreground"
                strokeWidth={1.75}
              />
              {name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedSegments({
  segments,
  onCd,
}: {
  segments: { fullPath: string; label: string; isHome: boolean }[];
  onCd: (p: string) => void;
}) {
  return (
    <span className="contents md:hidden">
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Show hidden folders"
              className="flex items-center rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                className="size-3"
                strokeWidth={1.75}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {segments.map((s) => (
              <DropdownMenuItem
                key={s.fullPath}
                onSelect={() => onCd(s.fullPath)}
              >
                <HugeiconsIcon
                  icon={s.isHome ? Home03Icon : Folder01Icon}
                  className="size-3.5 text-muted-foreground"
                  strokeWidth={1.75}
                />
                <span className="truncate">{s.isHome ? "Home" : s.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
      <BreadcrumbSeparator className="[&>svg]:size-3" />
    </span>
  );
}
