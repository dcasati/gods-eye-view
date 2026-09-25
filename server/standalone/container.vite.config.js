import { fileURLToPath } from 'node:url';
import { createBrowserViteConfig } from '../../build/vite.js';
import { browserRuntimeKeys } from './runtime-config.mjs';

const config = createBrowserViteConfig({ command: 'build' });

export default {
  ...config,
  root: fileURLToPath(new URL('../../', import.meta.url)),
  envDir: false,
  envPrefix: [],
  define: Object.fromEntries(
    browserRuntimeKeys.map((key) => [
      `import.meta.env.${key}`,
      `globalThis.__GEV_RUNTIME_CONFIG__.${key}`,
    ]),
  ),
  plugins: [
    ...config.plugins,
    {
      name: 'container-runtime-config',
      transformIndexHtml: {
        order: 'post',
        handler: () => [
          {
            tag: 'script',
            attrs: { src: '/api/runtime-config.js' },
            injectTo: 'head-prepend',
          },
        ],
      },
    },
  ],
};
