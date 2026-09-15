/**
 * 多胡杯ゴルフコンペ 受付バックエンド（v54：合言葉を完全に無効化した版）
 * Apps Script のファイル名「名簿用」にまるごと貼り付けてください。
 *
 * ★v53 との違いは2点だけです。
 *   ・ACCEPT_LEGACY_SECRET を false、LEGACY_SECRET を '' にした。
 *     これで旧方式の合言葉は一切通らなくなります。
 *     **新しい index.html が公開済みであることを確認してから貼ってください。**
 *     （公開済み：main 505c48d で index.html は ID トークンを送る形になっています）
 *   ・verifyAdmin の結果を10分だけ覚えるようにした（管理画面の表示が 0.4〜0.6 秒速くなる）。
 *     CacheService は新しい権限が要らないので、再承認は発生しません。
 *
 * v52 からの変更は次の4点です。
 *   1. 認証：合言葉(SECRET)をやめ、LINE が発行した ID トークンを LINE 自身に検証させる。
 *      prefill は userId を受け取らなくなり、検証結果の sub でしか引けない。
 *      → 「合言葉 + 他人の userId」で個人情報を引き出せた穴が塞がる。
 *   2. 移行期間だけ旧方式も通す互換スイッチ（公開の順番のため。公開後に false に戻す）。
 *   3. 台帳への書き込みを LockService で囲った。
 *      v52 は「最終行を読む → その次の行に書く」の間に排他がなく、
 *      2人が同時に送信すると同じ行に上書きし合って片方が消える可能性があった。
 *   4. 管理画面の一覧が メール／紹介者／会社名／領収書／備考／LINE表示名／登録日時 も返す。
 *      （印刷機能でこれらを選べるようにするため）
 *
 * 通知の文面（本人への LINE・本人へのメール・幹事あてメール）は v52 のままで、
 * 一字も変えていません。台帳の17列・同じ回の同じ姓名なら上書きする動きも同じです。
 *
 * ★貼る前に、下の ① ② ③ を「差し替える前の 名簿用」から写してください。
 *   このファイルには秘密の値を書いていません。
 */

/* ============================================================
   設定
   ============================================================ */

/** ① LINEログイン（LIFF）のチャネルID。
 *     LIFF ID「2010392345-WMpqQivB」のハイフンより前の数字と同じはずですが、
 *     必ず LINE Developers コンソールで実物を確認してください。
 *     ここが空、または間違っていると ID トークンの検証は必ず失敗します。 */
const CHANNEL_ID = '';

/** ② 差し替える前の「名簿用」から、同名の値をそのまま写す */
const LINE_TOKEN  = '';   // ← v52 の LINE_TOKEN
const ADMIN_EMAIL = '';   // ← v52 の ADMIN_EMAIL

/** ③ 旧方式（合言葉）は無効。v54 ではここを触る必要はありません。
 *     もし ID トークン側で問題が出て切り戻すなら、v53 のデプロイに戻してください */
const ACCEPT_LEGACY_SECRET = false;
const LEGACY_SECRET = '';

/* 以下は v52 と同じ値。変更不要 */
const SHEET_ID     = '1NIhnBlwMC4LVP0pPpx1ZHYROtDdbpNBevU1xlvOM5uc';
const SHEET_NAME   = 'LINE登録';
const ADMIN_USERID = 'Uf4fdbb2775ec9f55aea2e070c8252a73';

const HEADER = [
  'タイムスタンプ','LINE_UserID','LINE表示名',
  '姓名','フリガナ','携帯番号','メール',
  '参加の有無','生年月日','初参加',
  '紹介者','会社参加','会社名','領収書','備考','回','性別'
];

const NAME_COL  = 4;    // 姓名
const PHONE_COL = 6;    // 携帯番号
const EVENT_COL = 16;   // 回
const LASTCOL   = 17;

/* ============================================================
   認証
   ============================================================ */

