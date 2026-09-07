/* KaruTalk — 画面共有で「どこどこが〜」を英語で言えるようにするドリル
 *
 * 設計の芯:
 *  - 学習の単位は《型》。同じ型で3回言えたら卒業して消える。減らないものは続かない。
 *  - 自動生成した図は正解をこちらが持っているので、画像をAPIに送らずテキストで照合する。
 *    画像を送るのはユーザー自身のスクショのときだけ。
 *  - 「今日これ言えなかった」を10秒で放り込める入口を常設し、それが翌日の型になる。
 *  - 出だしまでの秒数(TTFW)はローカルのWeb Audioで測る。ネットにも音声認識にも依存しない。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ════════ 保存 ════════ */
const KEY = 'karutalk.v2';
const DEFAULTS = {
  settings: {
    apiKey: '', model: 'gemini-3.5-flash-lite', answerSec: 25,
    speakQuestion: true, showJa: false, figKinds: ['plan', 'section', 'chart'],
    newPerDay: 4,
  },
  patterns: [],   // 型。これが学習の単位
  inbox: [],      // 「言えなかった」受信箱
  history: [],    // 1問ごとの記録
  sessions: [],   // セッションごとの記録
};

let S = load();

function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const s = {
    settings: Object.assign({}, DEFAULTS.settings, raw.settings || {}),
    patterns: raw.patterns || [],
    inbox: raw.inbox || [],
    history: raw.history || [],
    sessions: raw.sessions || [],
  };
  // 組み込みの型を（無ければ）流し込む。既存の学習状況は壊さない。
  const have = new Set(s.patterns.map(p => p.id));
  BUILTIN_PATTERNS.forEach(b => {
    if (!have.has(b.id)) {
      s.patterns.push(Object.assign({
        source: 'builtin', variants: [], box: 0, due: 0, streak: 0, seen: 0, ok: 0, ng: 0,
        createdAt: Date.now(),
      }, b));
    }
  });
  return s;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('保存できません（容量かプライベートモード）'); }
}

/* ════════ 画像だけ IndexedDB に置く（localStorageだとすぐ溢れる） ════════ */
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('karutalk', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('img');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async put(id, blob) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('img', 'readwrite');
      t.objectStore('img').put(blob, id);
      t.oncomplete = () => res(id); t.onerror = () => rej(t.error);
    });
  },
  async get(id) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('img', 'readonly');
      const q = t.objectStore('img').get(id);
      q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
    });
  },
  async del(id) {
    const db = await this.open();
    return new Promise((res) => {
      const t = db.transaction('img', 'readwrite');
      t.objectStore('img').delete(id); t.oncomplete = () => res();
    });
  },
};

// スクショは長辺1280に縮めてJPEGにする（送信も保存も軽くする）
function shrinkImage(file, max = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? resolve(b) : reject(new Error('canvas failed')), 'image/jpeg', quality);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('画像を読めませんでした'));
    img.src = URL.createObjectURL(file);
  });
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// esc / today / show / toast は次のブロック（流用した既存コード）で定義される

/* ════════ 画面遷移・小物 ════════ */
let backTo = 'home';
function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  window.scrollTo(0, 0);
}
let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 1800);
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const today = () => new Date(Date.now()).toLocaleDateString('sv-SE'); // YYYY-MM-DD(ローカル)

/* ════════ 読み上げ ════════ */
let enVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter(v => /^en(-|_)/i.test(v.lang));
  if (!vs.length) return null;
  const pref = ['Samantha', 'Ava', 'Allison', 'Google US English', 'Karen', 'Daniel'];
  for (const p of pref) { const v = vs.find(v => v.name.includes(p)); if (v) return v; }
  return vs.find(v => /en[-_]US/i.test(v.lang)) || vs[0];
}
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => { enVoice = pickVoice(); };
  enVoice = pickVoice();
}
// iOSは最初の発話がユーザー操作の中でないと無音になるので、開始タップで一度空打ちする
function warmTTS() {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0; speechSynthesis.speak(u);
}
function speak(text, rate = 0.95) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = rate;
    if (!enVoice) enVoice = pickVoice();
    if (enVoice) u.voice = enVoice;
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    u.onend = fin; u.onerror = fin;
    // onendが来ない端末があるので、文字数から見積もった時間で強制解決
    setTimeout(fin, Math.min(20000, 1200 + text.length * 75));
    speechSynthesis.speak(u);
  });
}

