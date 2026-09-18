import base from '@mansar/config/eslint/base';

export default [
  {
    ignores: ['**/node_modules/', '**/dist/', '**/coverage/', '**/.next/'],
  },
  ...base,
];
