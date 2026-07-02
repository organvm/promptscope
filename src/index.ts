/**
 * PromptScope — Cloudflare Worker (replaces Pages Functions setup)
 *
 * Single Worker handles:
 *   - Static assets (public/) via ASSETS binding
 *   - /api/analyze, /api/share, /api/checkout, /api/payment-info
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  RATE_KV: KVNamespace;
  SHARE_KV: KVNamespace;
  PROMPTSCOPE_PRO_TOKENS: KVNamespace;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID_PRO?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PROMPTSCOPE_BASE_URL?: string;
  CRYPTO_PAY_ADDRESS?: string;
  CRYPTO_CHAIN?: string;
  // Shared fleet money rail. PAYRAIL is a service binding (preferred — a direct
  // internal worker→worker call that skips the public edge, so it dodges both the
  // *.workers.dev same-zone restriction and edge bot-management). PAYRAIL_URL is the
  // public-hostname fallback (used when the binding is absent, e.g. local/standby).
  // SHIP_HMAC_SECRET (a wrangler secret, unset by default) signs receipt writes.
  PAYRAIL?: Fetcher;
  PAYRAIL_URL?: string;
  SHIP_HMAC_SECRET?: string;
}

const FREE_DAILY_LIMIT = 5;
const MAX_PROMPT_CHARS = 32_000;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30;

// === payrail (shared fleet money rail) ===
// promptscope plugs into the live payrail Worker instead of re-implementing
// "wallet unset / no checkout". payrail returns where to send money + a memo
// (quote_id); the buyer pays on-chain, then /api/confirm records the receipt.
const PAYRAIL_DEFAULT = 'https://payrail.ivixivi.workers.dev';
const PRO_PRICE = '19';
const PENDING_TTL_SECONDS = 604800; // 7 days

interface PayrailQuote {
  quote_id: string;
  pay_to: { rail: string; chain: string; asset: string; address: string; amount: string } | null;
  checkout: string | null;
  instructions: string;
  expires_in_seconds: number;
}

// Single egress point to payrail. Prefers the service binding (an internal
// worker→worker call that never touches the public edge → immune to both the
// *.workers.dev same-zone restriction and edge bot-management). Falls back to the
// public hostname with a browser UA so even the fallback clears bot filters. When
// the binding is used the host in the URL is ignored — only path/query/method/body.
function payrailFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.PAYRAIL) return env.PAYRAIL.fetch(new Request(`https://payrail${path}`, init));
  const base = env.PAYRAIL_URL ?? PAYRAIL_DEFAULT;
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0 (compatible; promptscope/1.0; +https://promptscope.ivixivi.workers.dev)');
  }
  return fetch(base + path, { ...init, headers });
}

async function payrailQuote(env: Env): Promise<PayrailQuote> {
  const qs = new URLSearchParams({
    ship: 'promptscope',
    sku: 'promptscope:pro',
    amount: PRO_PRICE,
    currency: 'USDC',
  });
  const r = await payrailFetch(env, `/pay?${qs.toString()}`);
  if (!r.ok) throw new Error(`payrail /pay ${r.status}`);
  return r.json();
}

// HMAC-SHA256 hex, byte-identical to payrail's hmac() so timingSafeEqual passes.
// Only used when SHIP_HMAC_SECRET is set (payrail has none today → optional).
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const SYSTEM_PROMPT = `You are PromptScope, an expert in LLM system-prompt design.

You analyze a system prompt and return JSON with this exact shape:
{
  "score": <number 0..10>,
  "anti_patterns": [{"name": "<short label>", "fix": "<one-sentence fix>"}, ...],
  "strengths": ["<short string>", ...]
}

Look for these anti-patterns:
- Vague instructions ("be helpful", "use good judgment")
- Role/persona contradictions
- Missing output format / schema
- Persona declared before task (slows model)
- Walls of text without structure
- Capability over-claims ("you can do anything")
- Missing examples (when task is non-obvious)
- Missing explicit constraints / refusal cases
- Ambiguous tool-use assumptions
- Excessive boilerplate
- Conflicting instructions

Strengths to credit:
- Clear role and task definition
- Explicit output schema
- Few-shot examples present
- Boundary cases named
- Concise, structured prose
- Tool use guidance is specific

Score guideline: 0=incoherent, 5=passable, 7=production-ready, 9=excellent, 10=exemplary.
Return ONLY valid JSON, no markdown, no preamble.`;

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

function tryParseJson(s: unknown): any | null {
  if (s == null) return null;
  // Workers AI may return objects directly when response_format is JSON.
  if (typeof s === 'object') return s;
  const str = typeof s === 'string' ? s : String(s);
  const cleaned = str.replace(/^```json\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function rateCheck(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const current = Number(await env.RATE_KV.get(key) ?? 0);
  if (current >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
}

async function isProAuth(value: string | undefined, env: Env): Promise<boolean> {
  if (!value) return false;
  return (await env.PROMPTSCOPE_PRO_TOKENS.get(value)) === 'active';
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleAnalyze(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json({
      description: 'PromptScope analyze API',
      method: 'POST /api/analyze',
      body: { prompt: 'string up to 32k chars' },
      auth_header_optional: 'x-promptscope-key',  // value: pro membership key
      free_limit: '5 / IP / day',
    });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const prompt = String(body?.prompt ?? '');
  if (!prompt) return Response.json({ error: 'missing prompt' }, { status: 400 });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Response.json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} chars` }, { status: 400 });
  }

  const proAuth = req.headers.get('x-promptscope-token') ?? undefined;
  const isPro = await isProAuth(proAuth, env);

  let remaining: number | undefined;
  if (!isPro) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const rl = await rateCheck(ip, env);
    if (!rl.allowed) {
      return Response.json({ error: 'daily free quota exhausted; upgrade to Pro for unlimited' }, { status: 429 });
    }
    remaining = rl.remaining;
  }

  let aiResp: any;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Analyze this system prompt:\n\n---\n${prompt}\n---` },
      ],
      max_tokens: 1500,
    });
  } catch (err) {
    return Response.json({ error: `inference failed: ${(err as Error).message}` }, { status: 500 });
  }

  const raw = aiResp?.response ?? aiResp?.result ?? aiResp ?? '';
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed.score !== 'number') {
    return Response.json({
      error: 'analysis output malformed',
      raw_type: typeof raw,
      raw_preview: typeof raw === 'string' ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500),
    }, { status: 502 });
  }

  let suggested_rewrite: string | undefined;
  if (isPro) {
    try {
      const rewriteResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'You are an expert prompt engineer. Rewrite the user-provided system prompt to remove anti-patterns, improve structure, and tighten language. Preserve all original intent. Return ONLY the rewritten prompt.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
      });
      suggested_rewrite = String(rewriteResp?.response ?? rewriteResp?.result ?? '').trim();
    } catch {}
  }

  return Response.json({
    score: Math.max(0, Math.min(10, parsed.score)),
    token_count: approxTokens(prompt),
    char_count: prompt.length,
    anti_patterns: Array.isArray(parsed.anti_patterns) ? parsed.anti_patterns.slice(0, 12) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 8) : [],
    ...(suggested_rewrite && { suggested_rewrite }),
    ...(remaining !== undefined && { quota_remaining: remaining }),
  });
}

async function handleShare(req: Request, env: Env): Promise<Response> {
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
    const prompt = String(body?.prompt ?? '');
    if (!prompt) return Response.json({ error: 'missing prompt' }, { status: 400 });
    if (prompt.length > MAX_PROMPT_CHARS) return Response.json({ error: 'prompt too long' }, { status: 400 });
    const id = newId();
    await env.SHARE_KV.put(id, prompt, { expirationTtl: SHARE_TTL_SECONDS });
    return Response.json({ id, expires_in_seconds: SHARE_TTL_SECONDS });
  }
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return Response.json({ error: 'invalid id' }, { status: 400 });
    const prompt = await env.SHARE_KV.get(id);
    if (!prompt) return Response.json({ error: 'not found or expired' }, { status: 404 });
    return Response.json({ id, prompt });
  }
  return new Response('method not allowed', { status: 405 });
}

// Buy route. Creates a Stripe Checkout Session and redirects.
async function handleCheckout(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID_PRO) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  const token = newId();
  await env.PROMPTSCOPE_PRO_TOKENS.put(`pending:${token}`, 'stripe_pending', { expirationTtl: 86400 });

  const origin = env.PROMPTSCOPE_BASE_URL || new URL(req.url).origin;
  const params = new URLSearchParams({
    'success_url': `${origin}/?success=true&token=${token}`,
    'cancel_url': `${origin}/?cancel=true`,
    'mode': 'subscription',
    'client_reference_id': token,
  });
  params.append('line_items[0][price]', env.STRIPE_PRICE_ID_PRO);
  params.append('line_items[0][quantity]', '1');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  
  const data = await res.json() as any;
  if (!res.ok) {
    return Response.json({ error: data.error?.message || 'Stripe error' }, { status: 502 });
  }
  
  return Response.json({ checkout_url: data.url });
}

async function verifyStripeSignature(payload: string, sigHeader: string, secret: string) {
  const sigs = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {} as Record<string, string>);
  
  if (!sigs.t || !sigs.v1) return false;
  
  const signedPayload = `${sigs.t}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === sigs.v1;
}

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  
  const sig = req.headers.get('stripe-signature');
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) return new Response('missing sig or secret', { status: 400 });

  const bodyText = await req.text();
  const valid = await verifyStripeSignature(bodyText, sig, secret);
  if (!valid) return new Response('invalid signature', { status: 400 });

  let event: any;
  try {
    event = JSON.parse(bodyText);
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = session.client_reference_id;
    if (token) {
      await env.PROMPTSCOPE_PRO_TOKENS.put(token, 'active');
      await env.PROMPTSCOPE_PRO_TOKENS.delete(`pending:${token}`);
      if (session.subscription) {
        await env.PROMPTSCOPE_PRO_TOKENS.put(`sub:${session.subscription}`, token);
      }
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const subId = event.data.object.id;
    const token = await env.PROMPTSCOPE_PRO_TOKENS.get(`sub:${subId}`);
    if (token) {
      await env.PROMPTSCOPE_PRO_TOKENS.delete(token);
      await env.PROMPTSCOPE_PRO_TOKENS.delete(`sub:${subId}`);
    }
  }

  return new Response('ok');
}

async function handlePaymentInfo(req: Request, env: Env): Promise<Response> {
  return Response.json({
    crypto_address: env.CRYPTO_PAY_ADDRESS ?? null,
    crypto_chain: env.CRYPTO_CHAIN ?? 'base',
    crypto_token: 'USDC',
    pro_price_usd: 19,
    note: 'Send exactly $19 USDC. Email the tx hash + a return-email to claim a Pro token.',
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api/analyze') return handleAnalyze(req, env);
    if (url.pathname === '/api/share')   return handleShare(req, env);
    if (url.pathname === '/api/checkout') return handleCheckout(req, env);
    if (url.pathname === '/api/webhook/stripe') return handleStripeWebhook(req, env);
    if (url.pathname === '/api/payment-info') return handlePaymentInfo(req, env);

    // Static assets — passthrough
    return env.ASSETS.fetch(req);
  },
};
