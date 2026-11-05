// Public interface of the "book-settings" slice. Other slices may import ONLY from here.
//
// - TrimSizePicker: toolbar dropdown (data-control-id `book.trimSize`) that sets bookActions.setTrimSize.
//   Wrap in the editor's ToolbarItem to join the toolbar's roving focus.
// - TRIM_SIZE_CONTROL_ID / trimSizeItemControlId: control ids, for tooltip copy.
// - chooseTrimSize(id): the picker's action (margins follow the size's defaults when untouched).
// - registerBookSettingsCommands(): File > Page Setup ▸ trim sizes (shared command registry).
export { TrimSizePicker, TRIM_SIZE_CONTROL_ID, trimSizeItemControlId, chooseTrimSize } from './TrimSizePicker'
export type { TrimSizePickerProps } from './TrimSizePicker'
export { registerBookSettingsCommands } from './commands'
