// Public interface of the "tooltips" slice. Other slices may import ONLY from here.
//
// - TOOLTIP_REGISTRY / getTooltipCopy: control id (data-control-id) -> { title, description, shortcut }.
//   Feed getTooltipCopy to <TooltipProvider lookup> from @/shared/ui at the composition root;
//   call sites wrap controls in <Tooltip> from @/shared/ui and never import this slice.
// - auditTooltipCoverage: lists controls under a DOM root that would show no tooltip (used by tests).
export { TOOLTIP_REGISTRY, getTooltipCopy } from './registry'
export { auditTooltipCoverage, formatCoverageProblems, CONTROL_SELECTOR } from './coverage'
export type { CoverageProblem, CoverageReason } from './coverage'
