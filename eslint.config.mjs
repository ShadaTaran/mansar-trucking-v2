import base from '@mansar/config/eslint/base';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default [
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.next/',
      '**/next-env.d.ts',
    ],
  },
  ...base,
  // Next.js, React and React Hooks rules apply to the admin web app only.
  ...nextVitals.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{js,mjs,ts,tsx}'],
  })),
];
