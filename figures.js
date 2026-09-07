/* 図の自動生成。
 *
 * 肝は「生成した側が正解を知っている」こと。位置関係の判定をLLMの目に頼らず、
 * こちらが持っている truth と突き合わせる。画像をAPIに送るのはユーザー自身の
 * スクショのときだけで、自動生成図では一切送らない（速くて確実で安い）。
 *
 * 各ジェネレータは「素の図」＋「その図に含まれる要素の一覧」を返す。そこから
 *   genFigure(relation)    … 話す用。要素を1つ赤くして「どこ？」と聞く
 *   genListening(relation) … 聞く用。要素を4つ番号で示し、1つを読み上げて当てさせる
 * を組み立てる。同じ図・同じ正解データを両方向に使えるのが利点で、
 * 聞き取りの判定はタップした瞬間にローカルで決まる（通信もAPIも要らない）。
 */
'use strict';

const RELATIONS = ['between', 'nth-from', 'below', 'above', 'same-level', 'left-right', 'inside', 'adjacent'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const ordinal = (n) => ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] || `${n}th`;
function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

const SVG_HEAD = 'xmlns="http://www.w3.org/2000/svg" font-family="system-ui,-apple-system,sans-serif"';
const INK = '#dfe6f0', THIN = '#5b6a80', DIM = '#8b9bb4', HOT = '#ff5f56', PICK = '#3ba0ff';

// 聞き取り問題で「1234」を図の上に置く
const marker = (n, x, y) =>
  `<circle cx="${x}" cy="${y}" r="17" fill="${PICK}" opacity=".92"/>` +
  `<text x="${x}" y="${y + 6}" fill="#06210f" font-size="17" font-weight="800" text-anchor="middle">${n}</text>`;

