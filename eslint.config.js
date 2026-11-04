import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export const SLICES = ['editor', 'storage', 'tooltips', 'app-shell', 'book-settings', 'pagination', 'header-footer']

/**
 * A file in slice A may import slice B only via its index (`@/features/B`),
 * never `@/features/B/<anything>` nor a relative path reaching into B.
 * Within-slice relative imports are fine, so each slice gets its own override
 * forbidding deep paths into every OTHER slice.
 */
const crossSliceRules = SLICES.map((slice) => ({
  files: [`src/features/${slice}/**/*.{ts,tsx}`, `tests/fixtures/features/${slice}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: SLICES.filter((o) => o !== slice).map((other) => ({
          group: [`@/features/${other}/**`, `**/features/${other}/**`, `**/${other}/**`],
          message: `Import from "@/features/${other}" (its index.ts), not its internals.`,
        })),
      },
    ],
  },
}))

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
