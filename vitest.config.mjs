import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only our own tests; vendor/bedboo has its own mocha suite.
    include: ['src/**/*.test.ts'],
  },
})
