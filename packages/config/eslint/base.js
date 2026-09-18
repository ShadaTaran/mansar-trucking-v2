import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Base ESLint flat config for the Mansar v2 monorepo.
 *
 * Framework-neutral: no React, Next, React Native or Nest rules here.
 * Applications compose this with their own framework presets.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
