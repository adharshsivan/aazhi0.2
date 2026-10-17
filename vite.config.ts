import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      target: 'es2020',
      rollupOptions: {
        // keep three.js in its own long-cacheable chunk
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/three/')) return 'three';
            if (id.includes('node_modules/three-mesh-bvh') || id.includes('node_modules/clipper-lib')) return 'vendor';
          },
        },
      },
      chunkSizeWarningLimit: 800,
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