/** ID トークンを LINE に検証させる。戻り値の userId は詐称できない */
function verifyIdToken_(idToken) {
  if (!idToken || !CHANNEL_ID) return null;
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'post',
      payload: { id_token: idToken, client_id: CHANNEL_ID },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    const p = JSON.parse(res.getContentText());
    if (!p || !p.sub) return null;
    if (String(p.aud) !== String(CHANNEL_ID)) return null;
    if (p.exp && Number(p.exp) * 1000 < Date.now()) return null;
    return { userId: p.sub, displayName: p.name || '' };
  } catch (e) { return null; }
}

/** 管理画面の一覧用。
 *  判定のたびに LINE と往復していて 0.4〜0.6 秒かかっていたので、結果を10分だけ覚える。
 *  トークンは生のまま鍵にせず SHA-256 にしてから使う。
 *  CacheService は追加の権限が要らないので、貼り替えても再承認は発生しない。
 *  （副作用：アクセストークンを失効させても最大10分は通る。
 *    LINE のアクセストークン自体が短命なので実害は小さいと判断） */
function verifyAdmin(token) {
  if (!token || !ADMIN_USERID) return false;
  try {
    const cache = CacheService.getScriptCache();
    const key = 'adm_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
    const hit = cache.get(key);
    if (hit !== null) return hit === '1';

    const res = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true
    });
    const ok = res.getResponseCode() === 200 &&
               JSON.parse(res.getContentText()).userId === ADMIN_USERID;
    cache.put(key, ok ? '1' : '0', 600);   // 10分
    return ok;
  } catch (e) { return false; }
}

/** 管理画面の一覧用（ID トークン版）。
 *  外部ブラウザでは liff.getAccessToken() が空になることがあるので、
 *  ID トークンでも幹事かどうかを判定できるようにする。
 *  検証は verifyIdToken_ と同じ LINE のエンドポイントで、
 *  UrlFetchApp は muteHttpExceptions:true、全体を try/catch で囲ってあるので
 *  ここから例外が外に出ることはない（＝素のテキストに落ちない）。 */
function verifyAdminByIdToken_(idToken) {
  if (!idToken || !ADMIN_USERID) return false;
  const me = verifyIdToken_(idToken);
  return !!(me && me.userId === ADMIN_USERID);
}

/** 送信者を決める。ID トークンが本筋、互換スイッチが入っている間だけ旧方式も通す */
function resolveSender_(src) {
  const me = verifyIdToken_(src.idToken);
  if (me) return { userId: me.userId, displayName: me.displayName || src.displayName || '' };
  if (ACCEPT_LEGACY_SECRET && LEGACY_SECRET && src.secret === LEGACY_SECRET) {
    return { userId: src.userId || '', displayName: src.displayName || '' };
  }
  return null;
}

/* ============================================================
   受け口
   ============================================================ */

function doGet(e) {
  const p = (e && e.parameter) || {};

  if (p.action === 'prefill') {
    /* ★ userId は検証した値しか使わない。p.userId（自己申告）は見ない */
    const who = resolveSender_(p);
    let data = null;
    if (who && who.userId) {
      try { data = findLatestByUser(who.userId); } catch (err) { data = null; }
    }
    return out_(p.callback, data || {});
  }

  if (p.action === 'list') {
    /* 資格情報は2通り受ける。
       ・token    … LIFF のアクセストークン（従来）
       ・id_token … LIFF の ID トークン。外部ブラウザだとアクセストークンが
                    取れないことがあるので、その代わりに使う
       どちらも無い／不正なときも、必ず JSONP で返す。素のテキストを返すと
       呼び出し側は script タグで読むため JavaScript として壊れ、
       コールバックが呼ばれないまま画面が固まる */
    /* v は診断用。管理画面が「どの版の GAS に当たっているか」を出せるようにする */
    if (p.token) {
      return out_(p.callback, verifyAdmin(p.token)
        ? { v: 55, rows: getAllRows() } : { v: 55, error: 'forbidden' });
    }
    if (p.id_token) {
      return out_(p.callback, verifyAdminByIdToken_(p.id_token)
        ? { v: 55, rows: getAllRows() } : { v: 55, error: 'forbidden' });
    }
    return out_(p.callback, { v: 55, error: 'no token' });
  }

  /* callback を付けて呼ばれている＝相手は script タグで読む。
     素のテキストを返すと必ず壊れるので、必ず JavaScript の形で返す */
  if (p.callback) return out_(p.callback, { error: 'bad request' });

  return ContentService.createTextOutput('OK: バックエンドは動いています。')
    .setMimeType(ContentService.MimeType.TEXT);
}

