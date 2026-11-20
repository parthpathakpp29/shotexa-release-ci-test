"use client";

/**
 * Shared desktop/mobile tool shell (architecture §19–20; screen2 is the reference):
 *   header  — logo · "Workspace / <tool switcher>" · status · primary export (⌘S)
 *   desktop — files (left) · canvas (center) · settings (right)
 *   mobile  — compact header · large canvas · files and settings in bottom sheets ·
 *             sticky Undo / Redo / Export bar with 44 px targets
 */
import { ChevronsUpDown, Download, Images, Loader2, Redo2, SlidersHorizontal, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Logo, LogoMark, ToolIcon } from "@/components/brand";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { TOOL_GROUPS, TOOLS, UPCOMING_TOOLS, type ToolId } from "@/config/tools";
import { cn } from "@/lib/cn";
import { useShortcutLabel } from "@/lib/use-shortcut-label";
import { FileTray } from "./file-tray";
import { useDropTarget, useWorkspace } from "./workspace-provider";

export interface ExportAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
  busy?: boolean;
}
export function ToolSwitcher({ tool }: { tool: ToolId }) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef(0);
  const search = useRef({ text: "", at: 0 });
  const ids = [...TOOL_GROUPS.flatMap((group) => group.tools), ...UPCOMING_TOOLS];
  const t = TOOLS[tool];
  function openMenu(index: number) {
    search.current = { text: "", at: 0 };
    initialFocus.current = index;
    setFocused(index);
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[initialFocus.current]?.focus();
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onPointerDown={(event) => { if (open) event.preventDefault(); }}
        onClick={() => {
          if (open) {
            setOpen(false);
            trigger.current?.focus();
          } else openMenu(Math.max(0, ids.indexOf(tool)));
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowDown" ? 0 : ids.length - 1);
          }
        }}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink shadow-xs hover:border-line-strong max-md:h-11 [&_svg]:shrink-0"
      >
        <ToolIcon name={t.icon} className="size-4 text-accent" />
        <span className="truncate">{t.name}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 text-ink-3" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Switch tool"
          onBlurCapture={(event) => {
            // Tab follows the document order out of this non-modal menu.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
            const index = items.indexOf(document.activeElement as HTMLElement);
            let next: number;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
              return;
            }
            if (event.key === "ArrowDown") next = (index + 1) % items.length;
            else if (event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const now = Date.now();
              const text = (now - search.current.at < 600 ? search.current.text : "") + event.key.toLowerCase();
              search.current = { text, at: now };
              const prefix = [...text].every((letter) => letter === text[0]) ? text[0] : text;
              next = items.findIndex((_, offset) => items[(index + 1 + offset) % items.length].textContent?.trim().toLowerCase().startsWith(prefix));
              if (next < 0) return;
              next = (index + 1 + next) % items.length;
            } else return;
            event.preventDefault();
            items[next]?.focus();
          }}
          className="absolute left-0 top-full z-40 mt-2 max-h-[70dvh] w-64 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-md max-md:fixed max-md:inset-x-3 max-md:top-16 max-md:w-auto"
        >
          {/* Grouped from the registry, so every live tool is reachable from every tool. */}
          {TOOL_GROUPS.map((group) => (
            <div key={group.id} role="group" aria-label={group.label} className="mb-1 last:mb-0">
              <p aria-hidden className="t-micro px-2.5 pb-1 pt-2 text-ink-3">{group.label}</p>
              {group.tools.map((id) => (
                <Link
                  key={id}
                  role="menuitem"
                  tabIndex={focused === ids.indexOf(id) ? 0 : -1}
                  onFocus={() => setFocused(ids.indexOf(id))}
                  aria-current={id === tool ? "page" : undefined}
                  href={TOOLS[id].route}
                  onClick={() => setOpen(false)}
                  className={cn("flex min-h-10 items-center gap-2.5 rounded-sm px-2.5 text-sm hover:bg-surface-2 max-md:min-h-11", id === tool ? "text-accent-ink" : "text-ink")}
                >
                  <ToolIcon name={TOOLS[id].icon} className="size-4" />
                  {TOOLS[id].name}
                </Link>
              ))}
            </div>
          ))}
          {/* Only while unfinished routes exist. */}
          {UPCOMING_TOOLS.length > 0 && (
            <div role="group" aria-label="Coming soon" className="mt-1 border-t border-line pt-1">
              <p aria-hidden className="t-micro px-2.5 pb-1 pt-2 text-ink-3">Coming soon</p>
              {UPCOMING_TOOLS.map((id) => (
                <Link
                  key={id}
                  role="menuitem"
                  tabIndex={focused === ids.indexOf(id) ? 0 : -1}
                  onFocus={() => setFocused(ids.indexOf(id))}
                  aria-current={id === tool ? "page" : undefined}
                  href={TOOLS[id].route}
                  onClick={() => setOpen(false)}
                  className={cn("flex min-h-10 items-center gap-2.5 rounded-sm px-2.5 text-sm text-ink-3 hover:bg-surface-2 max-md:min-h-11", id === tool && "text-accent-ink")}
                >
                  <ToolIcon name={TOOLS[id].icon} className="size-4" />
                  {TOOLS[id].name}
                  <span className="t-micro ml-auto text-[9.5px]">Soon</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceHeader({ tool, status, exportAction }: { tool: ToolId; status?: ReactNode; exportAction?: ExportAction }) {
  const saveKey = useShortcutLabel("S");
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur">
      <div className="flex h-16 items-center gap-2 px-4 md:gap-4 lg:px-6">
        <Logo className="max-md:hidden" />
        <Link href="/" aria-label="Shotexa home" className="inline-flex size-11 shrink-0 items-center justify-center md:hidden">
          <LogoMark />
        </Link>
        <span aria-hidden className="h-6 w-px bg-line max-md:hidden" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 max-md:flex-1">
          <Link href="/" className="font-display text-[17px] italic text-ink-2 hover:text-ink max-sm:hidden">
            Workspace
          </Link>
          <span aria-hidden className="text-ink-3 max-sm:hidden">
            /
          </span>
          <ToolSwitcher tool={tool} />
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {status && <div aria-live="polite" aria-atomic="true" className="max-lg:sr-only">{status}</div>}
          {exportAction && (
            <Button variant="primary" size="lg" kbd={saveKey} onClick={exportAction.onClick} disabled={exportAction.disabled || exportAction.busy} aria-busy={exportAction.busy || undefined} className="max-md:hidden" data-testid="export">
              {exportAction.busy ? <Loader2 className="animate-spin" /> : <Download />}
              {exportAction.label}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

/** Undo/redo/export keyboard shortcuts for the active tool (inputs keep their native behaviour). */
function useToolShortcuts(exportAction?: ExportAction) {
  const undo = useWorkspace((s) => s.undo);
  const redo = useWorkspace((s) => s.redo);
  const exportRef = useRef(exportAction);
  useEffect(() => {
    exportRef.current = exportAction;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) && (e.target as HTMLInputElement).type !== "range";
      if (k === "s") {
        e.preventDefault();
        const a = exportRef.current;
        if (a && !a.disabled && !a.busy) a.onClick();
      } else if (!typing && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (!typing && k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
}

export function WorkspaceShell({
  tool,
  status,
  exportAction,
  fileHint,
  canvas,
  inspector,
  inspectorTitle = "Settings",
  below,
}: {
  tool: ToolId;
  status?: ReactNode;
  exportAction?: ExportAction;
  fileHint?: string;
  canvas: ReactNode;
  inspector: ReactNode;
  inspectorTitle?: string;
  below?: ReactNode;
}) {
  const [sheet, setSheet] = useState<"files" | "settings" | null>(null);
  const filesTrigger = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const subscribeLayout = useCallback((notify: () => void) => {
    const media = window.matchMedia("(min-width: 48rem)");
    const change = () => {
      setSheet(null);
      notify();
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const desktop = useSyncExternalStore(subscribeLayout, desktopSnapshot, mobileSnapshot);
  const count = useWorkspace((s) => s.order.length);
  const canUndo = useWorkspace((s) => s.history.past.length > 0);
  const canRedo = useWorkspace((s) => s.history.future.length > 0);
  const undo = useWorkspace((s) => s.undo);
  const redo = useWorkspace((s) => s.redo);
  const setActiveTool = useWorkspace((s) => s.setActiveTool);
  const { over, props: dropProps } = useDropTarget();
  useToolShortcuts(exportAction);
  useEffect(() => setActiveTool(tool), [tool, setActiveTool]);

  return (
    <div data-testid="workspace-drop-zone" className="flex min-h-dvh flex-col" {...dropProps}>
      {over && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface p-12 text-center shadow-xl">
            {(() => {
              if (tool === "compare") return <p className="t-h3 text-accent-ink">Drop 2 screenshots to compare</p>;
              if (tool === "stitch") return <p className="t-h3 text-accent-ink">Drop screenshots to stitch</p>;
              if (tool === "combine") return <p className="t-h3 text-accent-ink">Drop images to combine</p>;
              return <p className="t-h3 text-accent-ink">Drop screenshots here</p>;
            })()}
            <p className="t-body mt-2 text-ink-2">They will be added to your workspace</p>
          </div>
        </div>
      )}
      <WorkspaceHeader tool={tool} status={status} exportAction={exportAction} />
      <div className="mx-auto grid w-full max-w-[1480px] flex-1 grid-cols-1 gap-5 px-3 py-4 md:grid-cols-[232px_minmax(0,1fr)] md:px-5 md:py-6 lg:grid-cols-[232px_minmax(0,1fr)_264px] lg:gap-5 xl:grid-cols-[272px_minmax(0,1fr)_300px] xl:gap-6 max-md:pb-28">
        {desktop && <aside className="hidden md:block">
          <div className="sticky top-22 rounded-lg border border-line bg-surface p-5 shadow-xs md:max-h-[calc(100dvh-7rem)] md:overflow-hidden">
            <FileTray hint={fileHint} className="md:max-h-[calc(100dvh-9.5rem)]" />
          </div>
        </aside>}
        <main ref={main} tabIndex={-1} aria-label={`${TOOLS[tool].name} workspace`} className="min-w-0">
          {canvas}
          {below}
        </main>
        {desktop && <aside aria-label={inspectorTitle} className="hidden md:col-span-2 md:block lg:col-span-1">
          <div className="rounded-lg border border-line bg-surface p-5 shadow-xs lg:sticky lg:top-22 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto">{inspector}</div>
        </aside>}
      </div>

      {/* Mobile: sticky action bar + sheets */}
      {!desktop && <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:hidden">
        <div className="flex items-center gap-1">
          <MobileBarButton buttonRef={filesTrigger} label={`Files (${count})`} visibleLabel={`Files ${count}`} onClick={() => setSheet("files")}>
            <Images />
          </MobileBarButton>
          <MobileBarButton buttonRef={settingsTrigger} label={inspectorTitle} visibleLabel="Settings" onClick={() => setSheet("settings")} testId="mobile-inspector-trigger">
            <SlidersHorizontal />
          </MobileBarButton>
          <MobileBarButton label="Undo" onClick={undo} disabled={!canUndo}>
            <Undo2 />
          </MobileBarButton>
          <MobileBarButton label="Redo" onClick={redo} disabled={!canRedo}>
            <Redo2 />
          </MobileBarButton>
          {exportAction && (
            <Button variant="primary" size="lg" className="ml-auto h-11" onClick={exportAction.onClick} disabled={exportAction.disabled || exportAction.busy} aria-busy={exportAction.busy || undefined}>
              {exportAction.busy ? <Loader2 className="animate-spin" /> : <Download />}
              Export
            </Button>
          )}
        </div>
      </div>}
      <BottomSheet open={!desktop && sheet === "files"} onOpenChange={(v) => setSheet(v ? "files" : null)} title="Screenshots" returnFocusRef={filesTrigger} fallbackFocusRef={main}>
        <FileTray hint={fileHint} onAfterSelect={() => setSheet(null)} />
      </BottomSheet>
      <BottomSheet
        open={!desktop && sheet === "settings"}
        onOpenChange={(v) => setSheet(v ? "settings" : null)}
        title={inspectorTitle}
        returnFocusRef={settingsTrigger}
        fallbackFocusRef={main}
        footer={exportAction && (
          <Button variant="primary" size="lg" className="w-full" data-testid="mobile-sheet-export" onClick={exportAction.onClick} disabled={exportAction.disabled || exportAction.busy} aria-busy={exportAction.busy || undefined}>
            {exportAction.busy ? <Loader2 className="animate-spin" /> : <Download />}
            {exportAction.label}
          </Button>
        )}
      >
        {inspector}
      </BottomSheet>
    </div>
  );
}

// Match Tailwind's md breakpoint. The server snapshot avoids browser APIs during SSR.
const desktopSnapshot = () => window.matchMedia("(min-width: 48rem)").matches;
const mobileSnapshot = () => false;

function MobileBarButton({ label, visibleLabel, children, onClick, disabled, testId, buttonRef }: { label: string; visibleLabel?: string; children: ReactNode; onClick(): void; disabled?: boolean; testId?: string; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={buttonRef} type="button" aria-haspopup={visibleLabel ? "dialog" : undefined} aria-label={label} title={label} data-testid={testId} onClick={onClick} disabled={disabled} className={visibleLabel ? "inline-flex size-11 flex-col items-center justify-center gap-0.5 rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-35 [&_svg]:size-4" : "inline-flex size-11 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-35 [&_svg]:size-5"}>
      {children}
      {visibleLabel && <span className="max-w-full truncate text-[9px] leading-none">{visibleLabel}</span>}
    </button>
  );
}
