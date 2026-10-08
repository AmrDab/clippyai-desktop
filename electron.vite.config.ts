import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    // zod is a transitive dep (via @modelcontextprotocol/sdk) used by
    // agent-tools.ts; externalize it so the main bundle shares the SDK's
    // copy instead of inlining a second one.
    plugins: [externalizeDepsPlugin({ include: ['zod'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          onboarding: resolve(__dirname, 'src/renderer/onboarding.html'),
          logs: resolve(__dirname, 'src/renderer/logs.html'),
          'writing-card': resolve(__dirname, 'src/renderer/writing-card.html'),
          'writing-badge': resolve(__dirname, 'src/renderer/writing-badge.html'),
        },
      },
    },
  },
});
