/* KaruTalk — 英語の瞬発力ドリル
 * 設計の要点:
 *  - 「出だしまでの秒数(TTFW)」はローカルのWeb Audioで測る。ネットにも音声認識にも依存しない。
 *  - 文字起こしと添削は録り終わったあとにGeminiへ1回投げるだけ。ドリル中は絶対に通信を待たせない。
 *  - APIキーが無くても計測だけで回る（続けられることを最優先）。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ════════ 保存 ════════ */
const KEY = 'karutalk.v1';
const DEFAULTS = {
  settings: {
    apiKey: '', model: 'gemini-3.5-flash-lite', answerSec: 25,
    speakPrompt: true, autoModel: false, showJa: false,
    cats: ['work', 'daily', 'opinion'], mode: 'quick',
  },
  sessions: [],   // {date, mode, items:[{ttfw, speakSec, words, fillers}]}
  chunks: [],     // {en, ja, use, addedAt, seen, used}
  recent: [],     // 直近に出したお題ID（連続で同じお題を出さない）
};

let S = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      settings: Object.assign({}, DEFAULTS.settings, raw.settings || {}),
      sessions: raw.sessions || [],
      chunks: raw.chunks || [],
      recent: raw.recent || [],
    };
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* プライベートブラウズ等 */ }
}

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
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD(ローカル)

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
  stream: null, rec: null, chunks: [], mime: '', ac: null, analyser: null, buf: null, raf: 0,
  rms: 0, floor: 0.006, onVoice: null, onLevel: null, voicedFrames: 0, src: null,

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
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);

    this.ensureCtx();
    if (this.ac.state === 'suspended') { try { await this.ac.resume(); } catch {} }
    this.src = this.ac.createMediaStreamSource(this.stream);
    this.analyser = this.ac.createAnalyser();
    this.analyser.fftSize = 1024;
    this.src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);

    // 最初の400msでノイズフロアを測る
    this.floor = 0.006; this.voicedFrames = 0;
    const floorSamples = [];
    const t0 = performance.now();
    let hits = 0, fired = false;

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.analyser.getFloatTimeDomainData(this.buf);
      let s = 0;
      for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(s / this.buf.length);
      this.rms = rms;
      const el = performance.now() - t0;
      if (el < 400) { floorSamples.push(rms); }
      else if (floorSamples.length) {
        floorSamples.sort((a, b) => a - b);
        this.floor = Math.max(0.004, floorSamples[Math.floor(floorSamples.length / 2)] * 2.5);
        floorSamples.length = 0;
      }
      const th = Math.max(this.floor, 0.012);
      if (rms > th) { hits++; this.voicedFrames++; } else { hits = 0; }
      if (this.onLevel) this.onLevel(Math.min(100, Math.sqrt(rms / 0.14) * 100), rms > th);
      // 3フレーム(≒50ms)続けてしきい値超え＝話し始めた
      if (!fired && hits >= 3 && el > 250) { fired = true; if (this.onVoice) this.onVoice(); }
    };
    loop();
  },

  async stop() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    const blob = await new Promise(resolve => {
      if (!this.rec || this.rec.state === 'inactive') return resolve(null);
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      this.rec.stop();
    });
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { this.src && this.src.disconnect(); } catch {}   // acはセッション中つないだままにする
    this.src = null; this.stream = null; this.rec = null;
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

/* ════════ Gemini（文字起こし＋添削を1回で） ════════ */
const SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string' },
    ok: { type: 'boolean' },
    praise: { type: 'string' },
    fixes: {
      type: 'array', items: {
        type: 'object',
        properties: { before: { type: 'string' }, after: { type: 'string' }, why: { type: 'string' } },
        required: ['before', 'after', 'why'],
      },
    },
    natural: { type: 'string' },
    chunks: {
      type: 'array', items: {
        type: 'object',
        properties: { en: { type: 'string' }, ja: { type: 'string' }, use: { type: 'string' } },
        required: ['en', 'ja', 'use'],
      },
    },
    usedTargets: { type: 'array', items: { type: 'string' } },
    fillerCount: { type: 'integer' },
    wordCount: { type: 'integer' },
  },
  required: ['transcript', 'ok', 'praise', 'fixes', 'natural', 'chunks', 'fillerCount', 'wordCount'],
};

