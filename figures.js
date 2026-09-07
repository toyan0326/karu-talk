/* 図の自動生成。
 *
 * 肝は「生成した側が正解を知っている」こと。位置関係の判定をLLMの目に頼らず、
 * こちらが持っている truth と突き合わせる。画像をAPIに送るのはユーザー自身の
 * スクショのときだけで、自動生成図では一切送らない（速くて確実で安い）。
 *
 * genFigure(relation) は、指定した位置関係を「使わないと答えられない」図を返す。
 *   → 未習得の型に合わせて図を出せる、というのがこの設計の狙い。
 */
'use strict';

// 型が要求する位置関係のタグ。図はこのタグを満たすように作られる。
const RELATIONS = ['between', 'nth-from', 'below', 'above', 'same-level', 'left-right', 'inside', 'adjacent'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const ordinal = (n) => ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] || `${n}th`;

const SVG_HEAD = 'xmlns="http://www.w3.org/2000/svg" font-family="system-ui,-apple-system,sans-serif"';
const INK = '#dfe6f0', THIN = '#5b6a80', DIM = '#8b9bb4', HOT = '#ff5f56';

/* ══════════════ ① 伏図 ══════════════ */
function genPlan(relation) {
  const cols = ['X', 'Y', 'Z', 'W'].slice(0, ri(3, 4));
  const rows = ['1', '2', '3'].slice(0, ri(2, 3));
  const W = 620, H = 420;
  const x0 = 105, y0 = 95;
  const dx = Math.min(150, (W - x0 - 70) / (cols.length - 1));
  const dy = Math.min(120, (H - y0 - 90) / (rows.length - 1));
  const X = (i) => x0 + i * dx, Y = (j) => y0 + j * dy;

  // 吹抜けを1つ置く（ただし対象ベイとは別にする）
  const voidI = ri(0, cols.length - 2), voidJ = ri(0, rows.length - 2);

  let s = '';
  // 通り芯
  for (let i = 0; i < cols.length; i++)
    s += `<line x1="${X(i)}" y1="52" x2="${X(i)}" y2="${Y(rows.length - 1) + 46}" stroke="${THIN}" stroke-width="1" stroke-dasharray="10 4 2 4"/>`;
  for (let j = 0; j < rows.length; j++)
    s += `<line x1="58" y1="${Y(j)}" x2="${X(cols.length - 1) + 46}" y2="${Y(j)}" stroke="${THIN}" stroke-width="1" stroke-dasharray="10 4 2 4"/>`;
  cols.forEach((c, i) => {
    s += `<circle cx="${X(i)}" cy="40" r="14" fill="none" stroke="${DIM}" stroke-width="1.2"/>`;
    s += `<text x="${X(i)}" y="45" fill="${DIM}" font-size="13" font-weight="700" text-anchor="middle">${c}</text>`;
  });
  rows.forEach((r, j) => {
    s += `<circle cx="${44}" cy="${Y(j)}" r="14" fill="none" stroke="${DIM}" stroke-width="1.2"/>`;
    s += `<text x="44" y="${Y(j) + 5}" fill="${DIM}" font-size="13" font-weight="700" text-anchor="middle">${r}</text>`;
  });

  // 吹抜け
  const vx1 = X(voidI) + 26, vy1 = Y(voidJ) + 22, vx2 = X(voidI + 1) - 26, vy2 = Y(voidJ + 1) - 22;
  s += `<rect x="${vx1}" y="${vy1}" width="${vx2 - vx1}" height="${vy2 - vy1}" fill="none" stroke="${THIN}" stroke-width="1.3" stroke-dasharray="6 3"/>`;
  s += `<line x1="${vx1}" y1="${vy2}" x2="${vx2}" y2="${vy1}" stroke="${THIN}" stroke-width="1.1"/>`;
  s += `<text x="${(vx1 + vx2) / 2}" y="${(vy1 + vy2) / 2 + 4}" fill="${THIN}" font-size="11" text-anchor="middle">VOID</text>`;

  // 大梁
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

  // 小梁は吹抜けの「隣」のベイに置く（adjacent の出題で隣接関係が本当に成り立つように）
  const nbrs = [[voidI + 1, voidJ], [voidI - 1, voidJ], [voidI, voidJ + 1], [voidI, voidJ - 1]]
    .filter(([i, j]) => i >= 0 && j >= 0 && i <= cols.length - 2 && j <= rows.length - 2);
  const [sbI, sbJ] = nbrs.length ? pick(nbrs) : [voidI, voidJ];
  const sb = { i: sbI, j: sbJ, x: (X(sbI) + X(sbI + 1)) / 2, y1: Y(sbJ), y2: Y(sbJ + 1),
               side: sbI > voidI ? 'to the right of' : sbI < voidI ? 'to the left of' : sbJ > voidJ ? 'just below' : 'just above' };
  if (sb) s += `<line x1="${sb.x}" y1="${sb.y1}" x2="${sb.x}" y2="${sb.y2}" stroke="${DIM}" stroke-width="4" stroke-linecap="square"/>`;

  // 柱
  for (let i = 0; i < cols.length; i++)
    for (let j = 0; j < rows.length; j++)
      s += `<rect x="${X(i) - 15}" y="${Y(j) - 15}" width="30" height="30" fill="${INK}"/>`;

  const floor = pick(['2nd', '3rd', '4th']);
  s += `<text x="30" y="${H - 22}" fill="${DIM}" font-size="12">${floor.toUpperCase()} FLOOR FRAMING PLAN</text>`;

  // ── 出題対象を選び、正解文を作る ──
  let hot = '', truth = '', question = 'Where is the beam highlighted in red?';

  if (relation === 'nth-from') {
    const i = ri(0, cols.length - 1), j = ri(0, rows.length - 1);
    hot = `<rect x="${X(i) - 18}" y="${Y(j) - 18}" width="36" height="36" fill="none" stroke="${HOT}" stroke-width="4"/>`;
    truth = `the ${ordinal(i + 1)} column from the left, on grid line ${rows[j]} (grid ${cols[i]}-${rows[j]})`;
    question = 'Where is the column highlighted in red?';
  } else if (relation === 'inside' && sb) {
    hot = `<rect x="${vx1 - 4}" y="${vy1 - 4}" width="${vx2 - vx1 + 8}" height="${vy2 - vy1 + 8}" fill="none" stroke="${HOT}" stroke-width="4"/>`;
    truth = `the void (opening) inside the bay between grids ${cols[voidI]} and ${cols[voidI + 1]}, between grid lines ${rows[voidJ]} and ${rows[voidJ + 1]}`;
    question = 'Where is the area highlighted in red?';
  } else if (relation === 'adjacent' && sb) {
    hot = `<line x1="${sb.x}" y1="${sb.y1}" x2="${sb.x}" y2="${sb.y2}" stroke="${HOT}" stroke-width="6" stroke-linecap="square"/>`;
    truth = `the secondary beam running vertically at mid-span of the bay ${sb.side} the void — the bay between grids ${cols[sb.i]} and ${cols[sb.i + 1]}, between grid lines ${rows[sb.j]} and ${rows[sb.j + 1]}`;
    question = 'Where is the beam highlighted in red?';
  } else if (relation === 'left-right') {
    const j = ri(0, rows.length - 1);
    const i = pick([0, cols.length - 2]);
    const b = beams.find(b => b.dir === 'h' && b.i === i && b.j === j);
    hot = `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke="${HOT}" stroke-width="9" stroke-linecap="square"/>`;
    truth = `the main beam on grid line ${rows[j]}, in the ${i === 0 ? 'left-most' : 'right-most'} bay, between grids ${cols[i]} and ${cols[i + 1]}`;
  } else {
    // between（既定）
    const horiz = beams.filter(b => b.dir === 'h');
    const b = pick(horiz);
    hot = `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke="${HOT}" stroke-width="9" stroke-linecap="square"/>`;
    truth = `the main beam on grid line ${rows[b.j]}, between grids ${cols[b.i]} and ${cols[b.i + 1]}`;
    relation = 'between';
  }

  return {
    kind: 'plan', relation, question, truth,
    svg: `<svg viewBox="0 0 ${W} ${H}" ${SVG_HEAD}>${s}${hot}</svg>`,
    context: `A ${floor} floor framing plan. Vertical grids are labelled ${cols.join(', ')} from left to right; horizontal grid lines are ${rows.join(', ')} from top to bottom. There is a void in the bay between grids ${cols[voidI]} and ${cols[voidI + 1]}.`,
  };
}

