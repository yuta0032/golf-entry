/**
 * 多胡杯ゴルフコンペ 名簿中継 Worker（案1・中継のみ／未デプロイ）
 *
 * 何をするか
 *   管理画面からの名簿取得を、GAS の配信経路
 *   （/exec → 302 → script.googleusercontent.com）から外す。
 *   ブラウザは Cloudflare とだけ話し、当たり外れはここで吸収する。
 *
 * 何をしないか
 *   ・名簿を保存しない（通過するだけ。KV も使わない）
 *   ・誰が幹事かを持たない。可否の判断は GAS に任せる（二重管理しない）
 *   ・秘密を持たない。設定するのは GAS の /exec の URL だけ
 *
 * 環境変数
 *   GAS_URL  GAS の /exec（秘密ではない。index.html にも書かれている）
 *
 * ダッシュボードにこのまま貼れば動く。依存なし・単一ファイル。
 */

const GAS_TIMEOUT_MS = 14000;  // GAS 1本あたりの待ち（8秒だと待てば返る分を捨てていた）
const GAS_MAX_CALLS  = 3;      // 1リクエストで GAS を叩く上限

/* 名簿を返すので、許すオリジンは決め打ちにする */
const ALLOW_ORIGINS = [
  'https://yuta0032.github.io',
  'https://liff.line.me'
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), origin);
    }
    if (request.method !== 'GET' || url.pathname !== '/list') {
      return cors(json({ error: 'not found' }, 404), origin);
    }
    if (!env.GAS_URL) {
      return cors(json({ error: 'not configured' }, 500), origin);
    }

    /* GAS へ渡すのは資格情報と t だけ。action は Worker 側で固定する */
    const token   = url.searchParams.get('token') || '';
    const idToken = url.searchParams.get('id_token') || '';
    if (!token && !idToken) {
      return cors(json({ error: 'no token' }, 400), origin);
    }
    const base = env.GAS_URL + '?action=list'
      + (token ? '&token=' + encodeURIComponent(token) : '')
      + (idToken ? '&id_token=' + encodeURIComponent(idToken) : '');

    /* 1本目を出し、駄目なら2本目と3本目を同時に出して早い方を採る。
       待ちは1本 14 秒なので、最悪でも 28 秒で結論が出る（上限3本）。
       8 秒だった頃は、9〜16 秒で返ってくる回を打ち切って捨てていた。 */
    const stamp = () => '&t=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    let got = await callGas(base + stamp());
    if (!got) {
      got = await firstGood([ callGas(base + stamp()), callGas(base + stamp()) ]);
    }
    if (!got) return cors(json({ error: 'upstream' }, 502), origin);

    /* GAS の応答をそのまま返す。forbidden などもそのまま通す（判断は GAS のもの） */
    return cors(json(got), origin);
  }
};

/* ============================================================
   GAS を1本叩く。駄目なら null を返す（例外は投げない）
   ============================================================ */
async function callGas(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GAS_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;                                  // 5xx / 4xx はやり直し
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;                   // 素のテキストや HTML が返ることがある
    const body = await r.json();
    if (!body || typeof body !== 'object') return null;
    return body;                                             // error 入りでも「返ってきた」なら成功扱い
  } catch (e) {
    return null;                                             // 切断・時間切れ
  } finally {
    clearTimeout(timer);
  }
}

/** 先に中身を返した方を採る。全部だめなら null */
async function firstGood(promises) {
  return new Promise((resolve) => {
    let left = promises.length;
    promises.forEach((p) => {
      p.then((v) => {
        if (v) resolve(v);
        else if (--left === 0) resolve(null);
      }).catch(() => {
        if (--left === 0) resolve(null);
      });
    });
  });
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

function cors(res, origin) {
  if (ALLOW_ORIGINS.indexOf(origin) >= 0) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
  }
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Access-Control-Max-Age', '600');
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
