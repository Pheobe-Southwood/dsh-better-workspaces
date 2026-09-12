import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  { ignores: ['coverage/**', 'node_modules/**', 'LICENSES/**', '*.tgz'] },
  js.configs.recommended,
  {
    files: ['eslint.config.js', 'lib/**/*.js', 'test/**/*.{js,mjs}'],
    ignores: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.browser,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['test/client-react.mjs'],
    languageOptions: {
      globals: { ...globals.nodeBuiltin, ...globals.browser },
    },
  },
]);
