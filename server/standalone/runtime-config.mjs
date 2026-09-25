export const browserRuntimeKeys = Object.freeze([
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  'VITE_AIS_LIVE_API_URL',
  'VITE_AIS_LIVE_MAX_ROWS',
  'VITE_AIS_LIVE_LABEL_MAX_ROWS',
]);

export function browserRuntimeConfig(env = process.env) {
  return Object.fromEntries(
    browserRuntimeKeys.map((key) => [key, String(env[key] ?? '')]),
  );
}

export function runtimeConfigMiddleware(env = process.env) {
  return (req, res, next) => {
    if (req.url?.split('?')[0] !== '/api/runtime-config.js') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : `globalThis.__GEV_RUNTIME_CONFIG__ = Object.freeze(${JSON.stringify(browserRuntimeConfig(env))});\n`,
    );
  };
}