/* ══════════════ ① 伏図 ══════════════ */
function genPlan() {
  const cols = ['X', 'Y', 'Z', 'W'].slice(0, ri(3, 4));
  const rows = ['1', '2', '3'].slice(0, ri(2, 3));
  const W = 620, H = 420;
  const x0 = 105, y0 = 95;
  const dx = Math.min(150, (W - x0 - 70) / (cols.length - 1));
  const dy = Math.min(120, (H - y0 - 90) / (rows.length - 1));
  const X = (i) => x0 + i * dx, Y = (j) => y0 + j * dy;
  const voidI = ri(0, cols.length - 2), voidJ = ri(0, rows.length - 2);

  let s = '';
  for (let i = 0; i < cols.length; i++)
    s += `<line x1="${X(i)}" y1="52" x2="${X(i)}" y2="${Y(rows.length - 1) + 46}" stroke="${THIN}" stroke-width="1" stroke-dasharray="10 4 2 4"/>`;
  for (let j = 0; j < rows.length; j++)
    s += `<line x1="58" y1="${Y(j)}" x2="${X(cols.length - 1) + 46}" y2="${Y(j)}" stroke="${THIN}" stroke-width="1" stroke-dasharray="10 4 2 4"/>`;
  cols.forEach((c, i) => {
    s += `<circle cx="${X(i)}" cy="40" r="14" fill="none" stroke="${DIM}" stroke-width="1.2"/>`
      + `<text x="${X(i)}" y="45" fill="${DIM}" font-size="13" font-weight="700" text-anchor="middle">${c}</text>`;
  });
  rows.forEach((r, j) => {
    s += `<circle cx="44" cy="${Y(j)}" r="14" fill="none" stroke="${DIM}" stroke-width="1.2"/>`
      + `<text x="44" y="${Y(j) + 5}" fill="${DIM}" font-size="13" font-weight="700" text-anchor="middle">${r}</text>`;
  });

  const vx1 = X(voidI) + 26, vy1 = Y(voidJ) + 22, vx2 = X(voidI + 1) - 26, vy2 = Y(voidJ + 1) - 22;
  s += `<rect x="${vx1}" y="${vy1}" width="${vx2 - vx1}" height="${vy2 - vy1}" fill="none" stroke="${THIN}" stroke-width="1.3" stroke-dasharray="6 3"/>`
    + `<line x1="${vx1}" y1="${vy2}" x2="${vx2}" y2="${vy1}" stroke="${THIN}" stroke-width="1.1"/>`
    + `<text x="${(vx1 + vx2) / 2}" y="${(vy1 + vy2) / 2 + 4}" fill="${THIN}" font-size="11" text-anchor="middle">VOID</text>`;

  const beams = [];
  for (let j = 0; j < rows.length; j++)
    for (let i = 0; i < cols.length - 1; i++)
      beams.push({ dir: 'h', i, j, x1: X(i), y1: Y(j), x2: X(i + 1), y2: Y(j) });
  for (let i = 0; i < cols.length; i++)
    for (let j = 0; j < rows.length - 1; j++)
      beams.push({ dir: 'v', i, j, x1: X(i), y1: Y(j), x2: X(i), y2: Y(j + 1) });
  beams.forEach(b => {
    s += `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke="${INK}" stroke-width="7" stroke-linecap="square"/>`;
  });

  // 小梁は吹抜けの隣のベイに置く（adjacent の出題で隣接関係が本当に成り立つように）
  const nbrs = [[voidI + 1, voidJ], [voidI - 1, voidJ], [voidI, voidJ + 1], [voidI, voidJ - 1]]
    .filter(([i, j]) => i >= 0 && j >= 0 && i <= cols.length - 2 && j <= rows.length - 2);
  const [sbI, sbJ] = nbrs.length ? pick(nbrs) : [voidI, voidJ];
  const sb = {
    i: sbI, j: sbJ, x: (X(sbI) + X(sbI + 1)) / 2, y1: Y(sbJ), y2: Y(sbJ + 1),
    side: sbI > voidI ? 'to the right of' : sbI < voidI ? 'to the left of' : sbJ > voidJ ? 'just below' : 'just above',
  };
  s += `<line x1="${sb.x}" y1="${sb.y1}" x2="${sb.x}" y2="${sb.y2}" stroke="${DIM}" stroke-width="4" stroke-linecap="square"/>`;

  for (let i = 0; i < cols.length; i++)
    for (let j = 0; j < rows.length; j++)
      s += `<rect x="${X(i) - 15}" y="${Y(j) - 15}" width="30" height="30" fill="${INK}"/>`;

  const floor = pick(['2nd', '3rd', '4th']);
  s += `<text x="30" y="${H - 22}" fill="${DIM}" font-size="12">${floor.toUpperCase()} FLOOR FRAMING PLAN</text>`;

  /* ── この図に含まれる要素 ── */
  const el = [];
  const lineOverlay = (b, w = 9) =>
    `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke="${HOT}" stroke-width="${w}" stroke-linecap="square"/>`;

  beams.filter(b => b.dir === 'h').forEach(b => {
    const edge = (b.i === 0) ? 'left-most' : (b.i === cols.length - 2) ? 'right-most' : null;
    const bset = `beam-h-${b.i}-${b.j}`;
    el.push({
      group: 'beam', set: bset, rel: 'between',
      label: `the main beam on grid line ${rows[b.j]}, between grids ${cols[b.i]} and ${cols[b.i + 1]}`,
      question: 'Where is the beam highlighted in red?',
      overlay: lineOverlay(b), mx: (b.x1 + b.x2) / 2, my: b.y1,
    });
    if (edge) el.push({
      group: 'beam', set: bset, rel: 'left-right',
      label: `the main beam on grid line ${rows[b.j]}, in the ${edge} bay, between grids ${cols[b.i]} and ${cols[b.i + 1]}`,
      question: 'Where is the beam highlighted in red?',
      overlay: lineOverlay(b), mx: (b.x1 + b.x2) / 2, my: b.y1,
    });
  });
  for (let i = 0; i < cols.length; i++) for (let j = 0; j < rows.length; j++) {
    el.push({
      group: 'column', set: `col-${i}-${j}`, rel: 'nth-from',
      label: `the ${ordinal(i + 1)} column from the left, on grid line ${rows[j]} (grid ${cols[i]}-${rows[j]})`,
      question: 'Where is the column highlighted in red?',
      overlay: `<rect x="${X(i) - 18}" y="${Y(j) - 18}" width="36" height="36" fill="none" stroke="${HOT}" stroke-width="4"/>`,
      mx: X(i), my: Y(j),
    });
  }
  el.push({
    group: 'area', set: 'void', rel: 'inside',
    label: `the void (opening) inside the bay between grids ${cols[voidI]} and ${cols[voidI + 1]}, between grid lines ${rows[voidJ]} and ${rows[voidJ + 1]}`,
    question: 'Where is the area highlighted in red?',
    overlay: `<rect x="${vx1 - 4}" y="${vy1 - 4}" width="${vx2 - vx1 + 8}" height="${vy2 - vy1 + 8}" fill="none" stroke="${HOT}" stroke-width="4"/>`,
    mx: (vx1 + vx2) / 2, my: (vy1 + vy2) / 2,
  });
  el.push({
    group: 'beam', set: 'sec-beam', rel: 'adjacent',
    label: `the secondary beam running vertically at mid-span of the bay ${sb.side} the void — the bay between grids ${cols[sb.i]} and ${cols[sb.i + 1]}, between grid lines ${rows[sb.j]} and ${rows[sb.j + 1]}`,
    question: 'Where is the beam highlighted in red?',
    overlay: `<line x1="${sb.x}" y1="${sb.y1}" x2="${sb.x}" y2="${sb.y2}" stroke="${HOT}" stroke-width="6" stroke-linecap="square"/>`,
    mx: sb.x, my: (sb.y1 + sb.y2) / 2,
  });

  return {
    kind: 'plan', W, H, base: s, elements: el,
    context: `A ${floor} floor framing plan. Vertical grids are labelled ${cols.join(', ')} from left to right; horizontal grid lines are ${rows.join(', ')} from top to bottom. There is a void in the bay between grids ${cols[voidI]} and ${cols[voidI + 1]}.`,
  };
}

