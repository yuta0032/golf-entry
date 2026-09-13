/**
 * 多胡杯ゴルフコンペ 受付バックエンド（案A：LIFF の ID トークンを検証する版）
 *
 * ───────────────────────────────────────────────────────────
 * ★ これは「認証まわりの下書き」です。そのまま貼り替えないでください。
 *
 *   台帳（スプレッドシート）への読み書きは、いま動いている .gs を見ないと
 *   正確に合わせられません（リポジトリに .gs が無く、こちらからは読めません）。
 *   Apps Script のエディタを開いて、今の .gs を丸ごと共有してください。
 *   そのうえで「■ 台帳アクセス」の節を現行コードに合わせて確定します。
 *   推測で上書きする案は出しません。
 * ───────────────────────────────────────────────────────────
 *
 * 何を変えるのか
 *   これまで：index.html に書いてある合言葉(SECRET)を一致させれば誰でも通った。
 *             合言葉はブラウザに配られるので、実質だれでも読める。
 *             とくに action=prefill は「合言葉 + 相手の userId」だけで
 *             その人の氏名・フリガナ・携帯・生年月日・メールを返していた。
 *   これから：LINE が発行した ID トークンを LINE 自身に検証させ、
 *             返ってきた sub を userId として使う。
 *             userId をクライアントの自己申告に頼らないので、
 *             「他人の userId を指定して個人情報を引く」ことができなくなる。
 *
 *   管理画面の一覧(action=list)は従来どおりアクセストークン方式のまま。
 *   admin.html は変更しません。
 */

/* ============================================================
   設定
   ============================================================ */

/**
 * ★ LINEログイン（LIFF）のチャネルID。
 *   LIFF ID「2010392345-WMpqQivB」のハイフンより前の数字がこれにあたります。
 *   必ず LINE Developers コンソールで実物を確認して貼ってください。
 *   ここが空だと ID トークンの検証は必ず失敗します。
 */
const CHANNEL_ID = '';

/** 管理画面を見られる人の LINE userId（admin.html と同じ値） */
const ADMIN_USERID = 'Uf4fdbb2775ec9f55aea2e070c8252a73';

/* ---- 移行期間だけの互換スイッチ ------------------------------------
   GAS を先に更新すると、公開中の古い index.html はまだ合言葉で送ってきます。
   その間だけ true にして受け付けてください。
   新しい index.html を公開したら false に戻し、LEGACY_SECRET も空にします。
   （true のままだと、塞いだはずの穴が開いたままになります）
   -------------------------------------------------------------------- */
const ACCEPT_LEGACY_SECRET = true;
const LEGACY_SECRET = '';   // ★ 現行 .gs にある合言葉をここへ移す

/* ============================================================
   ■ 認証
   ============================================================ */

/** ID トークンを LINE に検証させる。戻り値の userId は詐称できない */
function verifyIdToken_(idToken){
  if(!idToken || !CHANNEL_ID) return null;
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: CHANNEL_ID },
    muteHttpExceptions: true
  });
  if(res.getResponseCode() !== 200) return null;
  let p;
  try { p = JSON.parse(res.getContentText()); } catch(e){ return null; }
  if(!p || !p.sub) return null;
  if(String(p.aud) !== String(CHANNEL_ID)) return null;                 // 念のため自分でも確認
  if(p.exp && Number(p.exp) * 1000 < Date.now()) return null;           // 期限切れ
  return { userId: p.sub, displayName: p.name || '' };
}

/** アクセストークンの検証（管理画面の一覧用。admin.html は今のまま） */
function verifyAccessToken_(accessToken){
  if(!accessToken) return null;
  const res = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  if(res.getResponseCode() !== 200) return null;
  let p;
  try { p = JSON.parse(res.getContentText()); } catch(e){ return null; }
  if(!p || !p.userId) return null;
  return { userId: p.userId, displayName: p.displayName || '' };
}

/* ============================================================
   ■ 受け口
   ============================================================ */

function doGet(e){
  const q = (e && e.parameter) || {};

  if(q.action === 'list'){
    const me = verifyAccessToken_(q.token);
    if(!me || me.userId !== ADMIN_USERID) return jsonp_(q.callback, { error: 'forbidden' });
    return jsonp_(q.callback, { rows: readAllRows_() });
  }

  if(q.action === 'prefill'){
    let userId = '';
    const me = verifyIdToken_(q.idToken);
    if(me){
      userId = me.userId;                       // ★検証済み。自己申告の userId は使わない
    } else if(ACCEPT_LEGACY_SECRET && LEGACY_SECRET && q.secret === LEGACY_SECRET){
      userId = q.userId || '';                  // 移行期間だけの旧方式
    }
    if(!userId) return jsonp_(q.callback, {});
    return jsonp_(q.callback, readLatestByUser_(userId) || {});
  }

  return jsonp_(q.callback, { error: 'bad action' });
}

