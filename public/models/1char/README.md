# public/models/1char/

このディレクトリは、ブラウザ推論用にエクスポートされた学習済み 1 文字分類器の成果物を置く場所です。

アプリは実行時にここから `manifest.json` を読み込みます。`manifest.json` や依存ファイルが欠けている場合、アプリは分類器を `利用不可` として明示表示します。

## 想定されるファイル（transformers.js レイアウト）

- `manifest.json` — モデルのメタデータ。スキーマは `manifest.example.json` を参照。
- `config.json` / `tokenizer.json` / `tokenizer_config.json` / `special_tokens_map.json` — transformers.js が読み込む設定・トークナイザ。
- `onnx/model_q4.onnx` — 本番用 ONNX モデル本体（q4 量子化）。`manifest.json` の `model.files.model` で参照（本番既定 `onnx/model_q4.onnx`、`model.dtype` は `q4`）。
- 任意（非本番の代替）で `onnx/model.onnx`（fp32）や `onnx/model_quantized.onnx`（int8）。fp32 を使う場合は `model.dtype` を `null`、int8 を使う場合は `model.dtype` を `q8`、`model.files.model` をそれぞれのファイル名にする。
- 任意で `label_map.json` — `manifest.json` の `labelMapPath` で参照する場合。`labelMap` をマニフェストにインライン埋め込みする場合は不要。

これらは `finetune_smoke/export_onnx.py` がまとめて出力します。

## リポジトリで追跡するもの

GitHub Pages へ学習済み分類器を配備するため、このディレクトリのランタイム成果物はリポジトリで追跡します。
`onnx/*.onnx` は Git LFS で保存し、それ以外の設定・tokenizer・manifest は通常の Git で追跡します。

## スキーマと設計

- マニフェストのスキーマ例: [`manifest.example.json`](./manifest.example.json)
- 生成パイプライン: [`docs/production-pipeline.md`](../../../docs/production-pipeline.md)
- 1 文字分類の設計: `docs/1char-classification-design.md` の §9

## 推論バックエンド

**transformers.js バックエンドはバンドル済み・登録済み**です（`src/classifier/backends/transformersjs.js`、`src/main.js` 起動時に `registerDefaultBackends()` で登録）。
`@huggingface/transformers` の読み込みは「manifest が存在して `init()` が走るとき」だけ動的 import されるため、モデル未投入時はライブラリを取得しません。モデル未投入や破損時は UI に `利用不可` が表示されます。

実際に推論を有効化する手順:

```bash
# 0) （ブロッカー）学習済み run-dir が必須。リポジトリにはコミットされていないので
#    まず finetune_smoke/train_production.py で生成する。

# 1) ワンコマンド: export → manifest → 検証 を一括実行（追加依存が必要）
#    本番は q4 量子化版（onnx/model_q4.onnx / dtype q4）を成果物とする。
pip install -r finetune_smoke/requirements-export.txt
npm run model:deploy -- finetune_smoke/train-output/run-<ts>
#   非本番の代替: int8 量子化版（dtype q8）を出す場合:
npm run model:deploy -- finetune_smoke/train-output/run-<ts> --quantize
#   何を実行するか確認だけする場合:
npm run model:deploy -- finetune_smoke/train-output/run-<ts> --dry-run
```

`npm run model:deploy` は run-dir を検証し、`finetune_smoke/export_onnx.py` で
ONNX + tokenizer を書き出し、`scripts/build-model-manifest.js` で manifest.json を
生成し、ブラウザが fetch する必須ファイルが揃ったかを最後に検証します。
既に export 済みで manifest だけ作り直したいときは `--skip-export` を付けます。

個別コマンドで実行したい場合（同じ流れ）:

```bash
python3 finetune_smoke/export_onnx.py --run-dir finetune_smoke/train-output/run-<ts> [--quantize]
#   本番（q4）: node scripts/build-model-manifest.js <run-dir> --dtype q4 --model-file onnx/model_q4.onnx
node scripts/build-model-manifest.js finetune_smoke/train-output/run-<ts>
#   非本番の代替（int8）: node scripts/build-model-manifest.js <run-dir> --dtype q8 --model-file onnx/model_quantized.onnx
```

これで `public/models/1char/` に `manifest.json` と成果物一式が揃い、`classifier.init()` が `ready` に到達して `classifyPosts()` が実推論を行います。更新後は Pages 配備のため成果物もコミットしてください（`.onnx` は Git LFS）。
