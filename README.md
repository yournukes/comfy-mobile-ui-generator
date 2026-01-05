# ComfyUI Mobile Card UI Generator

ComfyUI の prompt JSON を貼り付けると、ノード単位のカード UI に変換して表示し、編集・実行・進捗監視・生成結果表示まで行える LAN 向け Web アプリです。

## 主な機能

- prompt JSON の解析とノードカード表示（折りたたみ対応）
- ComfyUI の `object_info` を取得し入力 UI を自動生成
- ComfyUI へのキュー投入（`/prompt`）
- WebSocket 経由の進捗監視
- 完了後の生成画像表示（`/history` + `/view` をサーバ経由でプロキシ）
- prompt JSON の保存・呼び出し（`/data/prompts` に JSON ファイル保存）
- デフォルト ComfyUI サーバーアドレスの保存・復元（`/data/settings.json`）

---

## Windows ローカル起動（run.bat）

> Docker を使わず、ローカル環境で直接起動します。

1. `run.bat` をダブルクリックまたは `cmd` で実行
2. 仮想環境作成 → 依存インストール → `uvicorn` 起動
3. ブラウザで `http://localhost:8300` にアクセス

---

## Docker ビルド・起動

```bash
docker build -t comfy-mobile-ui .
```

### Windows 例（PowerShell / コマンドプロンプト）

```bash
docker run --rm -p 8300:8300 -v "%cd%\data:/data" comfy-mobile-ui
```

### Linux / macOS 例

```bash
docker run --rm -p 8300:8300 -v "$(pwd)/data:/data" comfy-mobile-ui
```

- `/data` 配下に `prompts/` と `settings.json` が生成されます。
- bind mount により保存データが永続化されます。

---

## 使い方

### 1. ComfyUI URL の設定

- 画面上部の **ComfyUI ベースURL** に `http://<IP>:8188` を入力
- **ノード定義取得** ボタンで `object_info` を取得
- **デフォルトURLとして保存** で `settings.json` に保存
- **デフォルトURLに戻す** で復元

### 2. prompt JSON の解析

1. ComfyUI の prompt JSON をテキストエリアに貼り付け
2. **解析** ボタンでノードカード表示
3. 入力 UI から各ノードの input を編集

### 3. 実行と進捗確認

- **実行（キュー投入）** ボタンで ComfyUI へジョブ送信
- 進捗バーと現在実行ノードを表示
- 実行完了後に生成画像を縦並びで表示（タップで拡大）

### 4. prompt JSON の保存・呼び出し

- **保存** ボタンで `/data/prompts/<id>.json` に保存
- **保存済み一覧更新** で一覧取得
- **読み込み** でテキストエリアに復元 → 再解析
- **削除** でファイル削除

---

## データ保存先

- `PROMPTS_DIR=/data/prompts`
- `SETTINGS_FILE=/data/settings.json`

`/data` は bind mount による永続化が前提です。