/* ══════════════ ② 断面・配筋図 ══════════════ */
function genSection() {
  const W = 620, H = 420;
  const bw = 210, bh = 300, bx = (W - bw) / 2 - 40, by = 60;
  const cover = 26;
  const topN = ri(3, 4), botRows = ri(1, 2), botN = ri(3, 4);
  const stirrupPitch = pick([150, 200, 250]);

  let s = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${INK}" stroke-width="3"/>`
    + `<rect x="${bx + cover}" y="${by + cover}" width="${bw - 2 * cover}" height="${bh - 2 * cover}" rx="10" fill="none" stroke="${DIM}" stroke-width="2.5"/>`;

  const barR = 9;
  const topY = by + cover + barR + 2;
  const botY1 = by + bh - cover - barR - 2;
  const botY2 = botY1 - (barR * 2 + 7);
  const spread = (n, y) => {
    const x1 = bx + cover + barR + 3, x2 = bx + bw - cover - barR - 3;
    return Array.from({ length: n }, (_, k) => ({ x: n === 1 ? (x1 + x2) / 2 : x1 + k * (x2 - x1) / (n - 1), y }));
  };
  const topBars = spread(topN, topY);
  const bot1 = spread(botN, botY1);
  // 2段目は1段目の内側の鉄筋の真上に載る（外側の隅筋の上には置かない）
  const bot2 = botRows === 2 ? bot1.slice(1, -1).map(p => ({ x: p.x, y: botY2 })) : [];
  const drawBars = (arr) => arr.map(p => `<circle cx="${p.x}" cy="${p.y}" r="${barR}" fill="${INK}"/>`).join('');
  s += drawBars(topBars) + drawBars(bot1) + drawBars(bot2);

  s += `<line x1="${bx}" y1="${by + bh + 22}" x2="${bx + cover}" y2="${by + bh + 22}" stroke="${DIM}" stroke-width="1"/>`
    + `<line x1="${bx}" y1="${by + bh}" x2="${bx}" y2="${by + bh + 30}" stroke="${DIM}" stroke-width="1"/>`
    + `<line x1="${bx + cover}" y1="${by + bh}" x2="${bx + cover}" y2="${by + bh + 30}" stroke="${DIM}" stroke-width="1"/>`
    + `<text x="${bx + cover + 8}" y="${by + bh + 26}" fill="${DIM}" font-size="11">cover 40</text>`
    + `<text x="${bx + bw + 24}" y="${by + 20}" fill="${DIM}" font-size="12">STIRRUPS @${stirrupPitch}</text>`
    + `<text x="30" y="${H - 22}" fill="${DIM}" font-size="12">BEAM SECTION  G1  (400 x 700)</text>`;

  const ring = (arr, r = barR + 6) => arr.map(p =>
    `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="none" stroke="${HOT}" stroke-width="3.5"/>`).join('');
  const mid = (arr) => ({ mx: arr.reduce((a, p) => a + p.x, 0) / arr.length, my: arr[0].y });

  const el = [];
  el.push(Object.assign({
    group: 'bars', set: 'topRow', rel: 'above',
    label: `the top bars, the row of bars running along the top of the section, above the bottom bars and just inside the top of the stirrup`,
    question: 'Where are the bars highlighted in red?', overlay: ring(topBars),
  }, mid(topBars)));
  el.push(Object.assign({
    group: 'bars', set: 'bot1', rel: 'below',
    label: botRows === 2
      ? `the first (outer) layer of bottom bars, the row directly below the second layer, at the very bottom of the section`
      : `the bottom bars, the single row running along the bottom of the section, directly below the top bars`,
    question: 'Where are the bars highlighted in red?', overlay: ring(bot1),
  }, mid(bot1)));
  if (bot2.length) el.push(Object.assign({
    group: 'bars', set: 'bot2', rel: 'above',
    label: `the second layer of bottom bars, the row sitting directly above the first (outer) layer at the bottom of the section`,
    question: 'Where are the bars highlighted in red?', overlay: ring(bot2),
  }, mid(bot2)));
  [['left', topBars[0]], ['right', topBars[topBars.length - 1]]].forEach(([side, one]) => {
    el.push({
      group: 'bar', set: 'topRow', rel: 'same-level',
      label: `the corner top bar on the ${side} side, at the same level as the rest of the top bars`,
      question: 'Where is the bar highlighted in red?', overlay: ring([one]), mx: one.x, my: one.y,
    });
  });
  for (let k = 1; k <= Math.min(3, botN); k++) el.push({
    group: 'bar', set: 'bot1', rel: 'nth-from',
    label: `the ${ordinal(k)} bottom bar from the left, in the outer (first) layer of bottom bars`,
    question: 'Where is the bar highlighted in red?',
    overlay: ring([bot1[k - 1]]), mx: bot1[k - 1].x, my: bot1[k - 1].y,
  });
  el.push({
    group: 'reo', set: 'stirrup', rel: 'inside',
    label: `the stirrup, the closed hoop running around the outside of the longitudinal bars, inside the concrete cover`,
    question: 'Where is the reinforcement highlighted in red?',
    overlay: `<rect x="${bx + cover - 4}" y="${by + cover - 4}" width="${bw - 2 * cover + 8}" height="${bh - 2 * cover + 8}" rx="12" fill="none" stroke="${HOT}" stroke-width="3.5"/>`,
    mx: bx + cover, my: by + bh / 2,
  });

  return {
    kind: 'section', W, H, base: s, elements: el,
    context: `A beam cross-section, 400 x 700. ${topN} top bars, ${botRows} layer(s) of bottom bars (${botN} bars in the outer layer), stirrups at ${stirrupPitch} centres, 40 mm cover.`,
  };
}

