import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/main/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'jsdom',
          include: ['tests/react/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
