import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function createChallengeServer(directory) {
  return createServer((request, response) => {
    try {
      const token = readFileSync(`${directory}/token`, 'utf8').trim();
      const authorization = readFileSync(
        `${directory}/authorization`,
        'utf8',
      ).trim();
      if (
        request.method === 'GET' &&
        /^[\w-]{20,}$/.test(token) &&
        authorization.startsWith(`${token}.`) &&
        request.url === `/.well-known/acme-challenge/${token}`
      ) {
        response.writeHead(200, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        response.end(authorization);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      console.error(`ACME token read failed: ${error.code || error.name}`);
      response.writeHead(503);
      response.end();
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  createChallengeServer(process.env.TOKEN_DIRECTORY || '/tokens').listen(
    Number(process.env.PORT || 8080),
    '0.0.0.0',
  );
}