/* ══════════════ ② 断面・配筋図 ══════════════ */
function genSection(relation) {
  const W = 620, H = 420;
  const bw = 210, bh = 300, bx = (W - bw) / 2 - 40, by = 60;
  const cover = 26;
  const topN = ri(3, 4);
  const botRows = ri(1, 2);           // 下端筋の段数
  const botN = ri(3, 4);
  const stirrupPitch = pick([150, 200, 250]);

  let s = '';
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${INK}" stroke-width="3"/>`;
  // あばら筋
  s += `<rect x="${bx + cover}" y="${by + cover}" width="${bw - 2 * cover}" height="${bh - 2 * cover}" rx="10"
        fill="none" stroke="${DIM}" stroke-width="2.5"/>`;

  const barR = 9;
  const rowY = [];
  const topY = by + cover + barR + 2;
  rowY.push(topY);
  const botY1 = by + bh - cover - barR - 2;
  const botY2 = botY1 - (barR * 2 + 7);
  const spread = (n, y) => {
    const x1 = bx + cover + barR + 3, x2 = bx + bw - cover - barR - 3;
    return Array.from({ length: n }, (_, k) => ({ x: n === 1 ? (x1 + x2) / 2 : x1 + k * (x2 - x1) / (n - 1), y }));
  };
  const topBars = spread(topN, topY);
  const bot1 = spread(botN, botY1);
  // 2段目は1段目の内側の鉄筋の真上に載る（外側の隅筋の上には置かない）
  const bot2 = botRows === 2
    ? bot1.slice(1, -1).map(p => ({ x: p.x, y: botY2 }))
    : [];

  const drawBars = (arr, fill) => arr.map(p =>
    `<circle cx="${p.x}" cy="${p.y}" r="${barR}" fill="${fill}"/>`).join('');
  s += drawBars(topBars, INK) + drawBars(bot1, INK) + drawBars(bot2, INK);

  // かぶり寸法
  s += `<line x1="${bx}" y1="${by + bh + 22}" x2="${bx + cover}" y2="${by + bh + 22}" stroke="${DIM}" stroke-width="1"/>`;
  s += `<line x1="${bx}" y1="${by + bh}" x2="${bx}" y2="${by + bh + 30}" stroke="${DIM}" stroke-width="1"/>`;
  s += `<line x1="${bx + cover}" y1="${by + bh}" x2="${bx + cover}" y2="${by + bh + 30}" stroke="${DIM}" stroke-width="1"/>`;
  s += `<text x="${bx + cover + 8}" y="${by + bh + 26}" fill="${DIM}" font-size="11">cover 40</text>`;
  s += `<text x="${bx + bw + 24}" y="${by + 20}" fill="${DIM}" font-size="12">STIRRUPS @${stirrupPitch}</text>`;
  s += `<text x="30" y="${H - 22}" fill="${DIM}" font-size="12">BEAM SECTION  G1  (400 x 700)</text>`;

  let hot = '', truth = '', question = 'Where are the bars highlighted in red?';
  const ring = (arr, r = barR + 6) => arr.map(p =>
    `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="none" stroke="${HOT}" stroke-width="3.5"/>`).join('');

  if (relation === 'below' && botRows === 2) {
    hot = ring(bot1);
    truth = `the first (outer) layer of bottom bars, the row directly below the second layer, at the very bottom of the section`;
  } else if (relation === 'below') {
    hot = ring(bot1);
    truth = `the bottom bars, the single row running along the bottom of the section, directly below the top bars`;
  } else if (relation === 'above' && botRows === 2) {
    hot = ring(bot2);
    truth = `the second layer of bottom bars, the row sitting directly above the first (outer) layer at the bottom of the section`;
  } else if (relation === 'above') {
    hot = ring(topBars);
    truth = `the top bars, the row of bars running along the top of the section, above the bottom bars and just inside the top of the stirrup`;
  } else if (relation === 'same-level') {
    const one = pick([topBars[0], topBars[topBars.length - 1]]);
    hot = ring([one]);
    truth = `the corner top bar on the ${one === topBars[0] ? 'left' : 'right'} side, at the same level as the rest of the top bars`;
    question = 'Where is the bar highlighted in red?';
  } else if (relation === 'nth-from') {
    const k = ri(1, Math.min(3, botN));
    hot = ring([bot1[k - 1]]);
    truth = `the ${ordinal(k)} bottom bar from the left, in the outer (first) layer of bottom bars`;
    question = 'Where is the bar highlighted in red?';
  } else {
    hot = `<rect x="${bx + cover - 4}" y="${by + cover - 4}" width="${bw - 2 * cover + 8}" height="${bh - 2 * cover + 8}" rx="12"
           fill="none" stroke="${HOT}" stroke-width="3.5"/>`;
    truth = `the stirrup, the closed hoop running around the outside of the longitudinal bars, inside the concrete cover`;
    question = 'Where is the reinforcement highlighted in red?';
    relation = 'inside';
  }

  return {
    kind: 'section', relation, question, truth,
    svg: `<svg viewBox="0 0 ${W} ${H}" ${SVG_HEAD}>${s}${hot}</svg>`,
    context: `A beam cross-section, 400 x 700. ${topN} top bars, ${botRows} layer(s) of bottom bars (${botN} bars in the outer layer), stirrups at ${stirrupPitch} centres, 40 mm cover.`,
  };
}

