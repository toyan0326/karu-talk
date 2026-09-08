/* 出題者のアバター。写真を実時間で変形させて喋らせる。
 *
 * 画像生成は使わない（連番フレームを作ると、生成のたびに顔がわずかに動いてジッターになる）。
 * 1枚の写真の口元だけをcanvasで開閉させ、あごを下げ、まばたきさせる。
 *   ・口の中: 唇の合わせ目に暗い楕円を描き、開き量に応じて縦に伸ばす
 *   ・あご  : 口から下を薄いスライスに分け、下へ行くほど小さくずらす（継ぎ目を出さない）
 *   ・まばたき: まぶたの上の肌をコピーして目の上に伸ばし下ろす
 *   ・常時  : 呼吸と首のわずかな揺れ。ここが止まると一気に人形に見える
 *
 * 口の同期: ブラウザのTTSは音素の時刻をくれないので、テキストを音節っぽく割って
 * 母音から開き具合を決め、発話の推定尺いっぱいに引き伸ばす。完全同期ではないが
 * 「口が動かない」「音が終わったのに動き続ける」という不自然さは消える。
 */
'use strict';

/* 写真の実測値（emi.jpg 360x418 座標系） */
const FACE = {
  src: 'emi.jpg?v=1', w: 360, h: 418,
  // 唇の合わせ目。笑っているので直線ではなく曲線。左右の口角と中央の3点で表す。
  // 楕円で開けると口の形とずれて「貼り付けた口」に見えたので、実際のカーブに沿わせる。
  lip: { L: { x: 147, y: 250 }, R: { x: 216, y: 227 }, C: { x: 181, y: 236 } },
  // 目も唇と同じで、輪郭のカーブを実測して持つ。矩形で処理すると継ぎ目が出る。
  //   a,b = 目頭と目尻 / top = 上まぶたの弧の制御点 / bot = 下まぶたの弧の制御点
  eyes: [
    { a: { x: 101, y: 178 }, b: { x: 138, y: 171 }, top: { x: 118, y: 157.5 }, bot: { x: 116, y: 193.5 } },
    { a: { x: 189, y: 160 }, b: { x: 223, y: 152 }, top: { x: 206, y: 136 }, bot: { x: 204, y: 178 } },
  ],
};

// 口の開き具合。[縦の開き, 横の広がり]（0〜1）
const VISEME = {
  rest: [0.00, 0.00], MBP: [0.00, 0.00], FV: [0.14, 0.10], S: [0.16, 0.30],
  AA: [1.00, 0.10], E: [0.48, 0.55], I: [0.32, 0.45], O: [0.72, -0.30],
  U: [0.46, -0.45], L: [0.55, 0.05],
};

