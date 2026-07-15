import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDirectory = path.dirname(fileURLToPath(import.meta.url))

export default {
  root: path.resolve(testsDirectory, '..'),
  logLevel: 'error',
  resolve: {
    alias: {
      'n8n-workflow': path.resolve(testsDirectory, '../node_modules/n8n-workflow/dist/esm/index.js'),
    },
  },
  test: {
    include: ['test/**/*.test.mts'],
  },
}
