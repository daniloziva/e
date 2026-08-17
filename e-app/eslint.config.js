// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Two jobs, deliberately separated:
 *
 *   src/**   — full type-checked linting. This is the code under suspicion.
 *              src/engine/** additionally may never import an adapter.
 *   test/**  — ONLY the rules that enforce the test freeze. The unit suite is
 *              frozen (TEST-FREEZE.md), so a lint rule that demanded an edit to
 *              an assertion would put eslint and the freeze in direct conflict.
 *              Type-checked rules are off there for exactly that reason.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'test/_drafts/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Workspace non-negotiable: no `any`. Use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      // Stubs are `_`-prefixed until implemented; that prefix is the opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // ── engine purity (01-ARCHITECTURE §4, and the M0 gate) ───────────────────
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters', '**/adapters/**'],
              message:
                'engine/ never imports adapters/ — the pure layer stays pure (01-ARCHITECTURE §4). Inject the dependency instead.',
            },
          ],
        },
      ],
    },
  },

  // ── test freeze enforcement (TEST-FREEZE.md "Rules the suite enforces") ────
  {
    files: ['test/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // Off in test/** on purpose: the suite is frozen, so a rule that can only
      // be satisfied by editing a frozen file would force an UNFREEZE for a
      // cosmetic nit. Both stay on for src/**.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-useless-assignment': 'off',

      'no-restricted-syntax': [
        'error',
        {
          // Learned the hard way: a bare .toThrow() goes green the moment it is
          // written, because every stub throws `not implemented`. A test that
          // passes before the code exists is not a test.
          //
          // The `!='not'` guard is load-bearing: `.not.toThrow()` takes no
          // argument by construction and is a legitimate assertion.
          selector:
            "CallExpression[callee.property.name=/^(toThrow|toThrowError)$/][arguments.length=0][callee.object.property.name!='not']",
          message:
            'Argument-less .toThrow() passes against a `not implemented` stub. Assert the specific rejection message via the local expectRejects helper (TEST-FREEZE.md).',
        },
        {
          selector:
            'MemberExpression[object.name=/^(describe|it|test)$/][property.name=/^(only|skip|todo)$/]',
          message:
            'The unit suite is frozen: no .only, .skip or .todo. Unfreezing requires a ruling and its own UNFREEZE: commit (TEST-FREEZE.md).',
        },
      ],
    },
  },
)
