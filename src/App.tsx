import { AppShell } from '@/features/app-shell'
import { FindButton, FindReplacePanel, HistoryButtons, NovelEditor, Toolbar, ToolbarItem } from '@/features/editor'
import { ToolbarGroup } from '@/shared/ui'
import { useThemeFollow } from '@/shared/theme'

/** Composition root: the only place that wires slices together. */
export function App() {
  useThemeFollow()
  return (
    <AppShell
      toolbar={
        <>
          <span className="px-1 text-ui font-semibold">Novel</span>
          <Toolbar
            leadingGroups={
              <ToolbarGroup label="History">
                <HistoryButtons
                  wrap={(button, { disabled }) => <ToolbarItem disabled={disabled}>{button}</ToolbarItem>}
                />
              </ToolbarGroup>
            }
            extraGroups={
              <ToolbarGroup label="Find">
                <ToolbarItem>
                  <FindButton />
                </ToolbarItem>
              </ToolbarGroup>
            }
          />
        </>
      }
      editor={
        <>
          {/* Zero-height sticky anchor: the find panel floats at the top of the scrolling editor
              region (never over the toolbar, whatever its wrapped height) and takes no layout
              space while closed. Full width minus gutters on narrow screens. */}
          <div className="pointer-events-none sticky top-0 z-10 flex h-0 items-start justify-end px-2 sm:px-4">
            <FindReplacePanel className="pointer-events-auto mt-2" />
          </div>
          <NovelEditor />
        </>
      }
      statusBar={null}
    />
  )
}
