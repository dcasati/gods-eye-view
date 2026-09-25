import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import connect from 'connect';
import sirv from 'sirv';
import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { runtimeConfigMiddleware } from './runtime-config.mjs';

const defaultDist = fileURLToPath(new URL('../../dist/', import.meta.url));

export async function createProductionServer({
  dist = defaultDist,
  env = process.env,
  providers = localProviderPlugins(),
} = {}) {
  await access(path.join(dist, 'index.html'));
  const middlewares = connect();
  const httpServer = createServer(middlewares);
  let ready = true;

  middlewares.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    const pathname = req.url?.split('?')[0];
    if (pathname !== '/healthz' && pathname !== '/readyz') return next();
    res.writeHead(pathname === '/readyz' && !ready ? 503 : 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ status: ready ? 'ok' : 'draining' }));
  });
  middlewares.use(runtimeConfigMiddleware(env));

  // Provider preview hooks are Connect installers, not a Vite runtime dependency.
  // Deliberately exclude dev-only hooks, including the credential-editing API.
  for (const plugin of [...providers, apiNotFoundPlugin()]) {
    if (plugin.configurePreviewServer) {
      await plugin.configurePreviewServer({ middlewares, httpServer });
    }
  }
  middlewares.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
  });
  middlewares.use(
    sirv(dist, {
      dotfiles: false,
      etag: true,
      setHeaders(res, pathname) {
        res.setHeader(
          'Cache-Control',
          !path.extname(pathname) || pathname.endsWith('.html')
            ? 'no-cache'
            : 'public, max-age=3600',
        );
      },
    }),
  );
  middlewares.use((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  middlewares.use((error, _req, res, _next) => {
    console.error('[server] Request failed:', error);
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });

  return {
    httpServer,
    close() {
      ready = false;
      return new Promise((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function startProductionServer(env = process.env) {
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const app = await createProductionServer({ env });
  await new Promise((resolve, reject) => {
    app.httpServer.once('error', reject);
    app.httpServer.listen(port, env.HOST || '127.0.0.1', resolve);
  });
  console.log(`[server] Listening on ${env.HOST || '127.0.0.1'}:${port}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error('[server] Graceful shutdown timed out');
      process.exit(1);
    }, 25000);
    deadline.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error('[server] Shutdown failed:', error);
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return app;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startProductionServer().catch((error) => {
    console.error('[server] Startup failed:', error);
    process.exit(1);
  });
}
