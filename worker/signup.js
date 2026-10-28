// Erased Century signup relay (Cloudflare Worker)
//
// The website's own email form sends { email, token, utm_* } here.
// This checks the Google reCAPTCHA token, then adds the email to Beehiiv
// through its API. Keys live in Cloudflare as secrets, never in the website code.
//
// Secrets to set in Cloudflare (Settings > Variables and Secrets):
//   BEEHIIV_API_KEY      your Beehiiv API key
//   RECAPTCHA_SECRET     the reCAPTCHA *secret* key for erasedcentury.com
// Plain variable:
//   BEEHIIV_PUBLICATION_ID = pub_1ff062b4-35b2-4de9-930d-82c8a6939bbe

const ALLOWED_ORIGINS = [
  'https://erasedcentury.com',
  'https://www.erasedcentury.com',
  'http://localhost:3000',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!ALLOWED_ORIGINS.includes(origin)) return reply(403, { error: 'origin_not_allowed' });

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: 'bad_request' }); }

    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return reply(400, { error: 'invalid_email' });
    }

    // 1) Google reCAPTCHA check
    const check = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      body: new URLSearchParams({
        secret: env.RECAPTCHA_SECRET,
        response: String(body.token || ''),
        remoteip: request.headers.get('CF-Connecting-IP') || '',
      }),
    }).then(r => r.json()).catch(() => ({ success: false }));
    if (!check.success) return reply(400, { error: 'captcha_failed' });

    // 2) Add to Beehiiv
    const tag = v => String(v || '').slice(0, 80).replace(/[^\w\-.]/g, '');
    const payload = {
      email,
      reactivate_existing: false,
      send_welcome_email: true,
      utm_source: tag(body.utm_source) || 'website',
      utm_medium: tag(body.utm_medium) || 'website',
      utm_campaign: tag(body.utm_campaign) || 'site-signup',
      referring_site: 'erasedcentury.com' + String(body.page || '').slice(0, 80).replace(/[^\w\-./]/g, ''),
    };
    const content = tag(body.utm_content);
    if (content) payload.utm_content = content;

    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${env.BEEHIIV_PUBLICATION_ID}/subscriptions`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.BEEHIIV_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      console.log('Beehiiv error', res.status, await res.text());
      return reply(502, { error: 'signup_failed' });
    }
    return reply(200, { ok: true });
  },
};