/* ══════════════ ③ グラフ・表 ══════════════ */
function genChart(forceBar) {
  const W = 620, H = 420;
  // 表は nth-from にしかならないので、left-right を求められたら棒グラフを選ぶ
  const asTable = forceBar ? false : Math.random() < 0.5;
  let s = '', context = '';
  const el = [];

  if (asTable) {
    const heads = ['Story', 'Qd (kN)', 'Qu (kN)', 'Qu/Qd'];
    const nRow = ri(4, 5);
    const rowsData = Array.from({ length: nRow }, (_, k) => [
      `${nRow - k}F`, String(ri(800, 2400)), String(ri(1200, 3200)), (0.9 + Math.random() * 1.1).toFixed(2),
    ]);
    const cw = 128, chh = 46, tx = 55, ty = 80;
    heads.forEach((h, i) => {
      s += `<rect x="${tx + i * cw}" y="${ty}" width="${cw}" height="${chh}" fill="#1c2430" stroke="${THIN}"/>`
        + `<text x="${tx + i * cw + cw / 2}" y="${ty + 29}" fill="${INK}" font-size="14" font-weight="700" text-anchor="middle">${h}</text>`;
    });
    rowsData.forEach((r, j) => r.forEach((v, i) => {
      s += `<rect x="${tx + i * cw}" y="${ty + (j + 1) * chh}" width="${cw}" height="${chh}" fill="none" stroke="${THIN}"/>`
        + `<text x="${tx + i * cw + cw / 2}" y="${ty + (j + 1) * chh + 29}" fill="${INK}" font-size="14" text-anchor="middle">${v}</text>`;
    }));
    s += `<text x="55" y="${H - 30}" fill="${DIM}" font-size="12">STORY SHEAR CHECK</text>`;
    for (let rj = 1; rj <= nRow; rj++) for (let ci = 1; ci <= 3; ci++) el.push({
      group: 'cell', set: `cell-${rj}-${ci}`, rel: 'nth-from',
      label: `the cell in the ${ordinal(rj)} data row from the top (story ${rowsData[rj - 1][0]}), in the column headed "${heads[ci]}"`,
      question: 'Which value is highlighted in red?',
      overlay: `<rect x="${tx + ci * cw + 2}" y="${ty + rj * chh + 2}" width="${cw - 4}" height="${chh - 4}" fill="none" stroke="${HOT}" stroke-width="3.5"/>`,
      mx: tx + ci * cw + cw / 2, my: ty + rj * chh + chh / 2,
    });
    context = `A table with columns ${heads.join(', ')} and ${nRow} data rows, from ${rowsData[0][0]} at the top down to ${rowsData[nRow - 1][0]}.`;
  } else {
    const n = ri(5, 7);
    const vals = Array.from({ length: n }, () => ri(20, 100));
    const bx = 80, bw = 58, gap = 16, base = 330, top = 90;
    vals.forEach((v, i) => {
      const h = (v / 100) * (base - top);
      s += `<rect x="${bx + i * (bw + gap)}" y="${base - h}" width="${bw}" height="${h}" fill="#3ba0ff" opacity=".72"/>`
        + `<text x="${bx + i * (bw + gap) + bw / 2}" y="${base + 20}" fill="${DIM}" font-size="12" text-anchor="middle">${i + 1}F</text>`;
    });
    s += `<line x1="60" y1="${base}" x2="${W - 40}" y2="${base}" stroke="${DIM}" stroke-width="1.5"/>`
      + `<line x1="60" y1="${top - 14}" x2="60" y2="${base}" stroke="${DIM}" stroke-width="1.5"/>`
      + `<text x="60" y="${top - 24}" fill="${DIM}" font-size="12">drift (mm)</text>`
      + `<text x="55" y="${H - 30}" fill="${DIM}" font-size="12">STORY DRIFT BY LEVEL</text>`;
    const maxI = vals.indexOf(Math.max(...vals));
    vals.forEach((v, k) => {
      const h = (v / 100) * (base - top);
      const ov = `<rect x="${bx + k * (bw + gap) - 3}" y="${base - h - 3}" width="${bw + 6}" height="${h + 6}" fill="none" stroke="${HOT}" stroke-width="3.5"/>`;
      const mx = bx + k * (bw + gap) + bw / 2, my = base - h / 2;
      el.push({
        group: 'bar', set: `bar-${k}`, rel: 'nth-from',
        label: k === maxI ? `the tallest bar, which is the ${ordinal(k + 1)} bar from the left (${k + 1}F)`
          : `the ${ordinal(k + 1)} bar from the left (${k + 1}F)`,
        question: 'Which bar is highlighted in red?', overlay: ov, mx, my,
      });
      if (k === 0 || k === n - 1) el.push({
        group: 'bar', set: `bar-${k}`, rel: 'left-right',
        label: `the ${k === 0 ? 'left-most' : 'right-most'} bar (${k + 1}F)${k === maxI ? ', which is also the tallest bar' : ''}`,
        question: 'Which bar is highlighted in red?', overlay: ov, mx, my,
      });
    });
    context = `A bar chart of story drift for ${n} levels, 1F on the left up to ${n}F on the right. The tallest bar is ${maxI + 1}F.`;
  }
  return { kind: 'chart', W, H, base: s, elements: el, context };
}

