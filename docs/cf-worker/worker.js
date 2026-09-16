/**
 * 多胡杯ゴルフコンペ 名簿中継 Worker（下書き・未デプロイ）
 *
 * 目的：管理画面の名簿取得を Google の配信経路（/exec → script.googleusercontent.com）
 *       から外す。ブラウザは Cloudflare としか話さず、Google の当たり外れは
 *       ここで吸収する。
 *
 * この下書きは「案1＝中継のみ」。名簿は通過するだけで保存しない。
 * 案3（押し込み＋KV）にする場合は末尾のコメントを参照。
 *
 * 環境変数（どれも秘密ではない）
 *   ADMIN_USERID     幹事の LINE userId
 *   LINE_CHANNEL_ID  LIFF のチャネルID（例 2010392345）
 *   GAS_URL          GAS の /exec
 * 任意
 *   VERIFY_CACHE     Workers KV。トークン検証の結果を10分だけ入れる（無くても動く）
 */

const VERIFY_TTL = 600;          // 検証結果を覚えておく秒数
const GAS_TRIES  = 3;            // GAS が転んだときにやり直す回数
const GAS_TIMEOUT_MS = 8000;     // 1回あたりの待ち

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname !== '/list')     return cors(json({ error: 'not found' }, 404));

    /* ── 1. 誰からの要求かを LINE に確かめる ── */
    const who = await identify(request, url, env);
    if (!who)                          return cors(json({ error: 'forbidden' }, 403));
    if (who !== env.ADMIN_USERID)      return cors(json({ error: 'forbidden' }, 403));

    /* ── 2. GAS から名簿を取る。転んだらすぐやり直す ── */
    const cred = url.searchParams.get('token')
      ? 'token=' + encodeURIComponent(url.searchParams.get('token'))
      : 'id_token=' + encodeURIComponent(url.searchParams.get('id_token') || '');

    for (let i = 0; i < GAS_TRIES; i++) {
      const got = await fetchGas(env.GAS_URL + '?action=list&' + cred + '&t=' + Date.now() + '-' + i);
      if (got) return cors(json(got));          // 名簿はここを通過するだけ。保存しない
    }
    return cors(json({ error: 'upstream' }, 502));
  }
};

/* ============================================================
   LINE に問い合わせて userId を得る
   ============================================================ */
async function identify(request, url, env) {
  const auth = request.headers.get('Authorization') || '';
  const accessToken = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
  const idToken = url.searchParams.get('id_token');

  const key = await hashKey(accessToken || idToken || '');
  if (!key) return null;

  const hit = await cacheGet(env, key);
  if (hit !== null) return hit || null;

  let userId = null;
  if (accessToken) userId = await byAccessToken(accessToken, env);
  else if (idToken) userId = await byIdToken(idToken, env);

  await cachePut(env, key, userId || '');
  return userId;
}

/** アクセストークン：まず client_id を確かめてから profile を引く。
 *  client_id を見ないと、他の LINE アプリのトークンでも通ってしまう。 */
async function byAccessToken(token, env) {
  try {
    const v = await fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token));
    if (!v.ok) return null;
    const info = await v.json();
    if (String(info.client_id) !== String(env.LINE_CHANNEL_ID)) return null;

    const p = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!p.ok) return null;
    return (await p.json()).userId || null;
  } catch (e) { return null; }
}

/** ID トークン：LINE に検証させて sub を取る */
async function byIdToken(idToken, env) {
  try {
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'id_token=' + encodeURIComponent(idToken) + '&client_id=' + encodeURIComponent(env.LINE_CHANNEL_ID)
    });
    if (!r.ok) return null;
    const p = await r.json();
    if (String(p.aud) !== String(env.LINE_CHANNEL_ID)) return null;
    return p.sub || null;
  } catch (e) { return null; }
}

/* ============================================================
   GAS から取る。1回あたり GAS_TIMEOUT_MS で切る
   ============================================================ */
async function fetchGas(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GAS_TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;      // 素のテキストや HTML が返ることがある
    const body = await r.json();
    if (!body || body.error) return null;
    return body;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   小物
   ============================================================ */
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/** 名簿を返すので、許すのは公開ページのオリジンだけにする */
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', 'https://yuta0032.github.io');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization');
  res.headers.set('Access-Control-Max-Age', '600');
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** 生のトークンを鍵にしない */
async function hashKey(s) {
  if (!s) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return 'v_' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function cacheGet(env, key) {
  if (!env.VERIFY_CACHE) return null;
  try { return await env.VERIFY_CACHE.get(key); } catch (e) { return null; }
}
async function cachePut(env, key, val) {
  if (!env.VERIFY_CACHE) return;
  try { await env.VERIFY_CACHE.put(key, val, { expirationTtl: VERIFY_TTL }); } catch (e) {}
}

/* ============================================================
   案3（押し込み＋KV）にする場合の差分メモ
   ------------------------------------------------------------
   ・POST /push を足す。Authorization は GAS の ScriptApp.getIdentityToken()。
     Google の JWKS（https://www.googleapis.com/oauth2/v3/certs）で署名を確かめ、
     iss / email / email_verified / exp に加えて **aud（Apps Script の OAuth
     クライアントID）も必ず一致させる**。email だけだと、別のアプリが同じ
     アカウント向けに出した ID トークンでも通ってしまう。
   ・GET /list は GAS を叩かず KV から返す。
   ・その代わり **名簿が KV に置きっぱなしになる**。案1なら保存しない。
   ============================================================ */
