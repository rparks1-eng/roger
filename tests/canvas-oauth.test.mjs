import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { canvasCallback, readCanvasOAuthConfig } from '../src/server/canvas-oauth.mjs';
import { createReaderServer } from '../src/server/http.mjs';

test('Canvas sign-in is bound to the initiating browser, consumes its callback and refreshes access', async (t) => {
  let now = Date.now();
  const grants = [];
  const canvasTokens = [];
  const config = {
    clientId: '42',
    clientSecret: 'fixture-client-secret',
    scopes: ['url:GET|/api/v1/courses'],
  };
  const server = createReaderServer({
    clock: () => now,
    canvasOAuthConfig: config,
    canvasOAuthFetch: async (url, { body, redirect }) => {
      assert.equal(url.href, 'https://babson.instructure.com/login/oauth2/token');
      assert.equal(redirect, 'error');
      assert.equal(body.get('client_secret'), config.clientSecret);
      const kind = body.get('grant_type');
      grants.push(kind);
      if (kind === 'authorization_code') {
        assert.equal(body.get('code'), 'fixture-code');
        return Response.json({
          access_token: 'fixture-access-token',
          refresh_token: 'fixture-refresh-token',
          expires_in: 60,
        });
      }
      assert.equal(body.get('refresh_token'), 'fixture-refresh-token');
      return Response.json({ access_token: 'fixture-refreshed-token', expires_in: 60 });
    },
    canvasAdapter: {
      async validateCanvasToken(token) {
        assert.equal(token, 'fixture-access-token');
        return { name: 'Fixture Canvas user' };
      },
      async listCanvasCourses(token) {
        canvasTokens.push(token);
        return { courses: [], terms: [], currentTermId: null };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  config.redirectUri = origin + canvasCallback;
  const page = await fetch(origin);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  await page.arrayBuffer();
  const session = () =>
    fetch(origin + '/api/session', { headers: { cookie } }).then((response) => response.json());
  const initial = await session();
  assert.equal(initial.canvasSignInAvailable, true);
  const headers = {
    cookie,
    origin,
    'Content-Type': 'application/json',
    'X-Reader-CSRF': initial.csrf,
  };
  const start = () =>
    fetch(origin + '/api/canvas/oauth/start', { method: 'POST', headers, body: '{}' });
  const started = await start();
  const stateCookie = started.headers.get('set-cookie');
  assert.match(stateCookie, /HttpOnly; SameSite=Lax/);
  const auth = new URL((await started.json()).url);
  assert.equal(auth.origin, 'https://babson.instructure.com');
  assert.equal(auth.searchParams.get('scope'), config.scopes[0]);
  assert.equal(auth.searchParams.has('client_secret'), false);
  const callback =
    origin + canvasCallback + '?code=fixture-code&state=' + auth.searchParams.get('state');
  const wrongBrowser = await fetch(callback).then((response) => response.text());
  assert.match(wrongBrowser, /canvas=incomplete/);
  assert.deepEqual(grants, []);
  const complete = await fetch(callback, { headers: { cookie: stateCookie.split(';')[0] } }).then(
    (response) => response.text(),
  );
  assert.match(complete, /canvas=connected/);
  const replay = await fetch(callback, { headers: { cookie: stateCookie.split(';')[0] } }).then(
    (response) => response.text(),
  );
  assert.match(replay, /canvas=incomplete/);
  assert.deepEqual(grants, ['authorization_code']);
  const connected = await session();
  assert.equal(connected.canvas.name, 'Fixture Canvas user');
  assert.doesNotMatch(JSON.stringify(connected), /fixture-.*token|fixture-client-secret/);
  const course = () =>
    fetch(origin + '/api/canvas/courses', { headers: { cookie } }).then((response) =>
      response.json(),
    );
  await course();
  now += 32_000;
  await course();
  assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
  assert.deepEqual(canvasTokens, ['fixture-access-token', 'fixture-refreshed-token']);
});

test('Canvas OAuth config is optional and requires approved read-only scopes', () => {
  assert.equal(readCanvasOAuthConfig({}), null);
  const fixture = {
    READER_CANVAS_OAUTH_CLIENT_ID: '42',
    READER_CANVAS_OAUTH_CLIENT_SECRET: 'fixture',
    READER_CANVAS_OAUTH_REDIRECT_URI: 'http://127.0.0.1:3847' + canvasCallback,
    READER_CANVAS_OAUTH_SCOPES: 'url:GET|/api/v1/users/:user_id/profile url:GET|/api/v1/courses',
  };
  assert.equal(readCanvasOAuthConfig(fixture).scopes.length, 2);
  assert.throws(() =>
    readCanvasOAuthConfig({ ...fixture, READER_CANVAS_OAUTH_SCOPES: 'url:POST|/api/v1/courses' }),
  );
  assert.throws(() =>
    readCanvasOAuthConfig({
      ...fixture,
      READER_CANVAS_OAUTH_REDIRECT_URI: 'https://example.com/callback',
    }),
  );
});
