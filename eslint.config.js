import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.amplify']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Repo convention: `_`-prefixed names are deliberate omits (rest-destructure
      // strips, unused mock params). Keep flagging everything else.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // TSX twin of the CSS literal guard in theme.scope.test.ts: every UI surface takes colour
    // from --tms-* tokens (or TmsAlert / TmsBadge / a semantic utility), never a hex / rgb /
    // hsl literal, palette class or retired --ds-/--sh- token.
    // Intentional exceptions: `// eslint-disable-next-line no-restricted-syntax -- data colour | paper | camera | not a colour`.
    files: [
      'src/{features,components,pages}/**/*.{ts,tsx}',
      'src/App.tsx',
      'src/lib/ui/**/*.{ts,tsx}',
      'src/lib/{driverColors,apptStatus}.ts',
    ],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "Literal[value=/(?:^|[^\\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![\\w-])|(?:^|[\\s:(,'\"])#[0-9a-fA-F]{3,4}(?![\\w-])|\\brgba?\\(|\\bhsla?\\(/]",
          message: "Use a --tms-* token (or TmsAlert/TmsBadge).",
        },
        {
          selector: "TemplateElement[value.raw=/(?:^|[^\\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![\\w-])|(?:^|[\\s:(,'\"])#[0-9a-fA-F]{3,4}(?![\\w-])|\\brgba?\\(|\\bhsla?\\(/]",
          message: "Use a --tms-* token (or TmsAlert/TmsBadge).",
        },
        {
          selector: "Literal[value=/\\[#[0-9a-fA-F]{3,8}\\]/]",
          message: "Arbitrary hex class - use [color:var(--tms-...)].",
        },
        {
          selector: "TemplateElement[value.raw=/\\[#[0-9a-fA-F]{3,8}\\]/]",
          message: "Arbitrary hex class - use [color:var(--tms-...)].",
        },
        {
          selector: "Literal[value=/\\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|shadow|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?:\\/\\d+)?\\b|\\b(?:bg|border)-white\\b|\\bbg-black\\b/]",
          message: "Palette class - use a semantic utility or a badge token.",
        },
        {
          selector: "TemplateElement[value.raw=/\\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|shadow|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(?:\\/\\d+)?\\b|\\b(?:bg|border)-white\\b|\\bbg-black\\b/]",
          message: "Palette class - use a semantic utility or a badge token.",
        },
        {
          selector: "Literal[value=/--(?:ds|sh)-[a-z]/]",
          message: "Retired token - use --tms-*.",
        },
        {
          selector: "TemplateElement[value.raw=/--(?:ds|sh)-[a-z]/]",
          message: "Retired token - use --tms-*.",
        },
      ],
    },
  },
])
