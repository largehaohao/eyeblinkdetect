import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    crx({ manifest }),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.{js,wasm}',
          dest: 'mediapipe-wasm',
          rename: { stripBase: true }
        },
        {
          src: 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.{js,wasm}',
          dest: 'mediapipe-wasm',
          rename: { stripBase: true }
        }
      ]
    })
  ],
  resolve: { alias: { '@': '/src' } },
  build: {
    target: 'esnext',
    sourcemap: false,
    rollupOptions: {
      input: {
        dashboard: 'src/dashboard/dashboard.html',
        offscreen: 'src/offscreen/offscreen.html',
        permission: 'src/permission/permission.html'
      }
    }
  }
});
