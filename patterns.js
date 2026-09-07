/* 組み込みの「型」。
 *
 * 学習の単位は単語でもカードでもなく《型》。同じ型で3回言えたら卒業して消える。
 * ホームの「未習得の型 N個」が減っていくのが、続けるための唯一の仕掛け。
 *
 *  kind:'figure' … 図を見て位置を説明する。relation が図の生成条件になる。
 *  kind:'intent' … 日本語の意図を見て、それを英語で言う（画面共有の決まり文句）。
 */
'use strict';

const BUILTIN_PATTERNS = [
  /* ── 位置関係（図が出る）── 画面共有で指させないぶん、ここが本丸 ── */
  { id: 'p-between', kind: 'figure', relation: 'between',
    en: 'between grids A and B', ja: 'AとBの間にある', note: '通り芯で挟んで特定する' },
  { id: 'p-nth', kind: 'figure', relation: 'nth-from',
    en: 'the third one from the left / from the top', ja: '左から3番目・上から3番目', note: '数えて指す' },
  { id: 'p-below', kind: 'figure', relation: 'below',
    en: 'directly below ~', ja: '～の真下', note: 'under は覆う含み。離れた上下は below' },
  { id: 'p-above', kind: 'figure', relation: 'above',
    en: 'above ~ / on top of ~', ja: '～の上', note: '接触するなら on top of' },
  { id: 'p-level', kind: 'figure', relation: 'same-level',
    en: 'at the same level as ~ / in line with ~', ja: '～と同じ高さ・同じ通り', note: '面一なら flush with' },
  { id: 'p-side', kind: 'figure', relation: 'left-right',
    en: 'the left-most one / on the right-hand side', ja: '一番左の・右側の', note: '端を指す' },
  { id: 'p-inside', kind: 'figure', relation: 'inside',
    en: 'inside ~ / within ~', ja: '～の中に', note: '囲まれている関係' },
  { id: 'p-next', kind: 'figure', relation: 'adjacent',
    en: 'next to ~ / adjacent to ~', ja: '～の隣', note: '接している必要はない' },

  /* ── 画面共有：見せる ── */
  { id: 's-see', kind: 'intent', ja: '画面が見えているか確認する', en: 'Can you see my screen?' },
  { id: 's-zoom', kind: 'intent', ja: 'この部分を拡大すると伝える', en: "Let me zoom in on this part." },
  { id: 's-scroll', kind: 'intent', ja: '少し下にスクロールすると伝える', en: "I'll scroll down a bit." },
  { id: 's-small', kind: 'intent', ja: '字が小さくないか気遣う', en: 'Is that too small to read?' },
  { id: 's-share', kind: 'intent', ja: '別の資料に画面を切り替えると伝える', en: "Let me switch to the other drawing." },

  /* ── 画面共有：指す ── */
  { id: 's-high', kind: 'intent', ja: '今ハイライトしている場所だと伝える', en: "The one I'm highlighting here." },
  { id: 's-cursor', kind: 'intent', ja: 'カーソルのある場所だと伝える', en: 'Where my cursor is now.' },
  { id: 's-thisone', kind: 'intent', ja: '今出ている図のこの部分、と限定する', en: 'This part right here, on the plan.' },

  /* ── 画面共有：進める ── */
  { id: 's-walk', kind: 'intent', ja: '順を追って説明すると宣言する', en: 'Let me walk you through this.' },
  { id: 's-moveon', kind: 'intent', ja: '断面の説明に移ると伝える', en: "Moving on to the section." },
  { id: 's-back', kind: 'intent', ja: 'さっきの図に戻ると伝える', en: 'Let me go back to the previous drawing.' },
  { id: 's-bg', kind: 'intent', ja: '先に背景を説明しておくと前置きする', en: 'Just to give you some background,' },
  { id: 's-skip', kind: 'intent', ja: '細かい所は飛ばすと断る', en: "I'll skip the details for now." },

  /* ── 画面共有：確認する・受ける ── */
  { id: 's-make', kind: 'intent', ja: 'ここまで伝わったか確認する', en: 'Does that make sense so far?' },
  { id: 's-which', kind: 'intent', ja: 'どれのことか聞き返す', en: 'Sorry, which one do you mean?' },
  { id: 's-left', kind: 'intent', ja: '左のやつのことか確認する', en: 'Do you mean the one on the left?' },
  { id: 's-repeat', kind: 'intent', ja: 'もう一度言ってほしいと頼む', en: 'Could you say that again?' },
  { id: 's-later', kind: 'intent', ja: '確認して後で回答すると伝える', en: "Let me check and get back to you." },

  /* ── 配筋・断面まわりの言い回し ── */
  { id: 'r-top', kind: 'intent', ja: '上端筋が2段になっていると伝える', en: 'The top bars are in two layers.' },
  { id: 'r-stirrup', kind: 'intent', ja: 'あばら筋が200ピッチだと伝える', en: 'The stirrups are at 200 centres.' },
  { id: 'r-cover', kind: 'intent', ja: 'かぶりが足りないと指摘する', en: "There isn't enough cover here." },
  { id: 'r-lap', kind: 'intent', ja: '継手長さを確認したいと伝える', en: 'I want to check the lap length.' },
];