function out_(callback, obj) {
  const s = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + s + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);

    /* ── 1. 誰からの送信かを確かめる ───────────────── */
    const who = resolveSender_(d);
    if (!who || !who.userId) {
      /* 弾いたときだけ1行残す。あとで「実行数」から原因を追えるようにするため。
         氏名・電話・トークンなど個人にひもづくものは出さない。
         CHANNEL_ID の入れ忘れ・入れ間違いがいちばんよくある原因なので、
         設定されているかどうかだけ併せて出す */
      Logger.log('forbidden: idToken=' + !!d.idToken
               + ' channelIdSet=' + !!CHANNEL_ID
               + ' eventNo=' + (d.eventNo || ''));
      return json_({ result: 'forbidden' });
    }
    d.userId = who.userId;                 // 自己申告を検証済みの値で必ず上書きする
    d.displayName = who.displayName;

    /* ── 2. 台帳に書く。ここだけ排他をかける ───────── */
    saveRow_(d);

    /* ── 3. 通知。ここから先で何が起きても、申込の成否には影響しない ──
       3つとも個別に try/catch で囲ってあるので、1つ失敗しても他は送られ、
       戻り値は必ず ok になる。 */
    notifyAdmin_(d);
    notifyLine_(d);
    notifyMail_(d);

    return json_({ result: 'ok' });

  } catch (err) {
    return json_({ result: 'error', message: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   台帳
   ============================================================ */

/** 書き込み。同じ回の同じ姓名があれば上書き（代理登録があるので姓名で判定する）。
 *  「最終行を読む → 次の行に書く」の間に他の送信が割り込むと行が潰れるので、
 *  読みから書きまでをまとめて排他する。 */
function saveRow_(d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);

    const rowData = [
      new Date(),
      d.userId || '', d.displayName || '',
      d.name || '', d.kana || '', d.phone || '', d.email || '',
      d.join || '', d.birth || '', d.firstTime || '',
      d.referrer || '', d.company || '', d.companyName || '', d.receipt || '', d.note || '',
      d.eventNo || '', d.gender || ''
    ];

    const name = d.name || '';
    const eventNo = d.eventNo || '';
    let targetRow = -1;
    const lastRow = sheet.getLastRow();
    if (name && lastRow >= 2) {
      const rows = sheet.getRange(2, 1, lastRow - 1, EVENT_COL).getValues();
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][NAME_COL - 1] === name && String(rows[i][EVENT_COL - 1]) === String(eventNo)) {
          targetRow = i + 2; break;
        }
      }
    }
    if (targetRow < 0) targetRow = lastRow + 1;

    sheet.getRange(targetRow, PHONE_COL).setNumberFormat('@');
    sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/** その人自身の最新の登録（prefill 用）。v52 と同じ項目 */
function findLatestByUser(userId) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const rows = sheet.getRange(2, 1, lastRow - 1, LASTCOL).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][1] === userId) {
      const r = rows[i];
      return {
        name: r[3], kana: r[4], phone: String(r[5] || ''), email: r[6],
        birth: fmt_(r[8]), firstTime: r[9], referrer: r[10],
        company: r[11], companyName: r[12], receipt: r[13],
        gender: r[16]
      };
    }
  }
  return null;
}

/** 管理画面の一覧。v52 から
 *  メール／紹介者／会社名／領収書／備考／LINE表示名／登録日時 を足してある */
function getAllRows() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const rows = sheet.getRange(2, 1, lastRow - 1, LASTCOL).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    out.push({
      timestamp:   fmtDateTime_(r[0]),
      displayName: r[2],
      name:        r[3],
      kana:        r[4],
      phone:       String(r[5] || ''),
      email:       r[6],
      join:        r[7],
      birth:       fmt_(r[8]),
      firstTime:   r[9],
      referrer:    r[10],
      company:     r[11],
      companyName: r[12],
      receipt:     r[13],
      note:        r[14],
      eventNo:     r[15],
      gender:      r[16]
    });
  }
  return out;
}

