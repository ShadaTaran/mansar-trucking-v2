import base from '@mansar/config/eslint/base';
import nextVitals from 'eslint-config-next/core-web-vitals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.next/',
      '**/next-env.d.ts',
      'apps/mobile/android/',
    ],
  },
  ...base,
  // Next.js, React and React Hooks rules apply to the admin web app only.
  ...nextVitals.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{js,mjs,ts,tsx}'],
  })),
  // React and React Hooks rules for the driver mobile app (React Native).
  {
    files: ['apps/mobile/**/*.{js,ts,tsx}'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['apps/mobile/**/*.{js,ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  // React Native's tooling config files are CommonJS by convention.
  {
    files: ['apps/mobile/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { __dirname: 'readonly', __filename: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
