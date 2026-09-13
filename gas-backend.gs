/**
 * 多胡杯ゴルフコンペ 受付バックエンド（案A：LIFF の ID トークンを検証する版）
 *
 * 現行の Apps Script（プロジェクト内のファイル名は「名簿用」）を読んだうえで、
 * ★認証のやり方だけ★ を差し替えたものです。
 * 台帳の列・上書きの条件・管理者メール・LINE通知・受付完了メールは
 * すべて現行と同じ動きになるようにしてあります。
 *
 * ── 何が変わるか ────────────────────────────────
 *   これまで： index.html に書いてある合言葉(SECRET)が一致すれば通った。
 *              合言葉はブラウザに配られるので誰でも読める。
 *              とくに action=prefill は「合言葉 + 相手の userId」だけで
 *              その人の姓名・フリガナ・携帯・メール・生年月日を返していた。
 *   これから： LINE が発行した ID トークンを LINE 自身に検証させ、
 *              返ってきた sub を userId として使う。
 *              userId を自己申告に頼らないので、他人の分は引けなくなる。
 *
 *   管理画面の一覧(action=list)はアクセストークン方式のまま。admin.html は変更なし。
 * ─────────────────────────────────────────────
 *
 * ★貼り付ける前に、下の「設定」の ① ② ③ を現行の「名簿用」から移してください。
 *   このファイルには秘密の値を書いていません（リポジトリは公開されているため）。
 */

/* ============================================================
   設定
   ============================================================ */

/** ① LINEログイン（LIFF）のチャネルID。LIFF ID「2010392345-WMpqQivB」の
 *     ハイフンより前の数字。LINE Developers で実物を確認して貼る */
const CHANNEL_ID = '';

/** ② 現行の「名簿用」から、値をそのまま移す */
const LINE_TOKEN  = '';   // ← 現行の LINE_TOKEN（チャネルアクセストークン）
const ADMIN_EMAIL = '';   // ← 現行の ADMIN_EMAIL

/** ③ 移行期間だけ旧方式も受け付ける。新しい index.html を公開したら
 *     ACCEPT_LEGACY_SECRET を false、LEGACY_SECRET を '' に戻して版を上げる */
const ACCEPT_LEGACY_SECRET = true;
const LEGACY_SECRET = '';   // ← 現行の SECRET

/* 以下は現行と同じ値。変更不要 */
const SHEET_ID     = '1NIhnBlwMC4LVP0pPpx1ZHYROtDdbpNBevU1xlvOM5uc';
const SHEET_NAME   = 'LINE登録';
const ADMIN_USERID = 'Uf4fdbb2775ec9f55aea2e070c8252a73';

const HEADER = [
  'タイムスタンプ','LINE_UserID','LINE表示名',
  '姓名','フリガナ','携帯番号','メール',
  '参加の有無','生年月日','初参加',
  '紹介者','会社参加','会社名','領収書','備考','回','性別'
];

const NAME_COL   = 4;    // 姓名
const PHONE_COL  = 6;    // 携帯番号
const EVENT_COL  = 16;   // 回
const LASTCOL    = 17;

/* ============================================================
   認証
   ============================================================ */

/** ID トークンを LINE に検証させる。戻り値の userId は詐称できない */
function verifyIdToken_(idToken){
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

/** 管理画面の一覧用。現行の verifyAdmin と同じ */
function verifyAdmin(token){
  if (!token || !ADMIN_USERID) return false;
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return false;
    return JSON.parse(res.getContentText()).userId === ADMIN_USERID;
  } catch (e) { return false; }
}

/* ============================================================
   受け口
   ============================================================ */

function doGet(e) {
  const p = (e && e.parameter) || {};

  if (p.action === 'prefill') {
    /* ★ userId は「こちらで検証した値」しか使わない。
       p.userId（自己申告）は見ない＝他人の分は引けない */
    let userId = '';
    const me = verifyIdToken_(p.idToken);
    if (me) {
      userId = me.userId;
    } else if (ACCEPT_LEGACY_SECRET && LEGACY_SECRET && p.secret === LEGACY_SECRET) {
      userId = p.userId || '';                 // 移行期間だけの旧方式
    }
    let data = null;
    if (userId) { try { data = findLatestByUser(userId); } catch (err) { data = null; } }
    return out_(p.callback, data || {});
  }

  if (p.action === 'list' && p.token) {
    const ok = verifyAdmin(p.token);
    return out_(p.callback, ok ? { rows: getAllRows() } : { error: 'forbidden' });
  }

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

    /* ★ここが今回の肝。合言葉ではなく ID トークンで確かめる */
    let userId = '', displayName = '';
    const me = verifyIdToken_(d.idToken);
    if (me) {
      userId = me.userId;
      displayName = me.displayName || d.displayName || '';
    } else if (ACCEPT_LEGACY_SECRET && LEGACY_SECRET && d.secret === LEGACY_SECRET) {
      userId = d.userId || '';
      displayName = d.displayName || '';
    } else {
      return ContentService.createTextOutput(JSON.stringify({ result: 'forbidden' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    d.userId = userId;               // 自己申告を検証済みの値で必ず上書きする
    d.displayName = displayName;

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

    /* 同じ回の同じ姓名があれば上書き（代理登録があるので userId では判定しない）*/
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

    /* 幹事あてのお知らせ */
    try {
      if (ADMIN_EMAIL) {
        MailApp.sendEmail(
          ADMIN_EMAIL,
          '【多胡杯】第' + (d.eventNo || '') + '回 登録: ' + (d.name || '') + '（' + (d.join || '') + '）',
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
          '備考: ' + (d.note || '') + '\n'
        );
      }
    } catch (e2) {}

    /* 本人への LINE 通知 */
    try {
      if (LINE_TOKEN && d.userId && d.join) {
        UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
          method: 'post',
          contentType: 'application/json',
          headers: { 'Authorization': 'Bearer ' + LINE_TOKEN },
          payload: JSON.stringify({ to: d.userId, messages: [{ type: 'text', text: buildConfirmText(d) }] }),
          muteHttpExceptions: true
        });
      }
    } catch (e3) {}

    /* メアドを入れた人には、LINE と同じ内容をメールでも送る */
    try {
      const mailTo = String(d.email || '').trim();
      if (mailTo && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailTo)) {
        MailApp.sendEmail({
          to: mailTo,
          subject: '【多胡杯】第' + (d.eventNo || '') + '回 参加登録を受け付けました',
          body: buildConfirmText(d),
          name: '多胡杯ゴルフコンペ'
        });
      }
    } catch (e4) {}

    return ContentService.createTextOutput(JSON.stringify({ result: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'error', message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ============================================================
   台帳の読み出し
   ============================================================ */

/** その人自身の最新の登録（prefill 用）。現行と同じ項目 */
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

/** 管理画面の一覧。
 *  ★印刷機能で選べる項目をすべて返すように、現行から
 *    メール／紹介者／会社名／領収書／備考／LINE表示名／登録日時 を足してある */
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
   通知の本文（現行のまま）
   ============================================================ */
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