const Avatar = {
  host: null, cv: null, ctx: null, img: null, ready: false, raf: 0, t0: 0,
  patches: null,          // 生成フレーム（face/frames.json）があればこちらを使う
  blinkAt: 0, blink: 0,
  target: 'rest', open: 0, wide: 0,
  speaking: false, seq: null, seqI: -1, seqStart: 0, seqStep: 0,

  loadImg(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej; im.src = src;
    });
  },

  /* face/frames.json があれば、目と口の「途中の形」を生成済みパッチとして読む。
     パッチは元画像とピクセル単位で揃えて作ってあるので、貼るだけでズレない。
     無ければ口だけワープで動かす（目のワープは継ぎ目が出るのでやらない）。 */
  async load() {
    if (this.ready) return this.img;
    this.img = await this.loadImg(FACE.src);
    try {
      const man = await (await fetch('face/frames.json', { cache: 'no-cache' })).json();
      const load = async (list) => Promise.all((list || []).map(f =>
        this.loadImg('face/' + f.file).then(im => ({ im, x: f.x, y: f.y }))));
      this.patches = { eyes: await load(man.eyes), mouth: {} };
      for (const k of Object.keys(man.mouth || {})) this.patches.mouth[k] = await load(man.mouth[k]);
      if (!this.patches.eyes.length) this.patches.eyes = null;
    } catch { this.patches = null; }
    this.ready = true;
    return this.img;
  },

  mountIn(container) {
    if (!container) return this.unmount();
    if (this.host === container && this.cv && this.cv.parentNode === container) { this.start(); return; }
    this.unmount();
    this.host = container;
    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = container.getBoundingClientRect();
    const w = Math.max(48, r.width || 100), h = Math.max(56, r.height || 116);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = '100%'; cv.style.height = '100%';
    cv.style.display = 'block'; cv.style.borderRadius = '14px';
    container.innerHTML = ''; container.appendChild(cv);
    this.cv = cv; this.ctx = cv.getContext('2d');
    this.t0 = performance.now();
    this.blinkAt = this.t0 + 1200 + Math.random() * 2500;
    this.load().then(() => this.start()).catch(() => {});
  },

  unmount() {
    this.stop();
    if (this.host) this.host.innerHTML = '';
    this.host = null; this.cv = null; this.ctx = null;
  },

  start() {
    if (this.raf || !this.ctx) return;
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    loop();
  },
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; },

  frame() {
    const ctx = this.ctx, cv = this.cv;
    if (!ctx || !this.ready) return;
    const now = performance.now(), t = (now - this.t0) / 1000;

    // 目標の口の形へなめらかに寄せる（瞬間で切り替えるとパクパクして安っぽい）
    const [to, tw] = VISEME[this.target] || VISEME.rest;
    this.open += (to - this.open) * 0.34;
    this.wide += (tw - this.wide) * 0.28;
    if (this.speaking && this.seq) this.stepSeq(now);

    // まばたき
    if (now > this.blinkAt) {
      const p = (now - this.blinkAt) / 135;
      if (p >= 1) { this.blink = 0; this.blinkAt = now + 2400 + Math.random() * 3800; }
      else this.blink = (1 - Math.abs(p - 0.5) * 2) * 0.92;   // 閉じきる直前で止める
    }

    // 画面いっぱいに、はみ出さないよう収める
    const scale = Math.min(cv.width / FACE.w, cv.height / FACE.h);
    const ox = (cv.width - FACE.w * scale) / 2, oy = (cv.height - FACE.h * scale) / 2;

    ctx.save();
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.translate(ox, oy); ctx.scale(scale, scale);

    // 呼吸と首の揺れ
    const sway = Math.sin(t * 0.55) * 2.2, bob = Math.sin(t * 0.83) * 1.5;
    ctx.translate(FACE.w / 2 + sway, FACE.h / 2 + bob);
    ctx.rotate(Math.sin(t * 0.55) * 0.006);
    ctx.translate(-FACE.w / 2, -FACE.h / 2);

    ctx.drawImage(this.img, 0, 0);
    this.drawMouth(ctx);
    this.drawBlink(ctx);
    ctx.restore();
  },

  drawMouth(ctx) {
    const open = Math.max(0, this.open);
    // 生成パッチがあれば、開き具合に一番近いフレームを貼る
    const set = this.patches && this.patches.mouth && this.patches.mouth[this.target];
    if (set && set.length) {
      const i = Math.min(set.length - 1, Math.round(open * (set.length - 1)));
      const p = set[i];
      if (p) { ctx.drawImage(p.im, p.x, p.y); return; }
    }
    if (open <= 0.02) return;
    const P = FACE.lip;
    const drop = open * 15;                       // 下唇が下がる量
    const spread = this.wide * 4;                 // E は横に広く、O/U は狭く
    const lx = P.L.x - spread, rx = P.R.x + spread;
    const ly = P.L.y + spread * 0.1, ry = P.R.y - spread * 0.1;

    ctx.save();
    ctx.filter = 'blur(0.7px)';                   // 縁を写真になじませる
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.quadraticCurveTo(P.C.x, P.C.y, rx, ry);   // 上唇側（動かない）
    ctx.quadraticCurveTo(P.C.x, P.C.y + drop * 1.45, lx, ly);  // 下唇側（下がる）
    ctx.closePath();
    ctx.fillStyle = '#3d171a';
    ctx.fill();

    if (open > 0.45) {                            // 上の歯を少しだけ
      const th = Math.min(3.6, drop * 0.26);
      ctx.beginPath();
      ctx.moveTo(lx + 8, ly - 0.5);
      ctx.quadraticCurveTo(P.C.x, P.C.y - 0.5, rx - 8, ry - 0.5);
      ctx.quadraticCurveTo(P.C.x, P.C.y + th, lx + 8, ly - 0.5);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,249,245,.88)';
      ctx.fill();
    }
    ctx.restore();
  },

  /* まばたき。
     最初は目の上の肌を矩形でコピーして伸ばしたが、四角い継ぎ目が丸見えで破綻した。
     まぶたの縁のカーブでクリップすれば、境目が「まぶたの縁があるべき場所」に来るので
     見えても不自然にならない。口を唇のカーブに沿わせたのと同じ考え方。
     生成した中割りパッチ(face/frames.json)があればそちらを優先する。 */
  drawBlink(ctx) {
    const set = this.patches && this.patches.eyes;
    if (set && set.length) {
      const i = Math.min(set.length - 1, Math.round(this.blink * (set.length - 1)));
      const p = set[i];
      if (p) ctx.drawImage(p.im, p.x, p.y);
      return;
    }
    const k = this.blink;
    if (k < 0.02) return;
    for (const e of FACE.eyes) {
      // いまのまぶたの縁: 上まぶたの弧 → 下まぶたの弧 へ k で降りていく
      const cx = e.top.x + (e.bot.x - e.top.x) * k;
      const cy = e.top.y + (e.bot.y - e.top.y) * k;
      const lidTop = Math.min(e.a.y, e.b.y) - 17;      // まぶたの肌（眉には届かない）
      const x0 = Math.min(e.a.x, e.b.x) - 6, x1 = Math.max(e.a.x, e.b.x) + 6;

      ctx.save();
      ctx.beginPath();                                   // 覆う範囲＝上の肌から現在の縁まで
      ctx.moveTo(e.a.x - 2, e.a.y);
      ctx.lineTo(x0, lidTop); ctx.lineTo(x1, lidTop);
      ctx.lineTo(e.b.x + 2, e.b.y);
      ctx.quadraticCurveTo(cx, cy, e.a.x - 2, e.a.y);
      ctx.closePath();
      ctx.clip();
      // まぶたの肌を、現在の縁まで縦に引き伸ばす
      const srcH = Math.max(4, e.a.y - lidTop);
      const dstH = Math.max(srcH, cy - lidTop);
      ctx.drawImage(this.img, x0, lidTop, x1 - x0, srcH, x0, lidTop, x1 - x0, dstH);
      ctx.restore();

      // まつ毛の線。境目をここに置くと、縁として自然に見える。
      ctx.save();
      ctx.filter = 'blur(0.9px)';
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.quadraticCurveTo(cx, cy, e.b.x, e.b.y);
      // 濃く太くすると「描き足した線」に見える。うっすら影として置く程度に留める。
      ctx.strokeStyle = `rgba(64,42,34,${(0.28 + 0.30 * k).toFixed(2)})`;
      ctx.lineWidth = 1.0 + k * 0.7;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
    }
  },

  /* テキスト → 口の形の並び。英語の口の見た目はほぼ母音で決まる。 */
  toVisemes(text) {
    const out = [];
    for (const w of String(text).toLowerCase().match(/[a-z']+/g) || []) {
      const chunks = w.match(/[^aeiou]*[aeiou]+[^aeiou]*?(?=[^aeiou][aeiou]|$)/g) || [w];
      for (const c of chunks) {
        if (/^[mbp]/.test(c)) out.push('MBP');
        else if (/^[fv]/.test(c)) out.push('FV');
        else if (/^[szc]/.test(c)) out.push('S');
        else if (/^l/.test(c)) out.push('L');
        const v = (c.match(/[aeiou]+/) || [''])[0];
        if (/^a/.test(v)) out.push('AA');
        else if (/^e/.test(v)) out.push('E');
        else if (/^[iy]/.test(v)) out.push('I');
        else if (/^o/.test(v)) out.push('O');
        else if (/^u/.test(v)) out.push('U');
        else out.push('rest');
      }
      out.push('rest');                        // 語間で一度閉じる
    }
    return out.length ? out : ['rest'];
  },

  stepSeq(now) {
    const i = Math.floor((now - this.seqStart) / this.seqStep);
    if (i >= this.seq.length) { this.target = 'rest'; return; }
    if (i !== this.seqI) { this.seqI = i; this.target = this.seq[i]; }
  },

  // 英語のTTSはおおむね毎秒14文字前後。口の並びをこの推定尺いっぱいに引き伸ばす。
  estimateMs(text, rate) { return Math.max(600, (String(text).length / 14) * 1000 / (rate || 1)); },

  // speakFn は app.js の speak() を渡す。TTSの実装はアバター側に持たせない。
  async say(text, rate, speakFn) {
    this.seq = this.toVisemes(text);
    // 固定の刻みだと音声が終わっても口だけ途中で残る。推定尺から逆算する。
    this.seqStep = Math.max(55, this.estimateMs(text, rate) / this.seq.length);
    this.seqStart = performance.now(); this.seqI = -1;
    this.speaking = true;
    try { await speakFn(text, rate); }
    finally { this.speaking = false; this.seq = null; this.target = 'rest'; }
  },
};