/* ══════════════ 入口 ══════════════ */
const GENERATORS = { plan: genPlan, section: genSection, chart: genChart };

// その relation を出せる図に限定する。ここを緩めると
// 「型は below なのに出た図は nth-from」という取り違えが起きる（実際に起きた）。
const PREF = {
  between: ['plan'], adjacent: ['plan'], inside: ['plan', 'section'],
  below: ['section'], above: ['section'], 'same-level': ['section'],
  'nth-from': ['chart', 'section', 'plan'], 'left-right': ['plan', 'chart'],
};

function buildFig(relation, kinds) {
  const avail = (kinds && kinds.length ? kinds : Object.keys(GENERATORS));
  const capable = (PREF[relation] || []).filter(k => avail.includes(k));
  const kind = capable.length ? pick(capable) : pick(avail);
  const fig = kind === 'chart' ? genChart(relation === 'left-right') : GENERATORS[kind]();
  const wrap = (inner) => `<svg viewBox="0 0 ${fig.W} ${fig.H}" ${SVG_HEAD}>${fig.base}${inner}</svg>`;
  return { fig, wrap };
}

/* 話す用: 要素を1つ赤くして「どこ？」と聞く */
function genFigure(relation, kinds) {
  const { fig, wrap } = buildFig(relation, kinds);
  const match = fig.elements.filter(e => e.rel === relation);
  const e = match.length ? pick(match) : pick(fig.elements);
  return {
    kind: fig.kind, relation: e.rel, question: e.question, truth: e.label,
    context: fig.context, svg: wrap(e.overlay), onTarget: e.rel === relation,
  };
}

