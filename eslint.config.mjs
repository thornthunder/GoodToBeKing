import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import { defineConfig } from 'eslint/config'

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    // The admin's page (src/admin/ui): plain browser modules, no build step.
    files: ['src/admin/ui/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: Object.fromEntries(
        [
          'window',
          'document',
          'location',
          'fetch',
          'console',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'URLSearchParams',
          'Node',
          'Event',
          'structuredClone',
        ].map((name) => [name, 'readonly'])
      ),
    },
  },
])