function sysPrompt(question, targets, roundNote) {
  return `You are a speaking coach for a 35-year-old Japanese structural engineer working with Vietnamese and international colleagues.
His grammar knowledge is fine. His real problem is that words do not come out fast enough in real time.
Your job is to make his next attempt FASTER, not to make him sound academic.

He was asked out loud: "${question}"${roundNote ? `\n${roundNote}` : ''}
${targets.length ? `Phrases he was told to try to use today: ${targets.map(t => `"${t}"`).join(', ')}` : ''}

Return JSON:
- transcript: verbatim, keep fillers (uh, um) and grammar errors exactly as spoken. If there is no clear speech, return "".
- ok: true if a listener would understand his point.
- praise: ONE short Japanese sentence naming one SPECIFIC thing he did well. No generic flattery.
- fixes: at most 2 items {before, after, why}. Only errors that hurt clarity or sound clearly non-native. Ignore fillers and self-corrections. "why" in Japanese, max 25 characters. Empty array if nothing important.
- natural: the SAME content he said, rewritten the way a fluent speaker would actually say it out loud. 3-5 short sentences, spoken register, keep his facts. If he said almost nothing, write a model answer to the question instead, in simple spoken English.
- chunks: exactly 3 multi-word phrases (not single words) that he clearly needed but did not have, taken from where he hesitated or went around the word. {en, ja, use}; "use" is a Japanese note on when to use it, max 20 characters.
- usedTargets: which of today's target phrases he actually used, verbatim from the list. Empty array if none or if there were no targets.
- fillerCount: count of uh/um/er/ah type fillers.
- wordCount: words excluding fillers.

All Japanese text must be plain and short. Never lecture.`;
}

