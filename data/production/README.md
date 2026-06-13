# data/production

本番ラベリングパイプラインの成果物が出力されるディレクトリ。`npm run collect` が複数リレーから収集した生ノート（`raw/raw-notes.jsonl`）と、フィルタ・多様性サンプリング後の承認集合（`approved-notes.json`）・収集レポート（`collection-report.json`）・ラベルマップ（`label_map.json`）をここに書き出し、`npm run label` がさらに `labels/` 配下に Gemini ラベリング結果（`gemini-labels.json`）・生プロンプト/応答ログ（`gemini-labeling-log.jsonl`）・失敗一覧・チェックポイント・レポートを保存する。`npm run export:dataset` は `labels/` 配下の real + synthetic 成果物をマージし、学習投入用 JSONL と集計を `training/` 配下に出力する。詳細は [docs/production-pipeline.md](../../docs/production-pipeline.md) を参照。