/* ════════ マイク（録音＋音量からの発話検出） ════════ */
const Mic = {
  stream: null, rec: null, chunks: [], mime: '', ac: null,
  rms: 0, floor: 0.006, onVoice: null, onLevel: null, voicedFrames: 0,
  src: null, proc: null, mute: null,

  // iOSはユーザー操作の「中」でしかAudioContextを起こせない。
  // awaitを挟むと操作扱いが切れるので、タップハンドラの同期部分から必ずこれを呼ぶ。
  ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ac || this.ac.state === 'closed') this.ac = new AC();
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
  },
  closeCtx() {
    try { this.ac && this.ac.close(); } catch {}
    this.ac = null;
  },

  pickMime() {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac'];
    for (const c of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    return '';
  },

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.mime = this.pickMime();
    this.chunks = [];
    // 音声はビットレートを絞る。話し声には24kbpsで十分で、送信量が減るぶん添削が早く返る。
    const recOpts = { audioBitsPerSecond: 24000 };
    if (this.mime) recOpts.mimeType = this.mime;
    this.rec = new MediaRecorder(this.stream, recOpts);
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);

    this.ensureCtx();
    if (this.ac.state === 'suspended') { try { await this.ac.resume(); } catch {} }
    this.src = this.ac.createMediaStreamSource(this.stream);

    // 発話検出はオーディオスレッド駆動にする。requestAnimationFrame だと画面が暗転した
    // ときや裏に回ったときに止まってしまい、出だし秒の計測が壊れる。
    // ScriptProcessorNode は非推奨だが iOS Safari を含めどこでも動くのでこれを使う。
    const N = 1024;
    this.proc = this.ac.createScriptProcessor(N, 1, 1);
    this.mute = this.ac.createGain();
    this.mute.gain.value = 0;                 // マイクをスピーカーに返さない
    this.src.connect(this.proc);
    this.proc.connect(this.mute);
    this.mute.connect(this.ac.destination);

    this.floor = 0.006;
    this.voicedFrames = 0;
    const floorSamples = [];
    const t0 = performance.now();
    let hits = 0, fired = false, lastUi = 0;

    this.proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      this.rms = rms;
      const el = performance.now() - t0;

      // 最初の400msでノイズフロアを測る（環境音の大小に自動で追従させる）
      if (el < 400) { floorSamples.push(rms); }
      else if (floorSamples.length) {
        floorSamples.sort((a, b) => a - b);
        this.floor = Math.max(0.004, floorSamples[Math.floor(floorSamples.length / 2)] * 3);
        floorSamples.length = 0;
      }
      const th = Math.max(this.floor, 0.012);
      const hot = rms > th;
      if (hot) { hits++; this.voicedFrames++; } else { hits = 0; }

      if (this.onLevel && el - lastUi > 66) {   // 描画は15Hzで十分
        lastUi = el;
        this.onLevel(Math.min(100, Math.sqrt(rms / 0.14) * 100), hot);
      }
      // 3フレーム(≒64ms)続けてしきい値超え＝話し始めた
      if (!fired && hits >= 3 && el > 420) { fired = true; if (this.onVoice) this.onVoice(); }
    };
  },

  async stop() {
    if (this.proc) this.proc.onaudioprocess = null;
    const blob = await new Promise(resolve => {
      if (!this.rec || this.rec.state === 'inactive') return resolve(null);
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      this.rec.stop();
    });
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch {}
    // acはセッション中つないだままにする（iOSは作り直しが効かないことがある）
    try { this.src && this.src.disconnect(); } catch {}
    try { this.proc && this.proc.disconnect(); } catch {}
    try { this.mute && this.mute.disconnect(); } catch {}
    this.src = this.proc = this.mute = null;
    this.stream = null; this.rec = null;
    this.onVoice = null; this.onLevel = null;
    return blob;
  },
};

