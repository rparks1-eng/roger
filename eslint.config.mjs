import js from '@eslint/js';
import globals from 'globals';
export default [
  {
    ignores: [
      'node_modules/**',
      '.venv/**',
      'public/vendor/**',
      'src/core/**',
      'migration/**',
      'engineering/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{mjs,cjs}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['src/client/**/*.mjs', 'scripts/*smoke.mjs'],
    languageOptions: { globals: globals.browser },
  },
];
