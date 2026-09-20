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
      'apps/api/src/generated/',
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
  // Credential-storage guard (Stage 3E): the driver app's authentication
  // code must keep the refresh token in Keystore-backed secure storage and
  // the access token in memory. AsyncStorage is plain, unencrypted app
  // storage, so it is forbidden here. The guard is scoped to the auth area
  // on purpose: later offline trip/location features may legitimately use
  // AsyncStorage for non-secret data.
  {
    files: ['apps/mobile/src/auth/**/*.{js,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@react-native-async-storage/async-storage',
              message:
                'Authentication credentials must not use AsyncStorage; use the Keychain-backed AuthSecretStore.',
            },
          ],
        },
      ],
      'no-restricted-modules': [
        'error',
        {
          paths: [
            {
              name: '@react-native-async-storage/async-storage',
              message:
                'Authentication credentials must not use AsyncStorage; use the Keychain-backed AuthSecretStore.',
            },
          ],
        },
      ],
    },
  },
  // API maintenance scripts run directly under Node (ESM).
  {
    files: ['apps/api/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
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