const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});
/* ════════ Gemini ════════ */
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(parts, sysText, schema, temperature = 0.35) {
  const key = S.settings.apiKey.trim();
  if (!key) throw Object.assign(new Error('APIキーが未設定です'), { nokey: true });
  const res = await fetch(`${API}/${S.settings.model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sysText }] },
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature },
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  const txt = d?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  return JSON.parse(txt);
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string' },
    ok: { type: 'boolean' },
    whyJa: { type: 'string' },
    minimalEdit: { type: 'string' },
    edits: {
      type: 'array', items: {
        type: 'object',
        properties: { before: { type: 'string' }, after: { type: 'string' }, whyJa: { type: 'string' } },
        required: ['before', 'after', 'whyJa'],
      },
    },
    better: { type: 'string' },
    chunks: {
      type: 'array', items: {
        type: 'object', properties: { en: { type: 'string' }, ja: { type: 'string' } },
        required: ['en', 'ja'],
      },
    },
    fillerCount: { type: 'integer' }, wordCount: { type: 'integer' },
  },
  required: ['transcript', 'ok', 'whyJa', 'minimalEdit', 'edits', 'better', 'chunks', 'fillerCount', 'wordCount'],
};

// 「原文を残して最小の手直し」を守らせるのがこのプロンプトの全て。
// 放っておくとモデルは短く書き直してしまう（検証で実際にそうなった）。
const COACH = `You are a speaking coach for a 35-year-old Japanese structural engineer.
He is practising the exact situation he fails at: explaining WHERE something is while screen-sharing a drawing in a meeting.
He cannot point with his finger, so everything has to be said in words. His grammar knowledge is fine; the problem is speed.

Judge only whether the message got across. Do not fail him for accent, fillers, or small grammar slips.

RULES FOR minimalEdit — these matter more than anything else:
- Start from HIS sentence, exactly as he said it. Keep his wording, his word order, his clauses.
- Fix things IN PLACE. Never delete a clause he said just to make the sentence shorter or tidier.
- If a clause was clumsy but not wrong, leave it alone.
- Redundancy is NOT an error. If what he said is true and understandable, KEEP IT, even when a shorter
  sentence would exist. He said it on purpose. Shortening belongs in "better", never here.
- Only drop something if it was actually incorrect, contradictory, or an abandoned false start
  ("under the, no, next to" -> keep only "next to").
- Keeping his wording does NOT mean leaving errors in. Fix real grammar in place: a missing article
  or preposition, a wrong tense, a wrong word. "it is right side" -> "it is on the right side".
  Keep the clause, repair it.
- Remove fillers (uh, um) and false starts — those are not "his wording".
- If nothing needs fixing, return his sentence unchanged and an empty edits array.

"better" is the separate place for a fluent rewrite. Put the polished version THERE, not in minimalEdit.
All Japanese must be short and plain. Never lecture.`;

function judgeSys(item) {
  const p = item.pattern;
  let t = COACH + '\n\n';
  if (item.fig) {
    t += `He was shown a drawing and asked out loud: "${item.question}"\n`
      + `The drawing: ${item.fig.context}\n`
      + `The correct answer — what is actually highlighted — is: ${item.truth}\n`
      + `The audio is his spoken answer. Set ok=true if someone looking at the same drawing could pin down that element from what he said. Grid names, "from the left", and relative position all count.\n`;
  } else if (item.imageId) {
    t += `The attached image is a screen he was looking at. He is practising something he could not say about it.\n`
      + `What he wanted to convey: ${item.intentJa}\n`
      + `The audio is his spoken attempt in English. Set ok=true if that intention got across.\n`;
  } else {
    t += `He had to say this in English, out loud, in a screen-sharing meeting:\n「${item.intentJa}」\n`
      + (item.target ? `One natural way is "${item.target}", but any wording that conveys it counts.\n` : '')
      + `The audio is his spoken attempt. Set ok=true if the intention got across.\n`;
  }
  if (p) t += `\nToday he is working on this pattern: ${p.en}${p.note ? ` (${p.note})` : ''}. `
    + `Prefer chunks that reinforce it.\n`;
  t += `\nReturn JSON. chunks = exactly 3 multi-word phrases he needed but did not have. `
    + `whyJa = one short Japanese sentence on what made it work, or what was missing.`;
  return t;
}

async function judge(item, blob) {
  const parts = [];
  if (item.imageId) {
    const img = await IDB.get(item.imageId);
    if (img) parts.push({ inline_data: { mime_type: img.type || 'image/jpeg', data: await blobToB64(img) } });
  }
  parts.push({ inline_data: { mime_type: (Mic.mime || 'audio/webm').split(';')[0], data: await blobToB64(blob) } });
  return callGemini(parts, judgeSys(item), JUDGE_SCHEMA, 0.35);
}

/* ── 受信箱 → 型 ── */
const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    intentJa: { type: 'string' },
    modelEn: { type: 'string' },
    patternEn: { type: 'string' },
    patternJa: { type: 'string' },
    noteJa: { type: 'string' },
    relation: { type: 'string' },
    variants: {
      type: 'array', minItems: 3, maxItems: 3, items: {
        type: 'object', properties: { ja: { type: 'string' }, en: { type: 'string' } },
        required: ['ja', 'en'],
      },
    },
  },
  required: ['intentJa', 'modelEn', 'patternEn', 'patternJa', 'noteJa', 'relation', 'variants'],
};

const CAPTURE_SYS = `A Japanese structural engineer is telling you about something he wanted to say in English today and could not.
The input may be his voice (in Japanese), typed Japanese, or a screenshot with a note. Work out what he was trying to say.

Return JSON:
- intentJa: what he wanted to convey, as ONE short plain Japanese sentence.
- modelEn: how to say that in natural spoken English. Short. Something he could actually say at speed.
- patternEn: the reusable PATTERN behind it, with placeholders, e.g. "X is directly below Y" or "Let me zoom in on ~".
  This is the thing to master, not this one sentence.
- patternJa: the same pattern in short Japanese, e.g. "AがBの真下にある".
- noteJa: one short Japanese line on the point to watch (max 40 chars). Say why the obvious wrong choice is wrong.
- relation: if this is about physical position on a drawing, one of
  between / nth-from / below / above / same-level / left-right / inside / adjacent.
  If it is not about position at all, return "none".
- variants: exactly 3 OTHER sentences using the SAME pattern with different content, drawn from
  structural design, site work, and meetings. Each {ja, en}. These become tomorrow's questions,
  so they must be things he would plausibly need to say.`;

async function captureToPattern(inboxItem) {
  const parts = [];
  if (inboxItem.imageId) {
    const img = await IDB.get(inboxItem.imageId);
    if (img) parts.push({ inline_data: { mime_type: img.type || 'image/jpeg', data: await blobToB64(img) } });
  }
  if (inboxItem.audioId) {
    const a = await IDB.get(inboxItem.audioId);
    if (a) parts.push({ inline_data: { mime_type: (a.type || 'audio/webm').split(';')[0], data: await blobToB64(a) } });
  }
  if (inboxItem.raw) parts.push({ text: `彼のメモ: ${inboxItem.raw}` });
  if (!parts.length) throw new Error('中身が空です');
  return callGemini(parts, CAPTURE_SYS, CAPTURE_SCHEMA, 0.5);
}

/* ════════ 間隔反復（型ごと） ════════
 * 14日ぶんを早送りして検証したところ、初期実装は
 *   ・最初の3日間「未習得30」のまま数字が1ミリも動かない
 *   ・6日目にデッキが空になり、やることが無くなる
 * という最悪の形だった。続くかどうかはこの数字が動くかで決まるので作り直した。
 *   - 新しい型は1日 newPerDay 個ずつしか下ろさない（30個を初日に浴びせない）
 *   - 卒業までの間隔は1日刻み。3日連続で言えたら卒業＝3日目に必ず数字が動く
 *   - 卒業した型も忘れた頃に戻ってくる。空にはならない
 */
const DAY = 86400e3;
const REVIEW_1 = 10 * DAY;   // 卒業直後の復習。14日にすると2週目に3日ほど何もない日ができた
const REVIEW_2 = 40 * DAY;   // その次

const isGraduated = (p) => (p.streak || 0) >= 3;
const isIntroduced = (p) => !!p.introducedAt;
const livePatterns = () => S.patterns.filter(p => !isGraduated(p));

// 今日すでに下ろした新しい型の数
function newToday() {
  const t = today();
  return S.patterns.filter(p => p.introducedAt &&
    new Date(p.introducedAt).toLocaleDateString('sv-SE') === t).length;
}

// 今日やるぶん: ①期限が来た復習 ②卒業組の再確認 ③1日の上限までの新しい型
function dueList() {
  const now = Date.now();
  const shuffle = (arr) => arr.map(x => ({ x, r: Math.random() }))
    .sort((a, b) => a.r - b.r).map(o => o.x);
  const reviews = livePatterns().filter(p => isIntroduced(p) && (p.due || 0) <= now)
    .sort((a, b) => (a.due || 0) - (b.due || 0));
  const graduated = S.patterns.filter(p => isGraduated(p) && (p.due || 0) <= now);
  const room = Math.max(0, (Number(S.settings.newPerDay) || 4) - newToday());
  const fresh = shuffle(livePatterns().filter(p => !isIntroduced(p))).slice(0, room);
  return reviews.concat(graduated, fresh);
}

function scorePattern(p, ok) {
  p.seen = (p.seen || 0) + 1;
  if (!p.introducedAt) p.introducedAt = Date.now();
  const wasGrad = isGraduated(p);
  if (ok) {
    p.ok = (p.ok || 0) + 1;
    if (wasGrad) { p.due = Date.now() + REVIEW_2; return; }   // 再確認に通った
    p.streak = (p.streak || 0) + 1;
    if (p.streak >= 3) { p.graduatedAt = Date.now(); p.due = Date.now() + REVIEW_1; }
    else p.due = Date.now() + DAY;                            // 卒業までは1日刻み
  } else {
    p.ng = (p.ng || 0) + 1;
    // 卒業組を落としたら丸ごと振り出しには戻さない。あと1回で戻れる位置に置く
    p.streak = wasGrad ? 2 : 0;
    p.due = Date.now();
  }
}

/* ════════ セッション組み立て ════════ */
let sess = null;

function makeItem(p) {
  const base = { pattern: p, answerSec: Number(S.settings.answerSec) || 25 };

  // 1つの型を、複数の出し方で回す。
  //  - 自分の失敗由来 / 決まり文句 → 「日本語の意図 → 英語で言う」（変奏を順に）
  //  - 位置関係を持つ型          → 自動生成した図を見て説明する
  // 位置の型を自分で入れた場合は両方が混ざり、同じ文の丸暗記にならない。
  const shots = [];
  if (p.kind === 'intent' || p.source === 'capture') {
    const pool = [{ ja: p.ja, en: p.modelEn || p.en, first: true }].concat(p.variants || []);
    pool.forEach(v => shots.push({ type: 'intent', v }));
  }
  if (p.relation && p.relation !== 'none' && RELATIONS.includes(p.relation)) {
    shots.push({ type: 'figure' });
  }
  if (!shots.length) shots.push({ type: 'intent', v: { ja: p.ja, en: p.en, first: true } });

  const shot = shots[(p.seen || 0) % shots.length];
  if (shot.type === 'figure') {
    const fig = genFigure(p.relation, S.settings.figKinds);
    return Object.assign(base, { fig, question: fig.question, truth: fig.truth });
  }
  return Object.assign(base, {
    intentJa: shot.v.ja, target: shot.v.en,
    // スクショは元の1件にしか対応しないので、変奏には付けない
    imageId: (shot.v.first && p.imageId) ? p.imageId : null,
    question: 'Say it in English.',
  });
}

function buildSession(n = 8, ahead = false) {
  let list = dueList();
  if (ahead) {
    // 期限前でも先にやる。何も出ない日を作らないための逃げ道
    const more = livePatterns().filter(p => !list.includes(p))
      .sort((a, b) => (a.due || 0) - (b.due || 0));
    list = list.concat(more);
  }
  if (!list.length) return false;
  sess = { items: list.slice(0, n).map(makeItem), idx: 0, results: [], startedAt: Date.now() };
  return true;
}

/* ════════ ドリル進行 ════════ */
const RING_LEN = 465;
let phase = 'ready';
let clockT = 0, ttfwStart = 0, ttfw = null, speakStart = 0;
let lastBlob = null, lastLocal = { ttfw: null, speakSec: 0 };
let lastObjURL = null;
let aheadMode = false;

function setRing(frac, color) {
  $('ringArc').setAttribute('stroke-dashoffset', String(RING_LEN * (1 - Math.max(0, Math.min(1, frac)))));
  $('ringArc').setAttribute('stroke', color);
}

async function renderItem() {
  const it = sess.items[sess.idx];
  $('dots').innerHTML = sess.items
    .map((_, i) => `<span class="dot ${i < sess.idx ? 'done' : i === sess.idx ? 'now' : ''}"></span>`).join('');
  $('qLabel').textContent = `${sess.idx + 1} / ${sess.items.length}`;
  // 型のヒントは図の問題だけ。意図カードでは p.en が答えそのものなので出さない。
  $('qPattern').textContent = it.fig ? '🎯 ' + (it.pattern.en || '') : '';

  const stage = $('figWrap');
  if (it.fig) {
    stage.innerHTML = it.fig.svg;
    stage.style.display = '';
    $('qText').textContent = it.question;
    $('qJa').textContent = S.settings.showJa ? (it.pattern.ja || '') : '';
  } else if (it.imageId) {
    const img = await IDB.get(it.imageId);
    if (lastObjURL) { URL.revokeObjectURL(lastObjURL); lastObjURL = null; }
    if (img) { lastObjURL = URL.createObjectURL(img); stage.innerHTML = `<img src="${lastObjURL}" alt="">`; }
    else stage.innerHTML = '';
    stage.style.display = img ? '' : 'none';
    $('qText').textContent = it.intentJa;
    $('qJa').textContent = 'これを英語で';
  } else {
    stage.innerHTML = ''; stage.style.display = 'none';
    $('qText').textContent = it.intentJa;
    $('qJa').textContent = 'これを英語で';
  }

  $('ringNum').textContent = '▶'; $('ringLbl').textContent = '';
  $('lvl').style.width = '0%';
  setRing(1, '#242c38');
  $('drillStatus').className = 'status';
  $('drillStatus').textContent = '準備ができたら開始';
  $('btnDrill').textContent = '開始'; $('btnDrill').disabled = false;
  phase = 'ready';
}

async function beginItem() {
  const it = sess.items[sess.idx];
  warmTTS();
  phase = 'listen';
  $('btnDrill').disabled = true; $('btnDrill').textContent = '…';
  $('ringNum').textContent = '🔊';
  $('drillStatus').textContent = '聞いて…';
  // 図の問題だけ読み上げる。意図カードは日本語なので読み上げない。
  if (S.settings.speakQuestion && it.fig) await speak(it.question, 0.95);

  $('drillStatus').textContent = 'マイク準備中…';
  try { await Mic.start(); }
  catch {
    $('drillStatus').className = 'status late';
    $('drillStatus').textContent = 'マイクが使えません（HTTPSと許可が必要）';
    $('btnDrill').disabled = false; $('btnDrill').textContent = 'もう一度';
    phase = 'ready'; return;
  }

  phase = 'wait'; ttfw = null; ttfwStart = performance.now();
  $('btnDrill').disabled = false; $('btnDrill').textContent = '話し終わった';
  $('ringLbl').textContent = '出だし';
  $('drillStatus').className = 'status';
  $('drillStatus').textContent = '3秒以内に口を開く！';

  Mic.onLevel = (pct, hot) => {
    $('lvl').style.width = pct.toFixed(0) + '%';
    $('lvl').style.background = hot ? 'var(--accent)' : 'var(--dim2)';
  };
  Mic.onVoice = () => { if (phase === 'wait') startAnswer(); };

  clearInterval(clockT);
  clockT = setInterval(() => {
    if (phase !== 'wait') return;
    const el = (performance.now() - ttfwStart) / 1000;
    $('ringNum').textContent = el.toFixed(1);
    if (el < 3) setRing(el / 3, '#4dd08a');
    else if (el < 6) {
      setRing(1, '#ffb020');
      $('drillStatus').className = 'status late';
      $('drillStatus').textContent = '"Well, ..." でいいから声を出す';
    } else setRing(1, '#ff5f56');
    if (el > 12) finishItem(true);
  }, 100);
}

function startAnswer() {
  const it = sess.items[sess.idx];
  ttfw = (performance.now() - ttfwStart) / 1000;
  speakStart = performance.now();
  phase = 'answer';
  $('ringLbl').textContent = `出だし ${ttfw.toFixed(1)}秒`;
  $('drillStatus').className = 'status hot';
  $('drillStatus').textContent = '話し続ける — 詰まったら言い換える';
  clearInterval(clockT);
  const t0 = performance.now();
  clockT = setInterval(() => {
    const left = it.answerSec - (performance.now() - t0) / 1000;
    $('ringNum').textContent = Math.max(0, Math.ceil(left));
    setRing(left / it.answerSec, left < 5 ? '#ffb020' : '#3ba0ff');
    if (left <= 0) finishItem(false);
  }, 100);
}

async function finishItem(silent) {
  clearInterval(clockT);
  phase = 'analyzing';
  $('btnDrill').disabled = true; $('btnDrill').textContent = '…';
  $('ringNum').textContent = '…';
  $('drillStatus').className = 'status';
  $('drillStatus').textContent = silent ? '声が拾えませんでした' : '判定中…';
  const speakSec = speakStart ? (performance.now() - speakStart) / 1000 : 0;
  speakStart = 0;
  lastLocal = { ttfw, speakSec };

  const blob = await Mic.stop();
  lastBlob = blob;
  const it = sess.items[sess.idx];

  if (silent || !blob || blob.size < 1200) {
    scorePattern(it.pattern, false); save();
    return showFeedback(null, silent ? 'まず声を出すところから。次は "Well," だけでもいい。' : null);
  }
  try {
    const fb = await judge(it, blob);
    scorePattern(it.pattern, !!fb.ok);
    S.history.push({ at: Date.now(), patternId: it.pattern.id, ttfw: lastLocal.ttfw, ok: !!fb.ok, words: fb.wordCount });
    save();
    showFeedback(fb, null);
  } catch (e) {
    showFeedback(null, e.nokey
      ? '設定でGemini APIキーを入れると、判定・最小手直し・お手本が出ます。'
      : '判定の取得に失敗: ' + e.message);
  }
}

/* ════════ フィードバック ════════ */
function showFeedback(fb, note) {
  const it = sess.items[sess.idx];
  const p = it.pattern;
  sess.results.push({ ok: fb ? !!fb.ok : false, ttfw: lastLocal.ttfw, words: fb ? fb.wordCount : null });

  const set = (id, v, cls) => {
    const el = $(id); el.querySelector('.v').textContent = v;
    el.className = 'score' + (cls ? ' ' + cls : '');
  };
  set('scTtfw', lastLocal.ttfw == null ? '–' : lastLocal.ttfw.toFixed(1),
    lastLocal.ttfw == null ? '' : lastLocal.ttfw <= 3 ? 'good' : 'warn');
  set('scOk', fb ? (fb.ok ? '◯' : '△') : '–', fb ? (fb.ok ? 'good' : 'warn') : '');
  set('scWords', fb ? fb.wordCount : '–');
  set('scStreak', `${p.streak || 0}/3`, (p.streak || 0) >= 3 ? 'good' : '');

  $('fbTitle').textContent = (p.streak || 0) >= 3 ? '🎓 この型は卒業' : '結果';
  $('fbCount').textContent = `${sess.idx + 1} / ${sess.items.length}`;

  let h = '';
  if (note) h += `<div class="card"><div class="muted">${esc(note)}</div></div>`;

  if (fb && !String(fb.transcript || '').trim()) {
    h += `<div class="card" style="border-color:#5a3a2a">
      <div style="font-size:15px">🎤 音声を聞き取れませんでした</div>
      <div class="muted" style="margin-top:6px">マイクに近づくか、静かな場所で試してください。</div></div>`;
  }

  if (fb) {
    h += `<div class="card" style="border-color:${fb.ok ? '#2a4a38' : '#5a4a2a'}">
      <span class="badge ${fb.ok ? '' : 'warn'}">${fb.ok ? '通じています' : 'もう一歩'}</span>
      <div style="margin-top:9px; font-size:14.5px">${esc(fb.whyJa)}</div></div>`;

    h += `<div class="card"><div class="sect">言ったこと</div>
      <div class="said">${esc(fb.transcript)}</div></div>`;

    if (fb.edits && fb.edits.length) {
      h += `<div class="card"><div class="sect">最小の手直し（${fb.edits.length}ヶ所）</div>` +
        fb.edits.map(e => `<div class="fix">
          <span class="del">${esc(e.before)}</span> → <span class="ins">${esc(e.after)}</span>
          <div class="w">${esc(e.whyJa)}</div></div>`).join('') +
        `<div class="final">→ "${esc(fb.minimalEdit)}"</div>
         <button class="playbtn" data-say="${esc(fb.minimalEdit)}">🔊 聞く</button></div>`;
    } else {
      h += `<div class="card"><div class="sect">直すところなし</div>
        <div class="final">"${esc(fb.minimalEdit)}"</div>
        <button class="playbtn" data-say="${esc(fb.minimalEdit)}">🔊 聞く</button></div>`;
    }

    h += `<div class="card"><div class="sect">もう一段スムーズに</div>
      <div class="up">"${esc(fb.better)}"</div>
      <button class="playbtn" data-say="${esc(fb.better)}">🔊 聞く</button></div>`;

    if (fb.chunks && fb.chunks.length) {
      h += `<div class="card"><div class="sect">次に使うチャンク</div>` +
        fb.chunks.map(c => `<div class="chunk"><span class="en">${esc(c.en)}</span>
          <span class="ja">${esc(c.ja)}</span></div>`).join('') + `</div>`;
    }
  }

  if (it.truth) {
    h += `<div class="card"><details><summary>正解の位置</summary>
      <div class="tx" style="margin-top:8px">${esc(it.truth)}</div></details></div>`;
  }

  $('fbBody').innerHTML = h;
  $('btnNext').textContent = (sess.idx >= sess.items.length - 1) ? '終える' : '次へ';
  show('fb');
}

function endSession() {
  const rs = sess.results;
  const okN = rs.filter(r => r.ok).length;
  const tt = rs.filter(r => r.ttfw != null).map(r => r.ttfw);
  S.sessions.push({
    date: today(), at: Date.now(), n: rs.length, ok: okN,
    ttfw: tt.length ? +(tt.reduce((a, b) => a + b, 0) / tt.length).toFixed(2) : null,
  });
  save();
  $('dOk').textContent = `${okN}/${rs.length}`;
  $('dTtfw').textContent = tt.length ? (tt.reduce((a, b) => a + b, 0) / tt.length).toFixed(1) : '–';
  // 「あと1回で卒業」は、明日また開く理由になる数字
  $('dLeft').textContent = S.patterns.filter(p => (p.streak || 0) === 2).length;
  const grad = S.patterns.filter(p => p.graduatedAt && Date.now() - p.graduatedAt < 3600e3);
  $('doneGrad').style.display = grad.length ? '' : 'none';
  $('doneGradList').innerHTML = grad.map(p =>
    `<div class="chunk"><span class="en">${esc(p.en)}</span><span class="ja">${esc(p.ja || '')}</span></div>`).join('');
  sess = null; Mic.closeCtx(); refreshHome(); show('done');
}

/* ════════ 「言えなかった」受信箱 ════════ */
let capBlob = null, capImageBlob = null;

function openCapture() {
  capBlob = null; capImageBlob = null;
  $('capText').value = '';
  $('capImgPrev').innerHTML = '';
  $('capVoiceState').textContent = '';
  $('btnCapVoice').textContent = '🎤 話して入れる';
  $('btnCapSave').disabled = false;
  backTo = 'home'; show('capture');
}

async function capRecordToggle() {
  const b = $('btnCapVoice');
  if (Mic.stream) {
    capBlob = await Mic.stop();
    b.textContent = '🎤 録り直す';
    $('capVoiceState').textContent = capBlob ? `録音しました（${(capBlob.size / 1024).toFixed(0)}KB）` : '録れませんでした';
    return;
  }
  Mic.ensureCtx();
  try { await Mic.start(); } catch { toast('マイクが使えません'); return; }
  b.textContent = '⏹ 止める';
  $('capVoiceState').textContent = '日本語でいいので、言えなかったことを話してください';
}

async function saveCapture() {
  const text = $('capText').value.trim();
  if (!text && !capBlob && !capImageBlob) { toast('何か入れてください'); return; }
  if (Mic.stream) capBlob = await Mic.stop();
  const item = { id: uid(), at: Date.now(), raw: text, status: 'new', patternId: null };
  if (capBlob) { item.audioId = 'a' + item.id; await IDB.put(item.audioId, capBlob); }
  if (capImageBlob) { item.imageId = 'i' + item.id; await IDB.put(item.imageId, capImageBlob); }
  S.inbox.unshift(item); save();
  Mic.closeCtx();
  toast('受信箱に入れました');
  refreshHome(); show('home');
}

function renderInbox() {
  const list = S.inbox;
  $('inboxCount').textContent = `(${list.filter(i => i.status === 'new').length}件 未処理)`;
  $('inboxList').innerHTML = list.length ? list.map(i => `
    <div class="card" data-inbox="${i.id}">
      <div class="muted2">${new Date(i.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        ${i.imageId ? ' · 🖼' : ''}${i.audioId ? ' · 🎤' : ''}</div>
      <div style="font-size:15px; margin:6px 0">${esc(i.raw || (i.audioId ? '(音声メモ)' : '(画像のみ)'))}</div>
      ${i.status === 'new'
        ? `<button class="ghost" data-make="${i.id}">型にする</button>`
        : `<div class="muted" style="font-size:13px">✅ 型にしました: <b style="color:var(--accent)">${esc(i.patternEn || '')}</b></div>`}
    </div>`).join('') : '<div class="muted2">「言えなかった」を入れるとここに溜まります</div>';
}

async function makePattern(inboxId, btn) {
  const item = S.inbox.find(i => i.id === inboxId);
  if (!item) return;
  btn.innerHTML = '<span class="spin"></span> 型を作っています…';
  btn.disabled = true;
  try {
    const r = await captureToPattern(item);
    const rel = RELATIONS.includes(r.relation) ? r.relation : null;
    const p = {
      id: 'c-' + item.id, source: 'capture',
      kind: (rel && !item.imageId) ? 'figure' : 'intent',
      relation: rel, en: r.patternEn, ja: r.intentJa, note: r.noteJa,
      modelEn: r.modelEn, variants: (r.variants || []).slice(0, 3),
      imageId: item.imageId || null,
      box: 0, due: 0, streak: 0, seen: 0, ok: 0, ng: 0, createdAt: Date.now(),
    };
    // intent カードは ja/en の対で出すので、代表の英文を en 側に持たせない
    if (p.kind === 'intent') { p.ja = r.intentJa; p.en = r.patternEn; }
    S.patterns.push(p);
    item.status = 'done'; item.patternId = p.id; item.patternEn = r.patternEn;
    if (item.audioId) { await IDB.del(item.audioId); delete item.audioId; }  // 音声はもう要らない
    save(); renderInbox(); refreshHome();
    toast(`型「${r.patternEn}」を追加（変奏${p.variants.length}問つき）`);
  } catch (e) {
    btn.disabled = false; btn.textContent = '型にする';
    toast('失敗: ' + e.message);
  }
}

/* ════════ ホーム・型一覧・記録 ════════ */
function streak() {
  const days = [...new Set(S.sessions.map(s => s.date))].sort().reverse();
  if (!days.length) return 0;
  let n = 0; const d = new Date(Date.now());
  if (days[0] !== today()) d.setDate(d.getDate() - 1);
  for (;;) {
    const k = d.toLocaleDateString('sv-SE');
    if (days.includes(k)) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}

function refreshHome() {
  const total = S.patterns.length;
  const grad = S.patterns.filter(isGraduated).length;
  const due = dueList().length;
  // 主役は「今日やる型」。やれば必ず0になるので毎セッション動く。
  // 「未習得」だけを出していた頃は最初の3日間ずっと30のままだった。
  $('hDue').textContent = due;
  $('hGrad').textContent = `${grad}/${total}`;
  $('hStreak').textContent = streak();
  const nNew = S.inbox.filter(i => i.status === 'new').length;
  $('btnInbox').textContent = nNew ? `受信箱 ${nNew}` : '受信箱';
  $('btnInbox').classList.toggle('alert', nNew > 0);

  if (!window.isSecureContext || !navigator.mediaDevices) {
    $('homeNote').innerHTML = '⚠ このURLはHTTPSではないためマイクが使えません<br>'
      + '<span style="color:var(--dim2)">HTTPSで開くか、Mac上の http://localhost で開いてください</span>';
    $('btnStart').disabled = true; $('btnCapture').disabled = true;
    return;
  }
  // 期限が来ていなくても、やりたい日は前倒しでやれるようにする
  aheadMode = !due && livePatterns().length > 0;
  $('btnStart').textContent = aheadMode ? '前倒しでやる' : 'ドリルをやる';
  $('btnStart').disabled = !due && !aheadMode;
  $('btnCapture').disabled = false;
  $('homeNote').textContent = !S.settings.apiKey.trim()
    ? '⚠ 設定でAPIキーを入れると判定が出ます'
    : due ? `${Math.min(due, 8)}問・3分ほど`
      : '今日のぶんは終わりました。受信箱から型を足せます';
}

function renderPatterns() {
  const groups = [
    ['やること', livePatterns().sort((a, b) => (a.due || 0) - (b.due || 0))],
    ['卒業', S.patterns.filter(p => (p.streak || 0) >= 3)],
  ];
  $('patList').innerHTML = groups.map(([t, arr]) => arr.length ? `
    <div class="card"><div class="sect">${t} (${arr.length})</div>` + arr.map(p => `
      <div class="chunk">
        <span class="en">${esc(p.en)}</span>
        <span class="ja">${esc(p.ja || '')}
          <span class="muted2">${(p.streak || 0) >= 3 ? '✓' : `${p.streak || 0}/3`}${p.source === 'capture' ? ' · 自分' : ''}</span>
        </span>
      </div>`).join('') + `</div>` : '').join('')
    || '<div class="muted2">まだありません</div>';
}

/* ════════ 設定 ════════ */
function renderSettings() {
  $('inKey').value = S.settings.apiKey;
  $('inModel').value = S.settings.model;
  $('inAnswerSec').value = String(S.settings.answerSec);
  $('inNewPerDay').value = String(S.settings.newPerDay);
  $('tgSpeak').classList.toggle('on', !!S.settings.speakQuestion);
  $('tgJa').classList.toggle('on', !!S.settings.showJa);
  $$('#figChips .chip').forEach(c => c.classList.toggle('on', S.settings.figKinds.includes(c.dataset.fig)));
}

/* ════════ イベント配線 ════════ */
$('btnStart').addEventListener('click', () => {
  warmTTS(); Mic.ensureCtx();
  if (!buildSession(8, aheadMode)) {
    toast(livePatterns().length ? '今日のぶんは終わりました' : '全部卒業しました。受信箱から型を足してください');
    return;
  }
  renderItem().then(() => show('drill'));
});
$('btnDrill').addEventListener('click', () => {
  Mic.ensureCtx();
  if (phase === 'ready') beginItem();
  else if (phase === 'wait' || phase === 'answer') finishItem(phase === 'wait');
});
$('btnQuit').addEventListener('click', async () => {
  clearInterval(clockT);
  if (Mic.stream) await Mic.stop();
  Mic.closeCtx(); speechSynthesis.cancel();
  sess = null; refreshHome(); show('home');
});
$('btnNext').addEventListener('click', () => {
  speechSynthesis.cancel();
  if (sess.idx >= sess.items.length - 1) return endSession();
  sess.idx++; renderItem().then(() => show('drill'));
});
$('fbBody').addEventListener('click', e => {
  const say = e.target.closest('[data-say]');
  if (say) speak(say.dataset.say, 0.92);
});
$('btnHome').addEventListener('click', () => show('home'));

$('btnCapture').addEventListener('click', openCapture);
$('btnCapVoice').addEventListener('click', capRecordToggle);
$('capFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    capImageBlob = await shrinkImage(f);
    $('capImgPrev').innerHTML = `<img src="${URL.createObjectURL(capImageBlob)}" alt="">`;
  } catch (err) { toast(err.message); }
});
$('btnCapSave').addEventListener('click', saveCapture);
$('btnCapCancel').addEventListener('click', async () => {
  if (Mic.stream) await Mic.stop();
  Mic.closeCtx(); show('home');
});

$('btnInbox').addEventListener('click', () => { backTo = 'home'; renderInbox(); show('inbox'); });
$('inboxList').addEventListener('click', e => {
  const b = e.target.closest('[data-make]');
  if (b) makePattern(b.dataset.make, b);
});
$('btnPatterns').addEventListener('click', () => { backTo = 'home'; renderPatterns(); show('patterns'); });
$('btnSettings').addEventListener('click', () => { backTo = 'home'; renderSettings(); show('settings'); });
$$('[data-back]').forEach(b => b.addEventListener('click', () => show(backTo)));

$('inKey').addEventListener('change', e => { S.settings.apiKey = e.target.value.trim(); save(); refreshHome(); });
$('inModel').addEventListener('change', e => { S.settings.model = e.target.value; save(); });
$('inAnswerSec').addEventListener('change', e => { S.settings.answerSec = Number(e.target.value); save(); });
$('inNewPerDay').addEventListener('change', e => { S.settings.newPerDay = Number(e.target.value); save(); refreshHome(); });
$('tgSpeak').addEventListener('click', () => {
  S.settings.speakQuestion = !S.settings.speakQuestion;
  $('tgSpeak').classList.toggle('on', S.settings.speakQuestion); save();
});
$('tgJa').addEventListener('click', () => {
  S.settings.showJa = !S.settings.showJa;
  $('tgJa').classList.toggle('on', S.settings.showJa); save();
});
$('figChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const set = new Set(S.settings.figKinds);
  set.has(c.dataset.fig) ? set.delete(c.dataset.fig) : set.add(c.dataset.fig);
  if (!set.size) set.add(c.dataset.fig);
  S.settings.figKinds = [...set]; save();
  $$('#figChips .chip').forEach(x => x.classList.toggle('on', S.settings.figKinds.includes(x.dataset.fig)));
});
$('btnTestKey').addEventListener('click', async () => {
  const k = $('inKey').value.trim(); S.settings.apiKey = k; save();
  const m = $('keyMsg');
  if (!k) { m.textContent = 'キーが空です'; return; }
  m.innerHTML = '<span class="spin"></span> 確認中…';
  try {
    const r = await fetch(`${API}/${S.settings.model}:generateContent?key=${encodeURIComponent(k)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'say OK' }] }] }),
    });
    m.textContent = r.ok ? '✅ つながりました' : `❌ ${r.status} ${(await r.text()).slice(0, 100)}`;
    refreshHome();
  } catch (e) { m.textContent = '❌ ' + e.message; }
});
$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `karutalk-${today()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('btnReset').addEventListener('click', () => {
  if (!confirm('型の習得状況と受信箱をすべて消します。よろしいですか？')) return;
  const key = S.settings.apiKey;
  localStorage.removeItem(KEY);
  S = load(); S.settings.apiKey = key; save();
  renderPatterns(); refreshHome(); toast('消去しました');
});

/* ════════ 起動 ════════ */
save();
refreshHome();
