#!/usr/bin/env python3
"""目と口の「途中の形」を生成して、貼るだけのパッチにする。

なぜパッチにするか:
  生成した画像をそのまま連番で再生すると、生成のたびに顔の位置がわずかに動いて
  ジッターになる。目や口の領域だけを切り出し、縁をぼかして元画像に重ねる形にすれば
  ズレようがない。runtime は base を描いてパッチを貼るだけで済む。

使い方:
    python3 tools/make-face-frames.py            # 生成して face/ に書き出す
    python3 tools/make-face-frames.py --dry-run  # APIを叩かずに枠だけ確認

前提:
    ~/dev/english-ai-chat/.env の VITE_GEMINI_API_KEY、または環境変数 GEMINI_API_KEY。
    画像モデルは無料枠だと1日の上限がすぐ尽きる。429 が出たら日を改めるか、
    課金を有効にしてから実行する。
"""
import base64
import io
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "emi.jpg")
OUT = os.path.join(ROOT, "face")
MODEL = os.environ.get("IMAGE_MODEL", "gemini-3.1-flash-image")
DRY = "--dry-run" in sys.argv

# emi.jpg (360x418) の実測値。avatar.js の FACE と合わせること。
EYE_BOX = (92, 132, 232, 196)      # 両目が入る矩形
MOUTH_BOX = (136, 214, 232, 276)   # 口が入る矩形

# 目: 開 → 閉 の中割り。開いた状態は元画像なので作らない。
EYE_STEPS_MIN = [
    ("eye1", "eyelids about half lowered, eyes still clearly open"),
    ("eye2", "eyelids about three quarters lowered, eyes nearly shut"),
    ("eye3", "eyes fully closed, eyelids relaxed, eyelashes resting down"),
]
EYE_STEPS_FULL = [("eye0", "eyes fully open, exactly as in the original")] + EYE_STEPS_MIN

# 口: 形ごとに 閉じ→最大 の中割りを作る
MOUTH_SHAPES = {
    "AA": "mouth open wide as when saying 'ah', upper teeth slightly visible",
    "E":  "mouth open and stretched wide as when saying 'eh', teeth slightly visible",
    "I":  "mouth slightly open and wide as when saying 'ee', teeth visible",
    "O":  "lips rounded and open as when saying 'oh'",
    "U":  "lips pushed forward in a small round shape as when saying 'oo'",
    "L":  "mouth open with the tongue tip touching behind the upper teeth",
    "FV": "upper teeth resting lightly on the lower lip, as when saying 'f'",
    "S":  "mouth barely open with teeth close together, as when saying 's'",
}
MOUTH_STEPS = 3       # --full のとき、各形につき何段階つくるか
# 無料枠は1日に作れる本数が少ない。まずはこの最小構成（目3＋口6＝9枚）を狙う。
MINIMAL = "--full" not in sys.argv
MOUTH_MIN = ["AA", "E", "I", "O", "U", "FV"]
PACE_SEC = float(os.environ.get("PACE_SEC", "12"))   # 分あたりの制限に当たらないよう間隔を空ける


def api_key():
    k = os.environ.get("GEMINI_API_KEY")
    if k:
        return k
    env = os.path.expanduser("~/dev/english-ai-chat/.env")
    if os.path.exists(env):
        m = re.search(r"VITE_GEMINI_API_KEY=(.+)", open(env).read())
        if m:
            return m.group(1).strip().strip("'\"")
    sys.exit("APIキーが見つかりません（GEMINI_API_KEY を設定してください）")


def edit(img_bytes, instruction, key):
    """元画像＋指示 → 編集後の画像。顔の位置を動かさないことを強く指示する。"""
    body = {
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(img_bytes).decode()}},
            {"text": (
                "Edit this portrait. " + instruction + ".\n"
                "CRITICAL: keep everything else pixel-identical — the same person, the exact same "
                "head position, size, angle and framing, the same hair, the same lighting and "
                "background. Change nothing except what is asked. Do not crop, do not zoom, "
                "do not re-pose. Output the full image at the same dimensions."
            )},
        ]}],
        "generationConfig": {"responseModalities": ["IMAGE"], "temperature": 0.1},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=240))
    for p in d["candidates"][0]["content"]["parts"]:
        b = p.get("inlineData") or p.get("inline_data")
        if b:
            return base64.b64decode(b["data"])
    raise RuntimeError("画像が返りませんでした")


