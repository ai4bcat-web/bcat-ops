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
    // TSX twin of the CSS literal guard in theme.scope.test.ts: TMS surfaces take colour
    // from --tms-* tokens (or TmsAlert / TmsBadge), never a hex / rgb / hsl literal.
    // Data colours and PDF mattes: `// eslint-disable-next-line no-restricted-syntax -- data colour`.
    files: [
      'src/features/{tms,shipments,carriers,directory,quotes,ar,ap,factoring,vendor-ap,workflows,tracking,documents,settings,users,commissions,reports,audit}/**/*.{ts,tsx}',
      'src/components/{RepPicker,RequirePage}.tsx',
      'src/components/directory-picker/**/*.{ts,tsx}',
    ],
    // TrackPage (legacy truck tracking, /track/:code) is converted in S3; remove this exemption then.
    ignores: ['**/*.test.{ts,tsx}', 'src/features/tracking/TrackPage.tsx'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "Literal[value=/^\\s*(#[0-9a-fA-F]{3,8}|rgba?\\(|hsla?\\()/]",
          message: 'Use a --tms-* token (or TmsAlert/TmsBadge).',
        },
        {
          selector: "TemplateElement[value.raw=/^\\s*(#[0-9a-fA-F]{3,8}|rgba?\\(|hsla?\\()/]",
          message: 'Use a --tms-* token (or TmsAlert/TmsBadge).',
        },
      ],
    },
  },
])
