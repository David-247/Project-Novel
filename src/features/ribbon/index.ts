// Public interface of the "ribbon" slice (Phase 3, T6): the toolbar, a Word-style ribbon rendered from
// the shared ribbon model (@/shared/ribbon) and the command registry (@/shared/commands).
//
// - <Ribbon />: tabs over one row of groups that scales down as the window narrows (never wraps).
// - Groups are registered with registerRibbonGroups (@/shared/ribbon); commands join a group through
//   their `ribbon` field. See docs/design.md, "Ribbon".
export { Ribbon, CommandButton, SplitCommandButton } from './Ribbon'
export type { RibbonProps, CommandButtonProps, SplitCommandButtonProps } from './Ribbon'
export { RegistryMenu } from './RegistryMenu'
export type { RegistryMenuProps, MenuSection } from './RegistryMenu'
export { ribbonSteps, chooseStep, HYSTERESIS_PX } from './layout'
export type { GroupState, LayoutGroup, Step } from './layout'