/* ══════════════ ③ グラフ・表 ══════════════ */
function genChart(relation) {
  const W = 620, H = 420;
  const asTable = relation === 'left-right' ? false : Math.random() < 0.5;
  let s = '', hot = '', truth = '', question = '', context = '';

  if (asTable) {
    const heads = ['Story', 'Qd (kN)', 'Qu (kN)', 'Qu/Qd'];
    const nRow = ri(4, 5);
    const rowsData = Array.from({ length: nRow }, (_, k) => [
      `${nRow - k}F`, String(ri(800, 2400)), String(ri(1200, 3200)), (0.9 + Math.random() * 1.1).toFixed(2),
    ]);
    const cw = 128, chh = 46, tx = 55, ty = 80;
    heads.forEach((h, i) => {
      s += `<rect x="${tx + i * cw}" y="${ty}" width="${cw}" height="${chh}" fill="#1c2430" stroke="${THIN}"/>`;
      s += `<text x="${tx + i * cw + cw / 2}" y="${ty + 29}" fill="${INK}" font-size="14" font-weight="700" text-anchor="middle">${h}</text>`;
    });
    rowsData.forEach((r, j) => r.forEach((v, i) => {
      s += `<rect x="${tx + i * cw}" y="${ty + (j + 1) * chh}" width="${cw}" height="${chh}" fill="none" stroke="${THIN}"/>`;
      s += `<text x="${tx + i * cw + cw / 2}" y="${ty + (j + 1) * chh + 29}" fill="${INK}" font-size="14" text-anchor="middle">${v}</text>`;
    }));
    s += `<text x="55" y="${H - 30}" fill="${DIM}" font-size="12">STORY SHEAR CHECK</text>`;

    const rj = ri(1, nRow), ci = ri(1, 3);
    hot = `<rect x="${tx + ci * cw + 2}" y="${ty + rj * chh + 2}" width="${cw - 4}" height="${chh - 4}"
           fill="none" stroke="${HOT}" stroke-width="3.5"/>`;
    truth = `the cell in the ${ordinal(rj)} data row from the top (story ${rowsData[rj - 1][0]}), in the column headed "${heads[ci]}"`;
    question = 'Which value is highlighted in red?';
    context = `A table with columns ${heads.join(', ')} and ${nRow} data rows, from ${rowsData[0][0]} at the top down to ${rowsData[nRow - 1][0]}.`;
    relation = 'nth-from';
  } else {
    const n = ri(5, 7);
    const vals = Array.from({ length: n }, () => ri(20, 100));
    const bx = 80, bw = 58, gap = 16, base = 330, top = 90;
    vals.forEach((v, i) => {
      const h = (v / 100) * (base - top);
      s += `<rect x="${bx + i * (bw + gap)}" y="${base - h}" width="${bw}" height="${h}" fill="#3ba0ff" opacity=".72"/>`;
      s += `<text x="${bx + i * (bw + gap) + bw / 2}" y="${base + 20}" fill="${DIM}" font-size="12" text-anchor="middle">${i + 1}F</text>`;
    });
    s += `<line x1="60" y1="${base}" x2="${W - 40}" y2="${base}" stroke="${DIM}" stroke-width="1.5"/>`;
    s += `<line x1="60" y1="${top - 14}" x2="60" y2="${base}" stroke="${DIM}" stroke-width="1.5"/>`;
    s += `<text x="60" y="${top - 24}" fill="${DIM}" font-size="12">drift (mm)</text>`;
    s += `<text x="55" y="${H - 30}" fill="${DIM}" font-size="12">STORY DRIFT BY LEVEL</text>`;

    const maxI = vals.indexOf(Math.max(...vals));
    const k = (relation === 'left-right') ? pick([0, n - 1]) : (Math.random() < 0.5 ? maxI : ri(0, n - 1));
    const h = (vals[k] / 100) * (base - top);
    hot = `<rect x="${bx + k * (bw + gap) - 3}" y="${base - h - 3}" width="${bw + 6}" height="${h + 6}"
           fill="none" stroke="${HOT}" stroke-width="3.5"/>`;
    truth = (relation === 'left-right')
      ? `the ${k === 0 ? 'left-most' : 'right-most'} bar (${k + 1}F)${k === maxI ? ', which is also the tallest bar' : ''}`
      : k === maxI
        ? `the tallest bar, which is the ${ordinal(k + 1)} bar from the left (${k + 1}F)`
        : `the ${ordinal(k + 1)} bar from the left (${k + 1}F)`;
    question = 'Which bar is highlighted in red?';
    context = `A bar chart of story drift for ${n} levels, 1F on the left up to ${n}F on the right. The tallest bar is ${maxI + 1}F.`;
    if (relation !== 'left-right') relation = 'nth-from';
  }

  return { kind: 'chart', relation, question, truth, svg: `<svg viewBox="0 0 ${W} ${H}" ${SVG_HEAD}>${s}${hot}</svg>`, context };
}

/* ══════════════ 入口 ══════════════ */
const GENERATORS = { plan: genPlan, section: genSection, chart: genChart };

// relation を満たす図を作る。kinds を絞れば図の種類も指定できる。
function genFigure(relation, kinds) {
  const avail = (kinds && kinds.length ? kinds : Object.keys(GENERATORS));
  // その relation を出しやすい図を優先する
  const pref = {
    between: ['plan'], adjacent: ['plan'], inside: ['plan', 'section'],
    below: ['section'], above: ['section'], 'same-level': ['section'],
    'nth-from': ['chart', 'section', 'plan'], 'left-right': ['plan', 'chart'],
  }[relation] || [];
  // その relation を出せる図に限定する。ここを緩めると
  // 「型は below なのに出た図は nth-from」という取り違えが起きる（実際に起きた）。
  const capable = pref.filter(k => avail.includes(k));
  const kind = capable.length ? pick(capable) : pick(avail);
  const fig = GENERATORS[kind](relation);
  fig.onTarget = (fig.relation === relation);   // 取り違えたら呼び出し側が分かるようにする
  return fig;
}