def align_to_base(gen, base, box, search=8):
    """生成画像を元画像に合わせる。
    編集した領域(box)の外側だけで一致度を測るので、目や口が変わっていても正しく合う。
    ここを省くと、貼ったパッチが数ピクセルずれて顔が痙攣して見える。"""
    import numpy as np
    a = np.asarray(base.convert("L"), dtype=np.float32)
    b = np.asarray(gen.convert("L"), dtype=np.float32)
    h, w = a.shape
    mask = np.ones_like(a, dtype=bool)
    mask[box[1]:box[3], box[0]:box[2]] = False          # 編集領域は比較から外す
    m = search
    best, bdx, bdy = None, 0, 0
    for dy in range(-m, m + 1):
        for dx in range(-m, m + 1):
            shifted = np.roll(np.roll(b, dy, axis=0), dx, axis=1)
            inner = (slice(m, h - m), slice(m, w - m))
            d = np.abs(a[inner] - shifted[inner])[mask[inner]]
            v = float(d.mean())
            if best is None or v < best:
                best, bdx, bdy = v, dx, dy
    if (bdx, bdy) != (0, 0):
        from PIL import ImageChops
        gen = ImageChops.offset(gen, bdx, bdy)
    return gen, (bdx, bdy), best


def feathered_patch(gen_img, box, feather=6):
    """生成画像から box を切り出し、縁をぼかしたRGBAパッチにする。
    縁をぼかさないと矩形の継ぎ目が見える（ワープ版で実際に見えた）。"""
    from PIL import Image, ImageDraw, ImageFilter
    patch = gen_img.crop(box).convert("RGBA")
    w, h = patch.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [feather, feather, w - feather, h - feather], radius=feather, fill=255)
    patch.putalpha(mask.filter(ImageFilter.GaussianBlur(feather * 0.7)))
    return patch


def main():
    from PIL import Image
    os.makedirs(OUT, exist_ok=True)
    base = Image.open(BASE).convert("RGB")
    print(f"base: {base.size}  model: {MODEL}  dry-run: {DRY}")

    key = None if DRY else api_key()
    raw = open(BASE, "rb").read()
    manifest = {"base": "../emi.jpg", "eyes": [], "mouth": {}}

    def run(name, instruction, box):
        path = os.path.join(OUT, name + ".png")
        if DRY:
            print(f"  [dry] {name}  box={box}")
            return {"file": name + ".png", "x": box[0], "y": box[1]}
        for attempt in range(3):
            try:
                out = Image.open(io.BytesIO(edit(raw, instruction, key))).convert("RGB")
                if out.size != base.size:
                    out = out.resize(base.size, Image.LANCZOS)
                out, off, score = align_to_base(out, base, box)
                feathered_patch(out, box).save(path)
                print(f"  ok  {name}  align={off} diff={score:.1f}"
                      + ("  ⚠顔が大きく変わっている可能性" if score > 12 else ""))
                return {"file": name + ".png", "x": box[0], "y": box[1]}
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:120]
                print(f"  {name}: HTTP {e.code} {msg}")
                if e.code == 429 and attempt < 2:
                    time.sleep(65)
                    continue
                return None
        return None

    print(f"目の中割り（{'最小' if MINIMAL else '全'}構成）:")
    for name, ins in (EYE_STEPS_MIN if MINIMAL else EYE_STEPS_FULL):
        r = run(name, ins, EYE_BOX)
        if r:
            manifest["eyes"].append(r)
        if not DRY:
            time.sleep(PACE_SEC)

    print("口の形:")
    shapes = MOUTH_MIN if MINIMAL else list(MOUTH_SHAPES)
    for shape in shapes:
        ins = MOUTH_SHAPES[shape]
        frames = []
        steps = 1 if MINIMAL else MOUTH_STEPS
        for i in range(steps):
            amt = "fully" if MINIMAL else ["slightly", "moderately", "fully"][i]
            r = run(f"m{shape}{i}", f"change only the mouth: {ins}, {amt} open", MOUTH_BOX)
            if r:
                frames.append(r)
            if not DRY:
                time.sleep(PACE_SEC)
        if frames:
            manifest["mouth"][shape] = frames

    if DRY:
        print("\n[dry-run] frames.json は書きません（実体の無いパッチを参照させないため）")
        return
    if not manifest["eyes"] and not manifest["mouth"]:
        print("\n1枚も生成できませんでした。frames.json は書きません。")
        return
    with open(os.path.join(OUT, "frames.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"\nwrote {OUT}/frames.json  eyes={len(manifest['eyes'])} mouth={len(manifest['mouth'])}")
    print("avatar.js は face/frames.json があれば自動でこちらを使います。")


if __name__ == "__main__":
    main()