/** Date は日本時間の文字列にして返す。そのまま返すと受け取り側で1日ずれる */
function fmt_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return (v === null || v === undefined) ? '' : v;
}
function fmtDateTime_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  }
  return (v === null || v === undefined) ? '' : v;
}

/* ============================================================
   通知（文面は v52 のまま）
   ============================================================ */

function notifyAdmin_(d) {
  try {
    if (!ADMIN_EMAIL) return;
    const subject = '【多胡杯】第' + (d.eventNo || '') + '回 登録: ' + (d.name || '') + '（' + (d.join || '') + '）';
    const body =
      '新しい参加登録がありました。\n\n' +
      '回: 第' + (d.eventNo || '') + '回\n' +
      '氏名: ' + (d.name || '') + '（' + (d.kana || '') + '）\n' +
      '性別: ' + (d.gender || '') + '\n' +
      '携帯: ' + (d.phone || '') + '\n' +
      'メール: ' + (d.email || '') + '\n' +
      '参加: ' + (d.join || '') + '\n' +
      '生年月日: ' + (d.birth || '') + '\n' +
      '初参加: ' + (d.firstTime || '') + ' / 紹介者: ' + (d.referrer || '') + '\n' +
      '会社参加: ' + (d.company || '') + ' / 会社名: ' + (d.companyName || '') + ' / 領収書: ' + (d.receipt || '') + '\n' +
      '備考: ' + (d.note || '') + '\n';
    MailApp.sendEmail(ADMIN_EMAIL, subject, body);
  } catch (e) {}
}

function notifyLine_(d) {
  try {
    if (!LINE_TOKEN || !d.userId || !d.join) return;
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify({ to: d.userId, messages: [{ type: 'text', text: buildConfirmText(d) }] }),
      muteHttpExceptions: true
    });
  } catch (e) {}
}

function notifyMail_(d) {
  try {
    const mailTo = String(d.email || '').trim();
    if (!mailTo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailTo)) return;
    MailApp.sendEmail({
      to: mailTo,
      subject: '【多胡杯】第' + (d.eventNo || '') + '回 参加登録を受け付けました',
      body: buildConfirmText(d),
      name: '多胡杯ゴルフコンペ'
    });
  } catch (e) {}
}

function buildConfirmText(d) {
  const no = d.eventNo || '';
  if (d.join !== '参加する') {
    return '第' + no + '回 多胡杯ゴルフコンペ\n「不参加」を受け付けました。\n\n'
      + 'お名前：' + (d.name || '') + '\n参加：' + (d.join || '') + '\n\n'
      + 'またの機会にお待ちしています。';
  }
  let t = '第' + no + '回 多胡杯ゴルフコンペ\n参加登録を受け付けました⛳\n\n'
    + '会費：3,000円\n'
    + 'プレー費：9,000円（食事代・利用税込み）\n'
    + '締切：10月9日（金）\n\n'
    + '【ご登録内容】\n';
  t += 'お名前：' + (d.name || '') + '（' + (d.kana || '') + '）\n';
  t += '性別：' + (d.gender || '') + '\n';
  t += '携帯：' + (d.phone || '') + '\n';
  if (d.email) t += 'メール：' + d.email + '\n';
  t += '参加：' + (d.join || '') + '\n';
  t += '生年月日：' + (d.birth || '') + '\n';
  t += '初参加：' + (d.firstTime || '') + '\n';
  if (d.firstTime === 'はい' && d.referrer) t += '紹介者：' + d.referrer + '\n';
  t += '会社参加：' + (d.company || '') + '\n';
  if (d.company === '会社参加') {
    t += '会社名：' + (d.companyName || '') + '\n';
    t += '領収書：' + (d.receipt || '') + '\n';
  }
  if (d.note) t += '備考：' + d.note + '\n';
  t += '\n内容を変更する場合は、もう一度フォームから送信してください。';
  return t;
}
