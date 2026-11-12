import { randomBytes } from 'node:crypto';
import { CANVAS_ORIGIN } from './canvas.mjs';
import { HttpError } from './security.mjs';

export const canvasCallback = '/api/canvas/oauth/callback';
const cookieName = 'roger_canvas_oauth';
const attemptTtl = 300_000;

export function readCanvasOAuthConfig(env = process.env) {
  const clientId = env.READER_CANVAS_OAUTH_CLIENT_ID;
  const clientSecret = env.READER_CANVAS_OAUTH_CLIENT_SECRET;
  const redirectUri = env.READER_CANVAS_OAUTH_REDIRECT_URI;
  const scopes = env.READER_CANVAS_OAUTH_SCOPES?.trim().split(/\s+/);
  if (!clientId && !clientSecret && !redirectUri && !scopes) return null;
  if (
    !/^\d{1,30}$/.test(clientId || '') ||
    !clientSecret ||
    !new RegExp(`^http://127\\.0\\.0\\.1:[0-9]{4,5}${canvasCallback}$`).test(redirectUri || '') ||
    !scopes?.length ||
    scopes.some((scope) => !/^url:GET\|\/api\/v1\/[a-zA-Z0-9_/:.-]+$/.test(scope))
  )
    throw new Error(
      'Configure the approved Canvas developer key, loopback callback and read scopes.',
    );
  return { clientId, clientSecret, redirectUri, scopes: [...new Set(scopes)] };
}

export function createCanvasOAuth({ config, now, fetcher = fetch, validate }) {
  const attempts = new Map();
  const enabled = (origin) => config?.redirectUri === origin + canvasCallback;
  const cookie = (state, seconds) =>
    `${cookieName}=${state}; HttpOnly; SameSite=Lax; Path=${canvasCallback}; Max-Age=${seconds}`;
  function cancel(session) {
    if (session.canvasOAuthAttempt) attempts.delete(session.canvasOAuthAttempt);
    delete session.canvasOAuthAttempt;
  }
  function clear(session) {
    cancel(session);
    delete session.canvasGrant;
  }
  function begin(session, origin) {
    if (!enabled(origin))
      throw new HttpError(409, 'Canvas sign-in needs a school-approved connection.');
    cancel(session);
    for (const [state, attempt] of attempts) {
      if (attempt.expiresAt <= now()) attempts.delete(state);
    }
    const state = randomBytes(32).toString('hex');
    attempts.set(state, { session, expiresAt: now() + attemptTtl });
    session.canvasOAuthAttempt = state;
    const url = new URL('/login/oauth2/auth', CANVAS_ORIGIN);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
    });
    return { url: url.href, cookie: cookie(state, attemptTtl / 1000) };
  }
  async function exchange(parameters) {
    const response = await fetcher(new URL('/login/oauth2/token', CANVAS_ORIGIN), {
      method: 'POST',
      redirect: 'error',
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        ...parameters,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HttpError(502, 'Canvas could not complete sign-in.');
    const result = await response.json();
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in < 1
    )
      throw new HttpError(502, 'Canvas returned an incomplete sign-in response.');
    return result;
  }
  async function finish(url, header, signal) {
    if (!enabled(url.origin)) return false;
    const state = url.searchParams.get('state');
    const browserState = new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{64})(?:;|$)`).exec(
      header || '',
    )?.[1];
    const attempt = attempts.get(state);
    if (!attempt || browserState !== state || attempt.expiresAt <= now()) return false;
    attempts.delete(state);
    const { session } = attempt;
    try {
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length > 4096) return false;
      const result = await exchange({ grant_type: 'authorization_code', code });
      if (typeof result.refresh_token !== 'string' || !result.refresh_token) return false;
      const profile = await validate(result.access_token, { signal });
      if (session.canvasOAuthAttempt !== state) return false;
      session.token = result.access_token;
      session.profile = profile;
      session.canvasGrant = {
        refreshToken: result.refresh_token,
        expiresAt: now() + result.expires_in * 1000,
      };
      return session;
    } catch {
      return false;
    } finally {
      if (session.canvasOAuthAttempt === state) delete session.canvasOAuthAttempt;
    }
  }
  async function token(session) {
    const grant = session.canvasGrant;
    if (!grant || grant.expiresAt - now() > 30_000) return session.token;
    grant.refreshing ??= exchange({
      grant_type: 'refresh_token',
      refresh_token: grant.refreshToken,
    })
      .then((result) => {
        if (session.canvasGrant !== grant) return;
        session.token = result.access_token;
        grant.expiresAt = now() + result.expires_in * 1000;
      })
      .finally(() => delete grant.refreshing);
    try {
      await grant.refreshing;
    } catch {
      throw new HttpError(409, 'Canvas sign-in expired. Reconnect in Settings.');
    }
    return session.token;
  }
  return { enabled, begin, finish, token, clear };
}
