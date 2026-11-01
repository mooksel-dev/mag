import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Workspace packages ship TypeScript sources, so they must be bundled, not externalized.
const workspace = ['@mag/core', '@mag/agents', '@mag/arch', '@mag/diff']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Stdio MCP server that agents spawn to read and update the task.
          'task-mcp': resolve(__dirname, 'src/main/task-mcp.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
  },
  renderer: {
    plugins: [react()],
  },
})
