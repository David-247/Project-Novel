import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export const SLICES = ['editor', 'storage', 'tooltips', 'app-shell', 'book-settings', 'pagination', 'header-footer', 'footnotes', 'menu', 'track-changes', 'settings', 'comments', 'rewrite', 'export', 'outline', 'ribbon', 'ai-tutor']

/**
 * A file in slice A may import slice B only via its index (`@/features/B`),
 * never `@/features/B/<anything>` nor a relative path reaching into B.
 * Within-slice relative imports are fine, so each slice gets its own override
 * forbidding deep paths into every OTHER slice.
 */
// A relative import reaches another slice only by climbing out of the slice folder, so the pattern depends
// on how deep the file is: `src/features/A/x.ts` reaches slice B as `../B/...`, `src/features/A/sub/x.ts`
// as `../../B/...`. Matching `**/B/**` instead would also hit A's own sub-folder that happens to be named
// like a slice (`export/settings/`).
const MAX_DEPTH = 5
const crossSliceRules = SLICES.flatMap((slice) =>
  Array.from({ length: MAX_DEPTH + 1 }, (_, depth) => ({
    files: [
      `src/features/${slice}/${'*/'.repeat(depth)}*.{ts,tsx}`,
      ...(depth === 0 ? [`tests/fixtures/features/${slice}/**/*.{ts,tsx}`] : []),
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: SLICES.filter((o) => o !== slice).map((other) => ({
            group: [`@/features/${other}/**`, `**/features/${other}/**`, `${'../'.repeat(depth + 1)}${other}/**`],
            message: `Import from "@/features/${other}" (its index.ts), not its internals.`,
          })),
        },
      ],
    },
  })),
)

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-e2e',
      'perf-results',
      'src-tauri',
      'node_modules',
      'playwright-report',
      'test-results',
      'coverage',
      '.claude',
      '.superpowers',
      // Deliberate violation; linted explicitly by tests/cross-slice-lint.test.ts
      'tests/fixtures',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Node scripts (bundle check, tauri-driver smoke).
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  ...crossSliceRules,
)