/* 聞く用: 4つを番号で示し、1つを読み上げて当てさせる。
 * 選択肢は同じグループ（梁なら梁）から採る。梁とあばら筋を混ぜると簡単すぎる。 */
function genListening(relation, kinds) {
  const { fig, wrap } = buildFig(relation, kinds);
  const match = fig.elements.filter(e => e.rel === relation);
  const answer = match.length ? pick(match) : pick(fig.elements);
  // set が同じ＝同じ物の別の呼び方。選択肢に並べると「どちらも正解」になるので除く。
  // 例: 「上端筋の列」と「その列の左の隅筋」。マーカーが重なる位置も除く。
  const okAsOption = (e, list) => !list.some(o =>
    o.set === e.set || o.label === e.label || Math.hypot(e.mx - o.mx, e.my - o.my) <= 26);
  const opts = [answer];
  const sameGroup = shuffle(fig.elements.filter(e => e.group === answer.group));
  for (const e of sameGroup) { if (opts.length >= 4) break; if (okAsOption(e, opts)) opts.push(e); }
  if (opts.length < 3) {
    for (const e of shuffle(fig.elements)) {
      if (opts.length >= 4) break;
      if (okAsOption(e, opts)) opts.push(e);
    }
  }
  const shown = shuffle(opts);
  return {
    kind: fig.kind, relation: answer.rel, context: fig.context,
    svg: wrap(shown.map((e, i) => marker(i + 1, e.mx, e.my)).join('')),
    spoken: `Look at ${answer.label}.`,
    choices: shown.length, answer: shown.indexOf(answer), answerLabel: answer.label,
  };
}
