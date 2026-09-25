import assert from 'node:assert/strict';
import https from 'node:https';

export function requestEdge(
  origin,
  pathname,
  { address, port, ca, headers = {}, method = 'GET' } = {},
) {
  const url = new URL(pathname, origin);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: address || url.hostname,
        servername: url.hostname,
        port: port || url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        ca,
        minVersion: 'TLSv1.2',
        headers: { Host: url.host, ...headers },
        timeout: 15000,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024)
            request.destroy(new Error('Unexpected oversized edge response'));
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
          }),
        );
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('Edge request timed out')),
    );
    request.on('error', reject);
    request.end();
  });
}

export async function probeEdge(
  { origin, tenantId, clientId },
  connection = {},
) {
  const request = (path, options = {}) =>
    requestEdge(origin, path, { ...connection, ...options });
  for (const path of ['/oauth2/ping', '/oauth2/ready']) {
    assert.equal(
      (await request(path)).status,
      200,
      `Proxy probe failed: ${path}`,
    );
  }
  const authorize = new URL(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
  );
  function checkRedirect(response) {
    assert.equal(
      response.status,
      302,
      'Expected authentication redirect, not upstream content',
    );
    const location = new URL(response.headers.location);
    assert.equal(location.origin + location.pathname, authorize.href);
    assert.equal(location.searchParams.get('client_id'), clientId);
    assert.equal(
      location.searchParams.get('redirect_uri'),
      `${origin}/oauth2/callback`,
    );
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.match(
      location.searchParams.get('code_challenge') || '',
      /^[\w-]{43}$/,
    );
    assert.ok(location.searchParams.get('state'));
    assert.ok(location.searchParams.get('nonce'));
    assert.equal(location.searchParams.get('scope'), 'openid');
    const cookies = response.headers['set-cookie'] || [];
    assert.ok(
      cookies.some((cookie) => /^__Host-gev_session_[\w-]+_csrf=/.test(cookie)),
      `Missing CSRF cookie; names: ${cookies.map((cookie) => cookie.split('=')[0]).join(', ')}`,
    );
    for (const cookie of cookies) {
      assert.match(cookie, /;\s*Secure(?:;|$)/i);
      assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
      assert.match(cookie, /;\s*SameSite=Lax(?:;|$)/i);
      assert.match(cookie, /;\s*Path=\/(?:;|$)/i);
      assert.doesNotMatch(cookie, /;\s*Domain=/i);
    }
  }
  checkRedirect(await request('/'));
  const variants = [
    {},
    { Cookie: '__Host-gev_session=forged' },
    {
      Authorization: 'Bearer forged',
      'X-Forwarded-User': 'forged',
      'X-Forwarded-Email': 'forged@example.invalid',
      'X-Auth-Request-User': 'forged',
      'X-Forwarded-Access-Token': 'forged',
      'X-Forwarded-Host': 'attacker.invalid',
      'X-Forwarded-Proto': 'http',
      'X-Auth-Request-Redirect': 'https://attacker.invalid/',
      'X-Forwarded-Uri': '/oauth2/ping',
    },
  ];
  const paths = [
    '/',
    '/index.html',
    '/assets/auth-probe.js',
    '/healthz',
    '/readyz',
    '/api/runtime-config.js',
    '/api/overpass',
    '/api/tomtom/flow',
    '/api/ais-live',
    '/api/realtime/token',
    '/api/settings',
    '/api/unknown-auth-probe',
  ];
  let checks = 2;
  for (const headers of variants) {
    for (const path of paths) {
      const response = await request(path, { headers });
      if (path.startsWith('/api/'))
        assert.equal(response.status, 401, `API bypass: ${path}`);
      else checkRedirect(response);
      checks++;
    }
  }
  for (const method of ['POST', 'OPTIONS']) {
    assert.equal(
      (await request('/api/realtime/token', { method })).status,
      401,
      `${method} bypass`,
    );
    checks++;
  }
  for (const path of ['/api/ais-live', '/ws']) {
    const response = await request(path, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assert.ok(
      [302, 401, 403].includes(response.status),
      `WebSocket bypass: ${path}`,
    );
    checks++;
  }
  assert.equal(
    (await request('/oauth2/auth', { headers: variants[2] })).status,
    401,
  );
  const callback = await request('/oauth2/callback?code=invalid&state=invalid');
  assert.ok(
    [400, 403, 500].includes(callback.status),
    `Invalid callback was accepted: ${callback.status}`,
  );
  checks += 2;
  // A malicious post-login destination must not survive in the OAuth state.
  const malicious = await request(
    '/oauth2/start?rd=https%3A%2F%2Fattacker.invalid%2F',
  );
  checkRedirect(malicious);
  assert.ok(
    !new URL(malicious.headers.location).searchParams
      .get('state')
      .includes('attacker.invalid'),
  );
  return {
    negativeChecks: checks + 1,
    trustedTLS: !connection.ca,
    authenticatedSignIn: 'not tested',
  };
}