function doPost(e){
  let d;
  try { d = JSON.parse(e.postData.contents); } catch(err){ return textOut_('bad request'); }

  let userId = '', displayName = '';
  const me = verifyIdToken_(d.idToken);
  if(me){
    userId = me.userId;
    displayName = me.displayName || d.displayName || '';
  } else if(ACCEPT_LEGACY_SECRET && LEGACY_SECRET && d.secret === LEGACY_SECRET){
    userId = d.userId || '';
    displayName = d.displayName || '';
  } else {
    return textOut_('unauthorized');
  }
  if(!userId) return textOut_('unauthorized');

  d.userId = userId;                 // ★自己申告を、検証済みの値で必ず上書きする
  d.displayName = displayName;
  delete d.secret;
  delete d.idToken;                  // 台帳に書き残さない

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { saveRow_(d); } finally { lock.releaseLock(); }

  // 受付完了メール。現行 .gs に sendMailIfEmail があればそれを使う
  try { if (typeof sendMailIfEmail === 'function') sendMailIfEmail(d); } catch(err){}

  return textOut_('ok');
}

function jsonp_(cb, obj){
  const body = (cb ? String(cb) : '__cb') + '(' + JSON.stringify(obj) + ');';
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
function textOut_(s){
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

/* ============================================================
   ■ 台帳アクセス
   ★★ ここは現行 .gs に合わせて確定が必要です ★★

   下の実装は「1行目が見出し行で、見出しの文字で列を探す」作りにしてあります。
   列の並び順が違っても動きますが、見出しの文言が違えば合いません。
   現行 .gs（と実際のシートの1行目）を確認してから確定してください。
   ============================================================ */

/** ★ 空なら先頭シート。現行 .gs がシート名を指定しているならそれに合わせる */
const SHEET_NAME = '';

/** ★ 送られてくる項目 → シートの見出し文字。実物に合わせて直す */
const FIELD_TO_HEADER = {
  timestamp:   'タイムスタンプ',
  eventNo:     '回次',
  userId:      'LINE ID',
  displayName: 'LINE表示名',
  name:        '氏名',
  kana:        'フリガナ',
  gender:      '性別',
  join:        '参加の有無',
  birth:       '生年月日',
  phone:       '緊急連絡先',
  email:       'メールアドレス',
  firstTime:   '初参加ですか？',
  referrer:    '参加経由を教えてください',
  company:     '会社としての参加ですか？',
  companyName: '会社名を教えてください',
  receipt:     '領収証が御入り用ですか？',
  note:        '自由記載欄'
};

function sheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
}

function headerIndex_(sh){
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = {};
  head.forEach(function(h, i){ idx[String(h).trim()] = i; });
  return idx;
}

function saveRow_(d){
  const sh  = sheet_();
  const idx = headerIndex_(sh);
  const width = sh.getLastColumn();
  const row = new Array(width).fill('');
  Object.keys(FIELD_TO_HEADER).forEach(function(f){
    const col = idx[FIELD_TO_HEADER[f]];
    if(col === undefined) return;                       // シートに無い列は黙って飛ばす
    row[col] = (f === 'timestamp') ? new Date() : (d[f] === undefined ? '' : d[f]);
  });
  sh.appendRow(row);
}

/** 管理画面が使う形（admin.html の card()/draw() が参照するキー）で返す */
function readAllRows_(){
  const sh = sheet_();
  const last = sh.getLastRow();
  if(last < 2) return [];
  const idx = headerIndex_(sh);
  const vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  return vals.map(function(v){
    const o = {};
    Object.keys(FIELD_TO_HEADER).forEach(function(f){
      const col = idx[FIELD_TO_HEADER[f]];
      o[f] = (col === undefined) ? '' : fmt_(v[col]);
    });
    return o;
  });
}

/** その人自身の最新の登録を返す（prefill 用） */
function readLatestByUser_(userId){
  const rows = readAllRows_();
  for(var i = rows.length - 1; i >= 0; i--){
    if(String(rows[i].userId) === String(userId)) return rows[i];
  }
  return null;
}

/** Date は日本時間の YYYY-MM-DD にして返す（そのまま返すと1日ずれることがある） */
function fmt_(v){
  if(Object.prototype.toString.call(v) === '[object Date]'){
    return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : v;
}