async function analyze(blob, question, targets, roundNote) {
  const key = S.settings.apiKey.trim();
  if (!key) throw Object.assign(new Error('NOKEY'), { nokey: true });
  const b64 = await blobToB64(blob);
  const mime = (Mic.mime || 'audio/webm').split(';')[0];
  const body = {
    system_instruction: { parts: [{ text: sysPrompt(question, targets, roundNote) }] },
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.4 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${S.settings.model}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API ${res.status}: ${t.slice(0, 160)}`);
  }
  const d = await res.json();
  const txt = d?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  return JSON.parse(txt);
}

/* ════════ セッション組み立て ════════ */
function pickPrompts(cats, n) {
  let pool = PROMPTS.filter(p => cats.includes(p.cat));
  if (!pool.length) pool = PROMPTS.slice();
  const fresh = pool.filter(p => !S.recent.includes(p.id));
  const use = fresh.length >= n ? fresh : pool;
  const shuffled = use.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function pickTargets() {
  // 覚えきっていない(used<3)チャンクから、出した回数が少ない順に2つ
  return S.chunks.filter(c => (c.used || 0) < 3)
    .sort((a, b) => (a.seen || 0) - (b.seen || 0) || a.addedAt - b.addedAt)
    .slice(0, 2);
}

let sess = null;

function buildSession(mode) {
  const cats = S.settings.cats;
  const targets = pickTargets();
  let items;
  if (mode === 'retell') {
    let pool = RETELL_TOPICS.filter(t => cats.includes(t.cat));
    if (!pool.length) pool = RETELL_TOPICS;
    const topic = pool[Math.floor(Math.random() * pool.length)];
    items = [60, 45, 30].map((sec, i) => ({
      prompt: topic, answerSec: sec, round: i + 1,
      label: `${i + 1}回目 / 3 · ${sec}秒`,
      roundNote: i === 0
        ? 'This is round 1 of a 4-3-2 fluency drill: he tells this story for 60 seconds.'
        : `This is round ${i + 1} of a 4-3-2 fluency drill. He is telling the SAME story again in less time (${sec}s). Judge him on fluency and compression, not on new content.`,
    }));
  } else {
    items = pickPrompts(cats, 5).map((p, i) => ({
      prompt: p, answerSec: Number(S.settings.answerSec) || 25, round: i + 1,
      label: `${i + 1} / 5`, roundNote: '',
    }));
  }
  sess = { mode, items, idx: 0, results: [], targets, startedAt: Date.now() };
  S.recent = items.map(i => i.prompt.id).concat(S.recent).slice(0, 20);
  targets.forEach(t => { t.seen = (t.seen || 0) + 1; });
  save();
}

/* ════════ ドリル進行 ════════ */
const RING_LEN = 465; // 2πr, r=74
let phase = 'ready';        // ready → listen → wait(出だし待ち) → answer → analyzing
let clockT = 0, ttfwStart = 0, ttfw = null, speakStart = 0;
let lastLocal = { ttfw: null, speakSec: 0 };
let lastBlob = null, lastFb = null;

function setRing(frac, color) {
  $('ringArc').setAttribute('stroke-dashoffset', String(RING_LEN * (1 - Math.max(0, Math.min(1, frac)))));
  $('ringArc').setAttribute('stroke', color);
}
function renderDots() {
  $('dots').innerHTML = sess.items
    .map((_, i) => `<span class="dot ${i < sess.idx ? 'done' : i === sess.idx ? 'now' : ''}"></span>`).join('');
}

function renderItem() {
  const it = sess.items[sess.idx];
  renderDots();
  $('drillMode').textContent = sess.mode === 'retell' ? '4-3-2 リテリング' : '瞬発ドリル';
  $('qLabel').textContent = it.label;
  $('qText').textContent = it.prompt.en;
  $('qJa').textContent = S.settings.showJa ? it.prompt.ja : '';
  $('qTarget').innerHTML = sess.targets.length
    ? '🎯 今日の狙い: ' + sess.targets.map(t => esc(t.en)).join(' / ') : '';
  $('ringNum').textContent = '▶';
  $('ringLbl').textContent = '';
  $('lvl').style.width = '0%';
  setRing(1, '#242c38');
  $('drillStatus').className = 'status';
  $('drillStatus').textContent = sess.mode === 'retell' && it.round > 1
    ? '同じ話を、もっと短く・もっと速く'
    : '準備ができたら開始';
  $('btnDrill').textContent = '開始';
  $('btnDrill').disabled = false;
  phase = 'ready';
}

async function beginItem() {
  const it = sess.items[sess.idx];
  warmTTS();

  // 1) お題を読み上げる
  phase = 'listen';
  $('btnDrill').disabled = true;
  $('btnDrill').textContent = '…';
  $('ringNum').textContent = '🔊';
  $('drillStatus').textContent = '聞いて…';
  if (S.settings.speakPrompt) await speak(it.prompt.en, 0.95);

  // 2) マイクを開く
  $('drillStatus').textContent = 'マイク準備中…';
  try {
    await Mic.start();
  } catch (e) {
    $('drillStatus').className = 'status late';
    $('drillStatus').textContent = 'マイクが使えません（HTTPSと許可が必要）';
    $('btnDrill').disabled = false; $('btnDrill').textContent = 'もう一度';
    phase = 'ready';
    return;
  }

  // 3) 出だし待ち（TTFW計測）
  phase = 'wait';
  ttfw = null;
  ttfwStart = performance.now();
  $('btnDrill').disabled = false;
  $('btnDrill').textContent = '話し終わった';
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
    if (el < 3) { setRing(el / 3, '#4dd08a'); }
    else if (el < 6) {
      setRing(1, '#ffb020');
      $('drillStatus').className = 'status late';
      $('drillStatus').textContent = `"${sess.opener || 'Well, ...'}" でいいから声を出す`;
    } else { setRing(1, '#ff5f56'); }
    if (el > 12) { finishItem(true); }   // 12秒沈黙なら打ち切り
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
  $('btnDrill').disabled = true;
  $('btnDrill').textContent = '…';
  $('ringNum').textContent = '…';
  $('drillStatus').className = 'status';
  $('drillStatus').textContent = silent ? '声が拾えませんでした' : '書き起こし中…';
  const speakSec = speakStart ? (performance.now() - speakStart) / 1000 : 0;
  speakStart = 0;
  lastLocal = { ttfw, speakSec };

  const blob = await Mic.stop();
  lastBlob = blob;
  const it = sess.items[sess.idx];

  if (silent || !blob || blob.size < 1200) {
    showFeedback({ ttfw: null, speakSec: 0 }, null, silent ? 'まず声を出すところから。次は "Well," だけでもいい。' : null);
    return;
  }
  try {
    const fb = await analyze(blob, it.prompt.en, sess.targets.map(t => t.en), it.roundNote);
    lastFb = fb;
    showFeedback({ ttfw, speakSec }, fb, null);
  } catch (e) {
    lastFb = null;
    showFeedback({ ttfw, speakSec }, null, e.nokey
      ? '設定でGemini APIキーを入れると、書き起こし・添削・お手本が出ます。'
      : '添削の取得に失敗: ' + e.message);
  }
}

/* ════════ フィードバック表示 ════════ */
function showFeedback(local, fb, note) {
  const it = sess.items[sess.idx];
  const words = fb ? fb.wordCount : null;
  const wpm = (words && local.speakSec > 2) ? Math.round(words / (local.speakSec / 60)) : null;

  sess.results.push({
    ttfw: local.ttfw, speakSec: Math.round(local.speakSec * 10) / 10,
    words, fillers: fb ? fb.fillerCount : null, wpm,
  });

  // 狙いのチャンクを実際に使えたか
  if (fb && Array.isArray(fb.usedTargets)) {
    sess.credited = sess.credited || new Set();
    fb.usedTargets.forEach(t => {
      const k = String(t).toLowerCase();
      if (sess.credited.has(k)) return;      // 同じセッション内では1回だけ数える
      const c = S.chunks.find(c => c.en.toLowerCase() === k);
      if (c) { c.used = (c.used || 0) + 1; sess.credited.add(k); }
    });
  }
  // 拾ったチャンクを追加
  let added = 0;
  if (fb && Array.isArray(fb.chunks)) {
    fb.chunks.forEach(c => {
      if (!c || !c.en) return;
      if (S.chunks.some(x => x.en.toLowerCase() === c.en.toLowerCase())) return;
      S.chunks.push({ en: c.en, ja: c.ja || '', use: c.use || '', addedAt: Date.now(), seen: 0, used: 0 });
      added++;
    });
  }
  save();

  const set = (id, v, cls) => {
    const el = $(id);
    el.querySelector('.v').textContent = v;
    el.className = 'score' + (cls ? ' ' + cls : '');
  };
  set('scTtfw', local.ttfw == null ? '–' : local.ttfw.toFixed(1),
    local.ttfw == null ? '' : local.ttfw <= 3 ? 'good' : 'warn');
  set('scWords', words == null ? '–' : words);
  set('scWpm', wpm == null ? '–' : wpm, wpm == null ? '' : wpm >= 90 ? 'good' : '');
  set('scFill', fb ? fb.fillerCount : '–', fb && fb.fillerCount > 6 ? 'warn' : '');

  $('fbTitle').textContent = sess.mode === 'retell' ? `${it.round}回目の結果` : '結果';
  $('fbCount').textContent = it.label;

  let h = '';
  if (note) h += `<div class="card"><div class="muted">${esc(note)}</div></div>`;

  if (fb) {
    if (fb.praise) h += `<div class="card" style="border-color:#2a4a38"><div style="font-size:15px">👍 ${esc(fb.praise)}</div></div>`;

    h += `<div class="card">
      <div class="sect">お手本（同じ内容を自然に）</div>
      <div class="natural">${esc(fb.natural)}</div>
      <button class="playbtn" data-say="${esc(fb.natural)}">🔊 聞く</button>
    </div>`;

    if (fb.fixes && fb.fixes.length) {
      h += `<div class="card"><div class="sect">直すならここだけ</div>` +
        fb.fixes.map(f => `<div class="fix">
            <div class="b">${esc(f.before)}</div>
            <div class="a">${esc(f.after)}</div>
            <div class="w">${esc(f.why)}</div>
          </div>`).join('') + `</div>`;
    }

    if (fb.chunks && fb.chunks.length) {
      h += `<div class="card"><div class="sect">次に使うチャンク${added ? `（${added}個をマイチャンクに追加）` : ''}</div>` +
        fb.chunks.map(c => `<div class="chunk">
            <span class="en">${esc(c.en)}</span>
            <span class="ja">${esc(c.ja)}<br><span class="muted2">${esc(c.use)}</span></span>
          </div>`).join('') + `</div>`;
    }

    if (fb.transcript) {
      const tx = esc(fb.transcript).replace(/\b(uh+|um+|er+|erm|ah+|hmm+)\b/gi, '<span class="fl">$1</span>');
      h += `<div class="card"><details><summary>自分が言ったこと</summary>
        <div class="tx" style="margin-top:8px">${tx}</div></details></div>`;
    }
  } else {
    h += `<div class="card"><div class="sect">お題</div><div class="natural">${esc(it.prompt.en)}</div>
      <div class="muted" style="margin-top:6px">${esc(it.prompt.ja)}</div></div>`;
    if (lastBlob && S.settings.apiKey.trim()) {
      h += `<div class="card"><button class="ghost" id="btnRetry">添削をもう一度取得</button></div>`;
    }
  }

  $('fbBody').innerHTML = h;
  $('btnNext').textContent = (sess.idx >= sess.items.length - 1) ? 'セッションを終える' : '次へ';
  show('fb');

  if (fb && S.settings.autoModel) setTimeout(() => speak(fb.natural, 0.95), 300);
}

/* ════════ セッション終了 ════════ */
function endSession() {
  const rs = sess.results.filter(r => r.ttfw != null);
  const rec = {
    date: today(), at: Date.now(), mode: sess.mode,
    items: sess.results,
    ttfw: rs.length ? +(rs.reduce((a, r) => a + r.ttfw, 0) / rs.length).toFixed(2) : null,
    wpm: (() => { const w = sess.results.filter(r => r.wpm); return w.length ? Math.round(w.reduce((a, r) => a + r.wpm, 0) / w.length) : null; })(),
  };
  S.sessions.push(rec);
  save();

  $('dTtfw').textContent = rec.ttfw == null ? '–' : rec.ttfw.toFixed(1);
  $('dWpm').textContent = rec.wpm == null ? '–' : rec.wpm;
  $('dStreak').textContent = streak();
  $('doneSub').textContent = sess.mode === 'retell'
    ? '同じ話を3回。これが一番効きます。' : `${sess.results.length}問おつかれさま`;

  const news = S.chunks.slice(-6).filter(c => Date.now() - c.addedAt < 3600e3);
  if (news.length) {
    $('doneChunks').style.display = '';
    $('doneChunkList').innerHTML = news.map(c =>
      `<div class="chunk"><span class="en">${esc(c.en)}</span><span class="ja">${esc(c.ja)}</span></div>`).join('');
  } else $('doneChunks').style.display = 'none';

  sess = null;
  Mic.closeCtx();
  refreshHome();
  show('done');
}

/* ════════ ホーム・記録 ════════ */
function streak() {
  const days = [...new Set(S.sessions.map(s => s.date))].sort().reverse();
  if (!days.length) return 0;
  let n = 0;
  const d = new Date();
  // 今日やっていなければ昨日から数える
  if (days[0] !== today()) d.setDate(d.getDate() - 1);
  for (;;) {
    const k = d.toLocaleDateString('sv-SE');
    if (days.includes(k)) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}
function avgOf(field, n = 5) {
  const v = S.sessions.filter(s => s[field] != null).slice(-n).map(s => s[field]);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function refreshHome() {
  $('hStreak').textContent = streak();
  const t = avgOf('ttfw'), w = avgOf('wpm');
  $('hTtfw').textContent = t == null ? '–' : t.toFixed(1);
  $('hWpm').textContent = w == null ? '–' : Math.round(w);
  const n = S.chunks.filter(c => (c.used || 0) < 3).length;
  $('homeNote').textContent = S.settings.apiKey.trim()
    ? (n ? `マイチャンク ${n}個が出番待ち` : '')
    : '⚠ 設定でAPIキーを入れると添削が出ます';
}

function lineChart(vals, opts) {
  const W = Math.max(300, vals.length * 26), H = 120, P = 26;
  if (!vals.length) return '<div class="muted2">まだデータがありません</div>';
  const min = Math.min(...vals), max = Math.max(...vals);
  const lo = opts.lowerBetter ? Math.min(min, 0) : Math.max(0, min - (max - min) * .3);
  const hi = max + (max - lo) * .15 || 1;
  const x = i => P + (vals.length === 1 ? (W - 2 * P) / 2 : i * (W - 2 * P) / (vals.length - 1));
  const y = v => H - P - (v - lo) / (hi - lo || 1) * (H - 2 * P);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${opts.color}"/>`).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <polyline points="${pts}" fill="none" stroke="${opts.color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    <text x="4" y="13" fill="#66748a" font-size="10">最高 ${opts.fmt(max)}</text>
    <text x="4" y="${H - 5}" fill="#66748a" font-size="10">最低 ${opts.fmt(min)}</text>
  </svg>`;
}

function renderStats() {
  const last = S.sessions.slice(-14);
  $('chartTtfw').innerHTML = lineChart(last.filter(s => s.ttfw != null).map(s => s.ttfw),
    { color: '#4dd08a', lowerBetter: true, fmt: v => v.toFixed(1) + 's' });
  $('chartWpm').innerHTML = lineChart(last.filter(s => s.wpm != null).map(s => s.wpm),
    { color: '#3ba0ff', lowerBetter: false, fmt: v => v + 'wpm' });

  const cs = S.chunks.slice().sort((a, b) => (a.used || 0) - (b.used || 0) || b.addedAt - a.addedAt);
  $('chunkCount').textContent = `(${S.chunks.length})`;
  $('chunkList').innerHTML = cs.length ? cs.map(c => `<div class="chunk">
      <span class="en">${esc(c.en)}</span>
      <span class="ja">${esc(c.ja)} <span class="muted2">${(c.used || 0) >= 3 ? '✓習得' : `使用${c.used || 0}/3`}</span></span>
    </div>`).join('') : '<div class="muted2">ドリルをやると自動で溜まります</div>';
}

/* ════════ 設定 ════════ */
function renderSettings() {
  $('inKey').value = S.settings.apiKey;
  $('inModel').value = S.settings.model;
  $('inAnswerSec').value = String(S.settings.answerSec);
  $('tgSpeak').classList.toggle('on', !!S.settings.speakPrompt);
  $('tgAutoModel').classList.toggle('on', !!S.settings.autoModel);
  $('tgJa').classList.toggle('on', !!S.settings.showJa);
}

/* ════════ イベント配線 ════════ */
$$('.mode').forEach(b => b.addEventListener('click', () => {
  $$('.mode').forEach(x => x.classList.toggle('sel', x === b));
  S.settings.mode = b.dataset.mode; save();
}));
$('catChips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  const c = b.dataset.cat;
  const cats = new Set(S.settings.cats);
  cats.has(c) ? cats.delete(c) : cats.add(c);
  if (!cats.size) cats.add(c);           // 全部オフは許さない
  S.settings.cats = [...cats]; save();
  $$('#catChips .chip').forEach(x => x.classList.toggle('on', S.settings.cats.includes(x.dataset.cat)));
});

$('btnStart').addEventListener('click', () => {
  warmTTS(); Mic.ensureCtx();
  buildSession(S.settings.mode);
  sess.opener = OPENERS[Math.floor(Math.random() * OPENERS.length)].en;
  renderItem();
  show('drill');
});

$('btnDrill').addEventListener('click', () => {
  Mic.ensureCtx();
  if (phase === 'ready') beginItem();
  else if (phase === 'wait' || phase === 'answer') finishItem(phase === 'wait');
});

$('btnQuit').addEventListener('click', async () => {
  clearInterval(clockT);
  if (Mic.stream) await Mic.stop();
  Mic.closeCtx();
  speechSynthesis.cancel();
  sess = null; show('home');
});

$('btnNext').addEventListener('click', () => {
  speechSynthesis.cancel();
  if (sess.idx >= sess.items.length - 1) return endSession();
  sess.idx++;
  renderItem();
  show('drill');
});

$('fbBody').addEventListener('click', async e => {
  const say = e.target.closest('[data-say]');
  if (say) return void speak(say.dataset.say, 0.92);
  if (e.target.id === 'btnRetry') {
    const it = sess.items[sess.idx];
    e.target.innerHTML = '<span class="spin"></span> 取得中…';
    try {
      const fb = await analyze(lastBlob, it.prompt.en, sess.targets.map(t => t.en), it.roundNote);
      sess.results.pop();
      showFeedback(lastLocal, fb, null);
    } catch (err) { toast('失敗: ' + err.message); e.target.textContent = '添削をもう一度取得'; }
  }
});

$('btnHome').addEventListener('click', () => show('home'));
$('btnStats').addEventListener('click', () => { backTo = 'home'; renderStats(); show('stats'); });
$('btnSettings').addEventListener('click', () => { backTo = 'home'; renderSettings(); show('settings'); });
$$('[data-back]').forEach(b => b.addEventListener('click', () => show(backTo)));

$('inKey').addEventListener('change', e => { S.settings.apiKey = e.target.value.trim(); save(); refreshHome(); });
$('inModel').addEventListener('change', e => { S.settings.model = e.target.value; save(); });
$('inAnswerSec').addEventListener('change', e => { S.settings.answerSec = Number(e.target.value); save(); });
const tg = (id, key) => $(id).addEventListener('click', () => {
  S.settings[key] = !S.settings[key]; $(id).classList.toggle('on', S.settings[key]); save();
});
tg('tgSpeak', 'speakPrompt'); tg('tgAutoModel', 'autoModel'); tg('tgJa', 'showJa');

$('btnTestKey').addEventListener('click', async () => {
  const k = $('inKey').value.trim();
  S.settings.apiKey = k; save();
  const m = $('keyMsg');
  if (!k) { m.textContent = 'キーが空です'; return; }
  m.innerHTML = '<span class="spin"></span> 確認中…';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${S.settings.model}:generateContent?key=${encodeURIComponent(k)}`, {
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
  a.href = URL.createObjectURL(blob);
  a.download = `karutalk-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('btnReset').addEventListener('click', () => {
  if (!confirm('記録とマイチャンクをすべて消します。よろしいですか？')) return;
  const key = S.settings.apiKey;
  S = JSON.parse(JSON.stringify(DEFAULTS));
  S.settings.apiKey = key;
  save(); renderStats(); refreshHome(); toast('消去しました');
});

/* ════════ 起動 ════════ */
$$('#catChips .chip').forEach(x => x.classList.toggle('on', S.settings.cats.includes(x.dataset.cat)));
$$('.mode').forEach(x => x.classList.toggle('sel', x.dataset.mode === S.settings.mode));
refreshHome();
