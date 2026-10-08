import * as oauth from 'oauth4webapi';
import { AppError, hash, randomToken, cookie, readCookie, redirect, fetchSafe,
  SESSION_COOKIE, LOGIN_COOKIE, SESSION_SECONDS } from './http.mjs';
import { acquisitionForLogin, startAcquisition, trackSafely, verifiedAcquisition } from './acquisition.mjs';
import { verificationProof, VERIFY_COOKIE } from './verification.mjs';

export const emailVerificationRequired = env => env.APP_REQUIRE_VERIFIED_EMAIL !== 'false';
// Auth0 Universal Login owns passwords, email verification and recovery. No passwords
// or provider tokens enter our database or browser storage. Auth0 app type: Regular Web App.
function provider(env) {
  const issuer = new URL(env.APP_AUTH_ISSUER).href;
  return { issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}oauth/token`,
    jwks_uri: `${issuer}.well-known/jwks.json`, id_token_signing_alg_values_supported: ['RS256'] };
}
const client = env => ({ client_id: env.APP_AUTH_CLIENT_ID, id_token_signed_response_alg: 'RS256' });
const callback = request => `${new URL(request.url).origin}/api/app/callback`;

export async function startLogin(request, env, deps, signup = false) {
  const as = provider(env), state = randomToken(), nonce = oauth.generateRandomNonce();
  const verifier = oauth.generateRandomCodeVerifier();
  const stateHash = await hash(env.APP_LIMIT_SECRET, `login:${state}`);
  await env.APP_DB.prepare('INSERT INTO app_logins(state_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)')
    .bind(stateHash, verifier, nonce, deps.now() + 600000).run();
  await trackSafely(env, deps, () => startAcquisition(request, env, stateHash, deps.now()));
  const url = new URL(as.authorization_endpoint);
  url.search = new URLSearchParams({ client_id: env.APP_AUTH_CLIENT_ID, response_type: 'code',
    redirect_uri: callback(request), scope: 'openid email', state, nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    prompt: 'login', max_age: '300', ...(signup ? { screen_hint: 'signup' } : {}) }).toString();
  return redirect(url.href, [cookie(LOGIN_COOKIE, state, 600)]);
}

export async function finishLogin(request, env, deps) {
  const url = new URL(request.url), state = readCookie(request, LOGIN_COOKIE);
  if (!state || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state)
    throw new AppError('LOGIN_STATE', 400);
  const stateHash = await hash(env.APP_LIMIT_SECRET, `login:${state}`);
  // Capture optional attribution before deleting the login and its cascading helper row.
  const visitId = await trackSafely(env, deps, () => acquisitionForLogin(env, stateHash));
  // Atomic consume prevents callback replay, even across edge instances.
  const pending = await env.APP_DB.prepare('DELETE FROM app_logins WHERE state_hash = ? AND expires_at > ? RETURNING verifier, nonce')
    .bind(stateHash, deps.now()).first();
  if (!pending) throw new AppError('LOGIN_STATE', 400);
  const as = provider(env), c = client(env);
  const params = oauth.validateAuthResponse(as, c, url, state);
  const options = { [oauth.customFetch]: (target, init) => fetchSafe(deps, target, init) };
  const tokenResponse = await oauth.authorizationCodeGrantRequest(as, c,
    oauth.ClientSecretPost(env.APP_AUTH_CLIENT_SECRET), params, callback(request), pending.verifier, options);
  const result = await oauth.processAuthorizationCodeResponse(as, c, tokenResponse,
    { expectedNonce: pending.nonce, requireIdToken: true, maxAge: 300 });
  await oauth.validateApplicationLevelSignature(as, tokenResponse, options);
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims?.sub) throw new AppError('VERIFY_EMAIL', 403);
  // Email verification can be switched off (APP_REQUIRE_VERIFIED_EMAIL=false): the app identifies
  // people by their sign-in account and never uses the email itself, and points, orders and
  // notifications only connect to a customer record through a staff code given in person.
  if (claims.email_verified !== true && emailVerificationRequired(env)) {
    let proof;
    try { proof = await verificationProof(env, claims.sub, deps.now()); }
    catch { deps.report('VERIFY_SETUP'); }
    return redirect('/app/#verify-email', [cookie(LOGIN_COOKIE, '', 0), proof || cookie(VERIFY_COOKIE, '', 0)]);
  }
  // Stable opaque identity; rotating the session/limiter secret must not orphan accounts.
  const identity = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify([as.issuer, claims.sub])))), b => b.toString(16).padStart(2, '0')).join('');
  const inserted = await env.APP_DB.prepare('INSERT INTO app_users(id, identity_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(identity_hash) DO NOTHING RETURNING id')
    .bind(randomToken(), identity, deps.now()).first();
  const user = await env.APP_DB.prepare('SELECT id, customer_id FROM app_users WHERE identity_hash = ?').bind(identity).first();
  if (!user) throw new AppError('LOGIN_SAVE');
  if (inserted) await trackSafely(env, deps, () => verifiedAcquisition(env, user.id, visitId, deps.now()));
  const token = randomToken();
  const oldToken = readCookie(request, SESSION_COOKIE);
  const statements = [env.APP_DB.prepare('INSERT INTO app_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hash(env.APP_LIMIT_SECRET, `session:${token}`), user.id, deps.now(), deps.now() + SESSION_SECONDS * 1000)];
  if (oldToken) statements.push(env.APP_DB.prepare('DELETE FROM app_sessions WHERE token_hash = ?')
    .bind(await hash(env.APP_LIMIT_SECRET, `session:${oldToken}`)));
  await env.APP_DB.batch(statements);
  return redirect(user.customer_id ? '/app/#rewards' : '/app/#setup', [cookie(LOGIN_COOKIE, '', 0), cookie(VERIFY_COOKIE, '', 0), cookie(SESSION_COOKIE, token, SESSION_SECONDS)]);
}

export async function session(request, env, deps) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hash(env.APP_LIMIT_SECRET, `session:${token}`);
  const row = await env.APP_DB.prepare(`SELECT u.id, u.customer_id, u.license_enc, u.license_hint, s.created_at FROM app_sessions s
    JOIN app_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(tokenHash, deps.now()).first();
  return row ? { ...row, tokenHash, csrf: await hash(env.APP_LIMIT_SECRET, `csrf:${token}`) } : null;
}

export async function logout(env, s, everywhere = false) {
  if (s) await env.APP_DB.prepare(everywhere ? 'DELETE FROM app_sessions WHERE user_id = ?'
    : 'DELETE FROM app_sessions WHERE token_hash = ?').bind(everywhere ? s.id : s.tokenHash).run();
  return cookie(SESSION_COOKIE, '', 0);
}
