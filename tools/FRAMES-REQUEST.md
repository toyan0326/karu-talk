# アバターの中割りフレームを作ってもらうための指示書

`emi.jpg`（360x418）を渡して、**目と口だけを描き替えた画像**を作る。
できた画像をこちらに渡してもらえれば、領域の切り出し・縁のぼかし・位置合わせ・組み込みまでやる。

## 使うツールの条件

**画像を「編集」できるものが必要**（テキストから新規生成するだけのものは不可。別人が出てくる）。

| ツール | 可否 |
|---|---|
| ChatGPT の画像機能（画像をアップして「ここだけ変えて」） | **可** |
| Gemini API の画像モデル | 可。ただし無料枠は画像生成の日次割当が実質0 |
| インペイント対応のもの（Draw Things / ComfyUI / A1111 など） | **最適**。マスクした所以外は1ピクセルも動かないので仕上がりが一番きれい |
| Pollinations など鍵なしの無料サービス | **不可**（実測: 渡した画像を無視して別人を生成した） |
| Codex / Claude などのコーディングエージェント | 不可（テキストのモデルで画像は作れない） |

## 最低限ほしい9枚

これだけあれば十分動く。多ければ多いほど滑らかになるが、まずはこの9枚で。

**目（3枚）** — 開いた状態は元画像を使うので不要

| ファイル名 | 指示 |
|---|---|
| `eye-half.png` | eyelids about half lowered, eyes still clearly open |
| `eye-almost.png` | eyelids about three quarters lowered, eyes nearly shut |
| `eye-closed.png` | eyes fully closed, eyelids relaxed, eyelashes resting down |

**口（6枚）** — 閉じた状態は元画像を使うので不要

| ファイル名 | 指示 |
|---|---|
| `mouth-AA.png` | mouth open wide as when saying "ah", upper teeth slightly visible |
| `mouth-E.png` | mouth open and stretched wide as when saying "eh", teeth slightly visible |
| `mouth-I.png` | mouth slightly open and wide as when saying "ee", teeth visible |
| `mouth-O.png` | lips rounded and open as when saying "oh" |
| `mouth-U.png` | lips pushed forward in a small round shape as when saying "oo" |
| `mouth-FV.png` | upper teeth resting lightly on the lower lip, as when saying "f" |

## 毎回つけてほしい共通の指示

これが抜けると顔ごと作り直されて使えない。

```
Edit this portrait. <上の表の指示をここに>.

CRITICAL: keep everything else pixel-identical — the same person, the exact same
head position, size, angle and framing, the same hair, the same lighting and the
same background. Change nothing except what is asked. Do not crop, do not zoom,
do not re-pose, do not beautify. Output the full image at the same dimensions
(360 x 418).
```

## 渡し方

- 形式は PNG でも JPEG でもよい。サイズは 360x418 が理想だが、**多少ずれていても構わない**
  （こちらで元画像に合わせて位置合わせする）。
- 顔の位置が多少動いてしまっても渡してほしい。**目や口以外が大きく変わっている場合だけ**没。
- ファイル名は上の表のとおりにしてもらえると助かる。

## こちらでやること

1. 元画像と比較して位置合わせ
2. 目・口の領域だけを切り出し、縁をぼかして貼れるパッチにする
   （そのまま連番再生すると顔がわずかに動いてジッターになるため）
3. `face/frames.json` を書いて組み込み。`avatar.js` は face/frames.json があれば自動で使う
