import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveRelayProxyTarget } from './src/shared/relay-proxy-target.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const relayTarget = resolveRelayProxyTarget(env);

  return {
    root: 'src/client',
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 3001,
      strictPort: true,
      proxy: {
        '/socket.io': { target: relayTarget, ws: true },
        '/health': relayTarget,
        '/debug/dom-export': relayTarget,
        '/debug': relayTarget,
        '/api': relayTarget,
        '/login': relayTarget,
      },
    },
    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
    },
  };
});
