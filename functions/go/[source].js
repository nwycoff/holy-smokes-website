import { SIGNUP_SOURCES } from '../../server/customer-app/acquisition.mjs';

// Permanent printed destinations, fixed to the app on the SAME host. No open redirect,
// customer identifiers, credentials, tracking cookies, or database writes on a QR preview GET.
export function onRequest({ request, params }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  if (!Object.hasOwn(SIGNUP_SOURCES, params.source) || params.source === 'direct') return new Response('Not found', { status: 404, headers });
  return new Response(null, { status: 303, headers: { ...headers, Location: `/app/?from=${params.source}#setup` } });
}
