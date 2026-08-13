![Mission Control — AI エージェント Harness とダッシュボード](cover.png)

# Mission Control（ミッションコントロール）

[English](README.md) | [中文](README.zh-CN.md) | **日本語**

**AI エージェントの艦隊を、ひとつの画面から動かすための harness。すべてを見て、すべてを差配する。全部あなたのマシン上で。**

私はエージェントを大量に、同時に走らせています。1体はコードを書き、1体はリサーチを掘り、1体は受信箱を見張り、あとの数体は朝に投げた仕事をこなしている。2〜3体を超えると、ターミナルはもう使える UI ではなくなります。だから自分用の harness を作りました。それがこれです。

Mission Control はその艦隊の上に立つコントロールプレーンです。エージェントが働く様子をリアルタイムで眺め、タスクを渡して自分で拾わせ、サブエージェントを立ち上げて展開し、かかったコストを見て、全体を健全に保つ。ローカルで動き、下では [OpenClaw](https://github.com/openclaw) をエンジンとして駆動します。

## ⚡ エージェントに渡してインストールさせる

今どき手作業でインストールなんてしません。Claude Code、Codex、あるいは普段使っている何かを下のテキストに向ければ、あとは全部やってくれます：

```text
Install Mission Control, the dashboard for OpenClaw, on this machine.

1. Check prerequisites: `node --version` must be >= 20, and `openclaw --version`
   must work. If OpenClaw is missing, install it first per
   https://docs.openclaw.ai/install and complete its onboarding.
2. Install:
     cd ~/.openclaw
     git clone https://github.com/robsannaa/openclaw-mission-control.git
     cd openclaw-mission-control
     ./setup.sh
   (setup.sh is safe to re-run if anything fails.)
3. If port 3333 is already taken, re-run as: PORT=3344 ./setup.sh
4. Verify it works: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3333`
   must print 200 (use the port you chose).
5. Do not finish until that check passes, then tell me the exact URL to open
   and how the background service was registered (launchd/systemd/nohup).
```

この多くは、これが動かしているエージェント自身が書いたものです。それこそが狙いです。

## よければ支援してください。Claude Code のサブスクを奢ってくれると嬉しいです！
[![Buy Me a Claude Code Subscription!](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-orange?logo=buy-me-a-coffee)](https://www.buymeacoffee.com/robsanna)

[![AI Agent Harness](https://img.shields.io/badge/AI_Agent-Harness-7c3aed?style=flat-square)](https://github.com/robsannaa/openclaw-mission-control) ![Self-Hosted](https://img.shields.io/badge/Self--Hosted-Local_AI-f59e0b?style=flat-square) ![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## なぜ作ったのか

エージェントが2〜3体を超えると、ボトルネックはモデルではなくあなた自身になります。ターミナルを行き来し、何が走っているか見失い、いくらかかったか分からなくなる。harness があればそれが解けます。エージェントを問題に向け、ボードに置き、あとは走らせたまま次に取りかかる。

harness が一番面白い部分になってはいけません。主役はエージェントです。Mission Control は彼らの背後に控えて邪魔をしないように作ってあります。世話するものもなく、同期するものもなく、壊れにくい。存在を忘れて、ただ出荷し続けられるべきです。

---

## あえて薄く

Mission Control はあなたのデータを保存せず、データベースも持たず、「真実の源」になろうともしません。下のエンジンへ直接、リアルタイムに読み書きします。ここで何かを変えれば即座に反映され、同期のステップも、古くなるキャッシュもありません。自前で持つ状態は、使用履歴とタスクボードという2つの小さなローカルファイルだけです。

だからこうなります：

- **常に正確。** 見えているものが、まさに今走っているもの。
- **メンテが退屈。** マイグレーションもバックアップもクリーンアップも無し。狙い通り。
- **壊れにくい。** ダッシュボードが落ちても、エージェントは走り続ける。
- **即座。** プロビジョニング不要、バージョン間のアップグレードも不要。

ダッシュボードを外しても、艦隊は動き続けます。これはエンジンの上のガラスであって、エンジンそのものではありません。

---

## できること

### 艦隊の全体を見る
**ダッシュボード**は開いた瞬間にライブの全体像を出します。どのエージェントが稼働中か、ゲートウェイの健全性、走っている cron ジョブ、システム負荷（CPU・メモリ・ディスク）。あちこちクリックせずとも、正常かどうか分かります。

### どのエージェントとも話す
**チャット**はブラウザ内で任意のエージェントとの本物の会話です。ファイルを添付し、モデルを選び、返答をストリームし、コンテキストを失わずに切り替える。`/` でコマンド、`@` でファイルを引き込む。

### エージェントを仕事に向け、進むのを見る
**タスク**はボード（バックログ／進行中／レビュー／完了）ですが、カードは付箋ではなく、エージェントが実際に走らせる仕事です。放り込めばエージェントが拾い、「完了」まで横断していくのを眺める。「エージェントを数体、問題に向けて放つ」が、目に見える形になります。

### いない間もエージェントを働かせる
**Cron ジョブ**はエージェントをスケジュールで動かします。毎朝、受信箱を要約。1時間ごとに更新を確認。作成・編集・一時停止・テストができ、完全な実行履歴で昨夜何が起きたか正確に分かります。

### チームを指揮する
**エージェント**は階層全体をライブな組織図として見せます。各エージェントとサブエージェント、誰が稼働中か、どのチャンネルにいるか、どのワークスペースか。新しいサブエージェントをその場で立ち上げ、展開できます。

### コストをトークン単位で知る
**使用量**はモデルごと・エージェントごとの全トークンを追跡します。コスト内訳、予算を食っているエージェント、お金の行き先。スプレッドシートではなくチャートで。

### 記憶を鋭く保つ
**メモリ**で長期記憶と日次ジャーナルを閲覧・編集。**ベクター検索**でセマンティック記憶の中身を即座に見つけます。

### モデルとキーを掌握する
**モデル**は一箇所で、利用可能な全モデルの確認、プロバイダー認証情報の設定、フォールバックチェーンの構成、エージェントごとの切り替えを行います。設定ファイルの手編集は不要。

### 艦隊を健全に保つ
**Doctor** が診断を走らせ、何が健全で何に注意が必要かを示し、よくある問題はワンクリックで修正。**ゲートウェイ**のステータスは常時表示され、接続状態が一目で分かります。

### シェルに入る
**ターミナル**はダッシュボード内のフル機能コマンドライン。複数タブ、カラー対応、ウィンドウ切り替え不要。

### すでにいる場所でエージェントに届く
**チャンネル**でエージェントを Telegram・Discord・WhatsApp・Signal・Slack に接続。対応する場所では QR ペアリングで。

### 触れたものすべてを閲覧
**ドキュメント**で各エージェントのワークスペースファイルを探索。**検索**（`Cmd+K`）で全体をまたぐ即時セマンティック検索。

### 常に主導権を
**セキュリティ**が設定を監査し問題を洗い出す。**権限**でエージェントが実行してよいことを制御。**アカウントとキー**で全認証情報を一箇所に、適切なマスキングつきで管理。

### どこからでも動かす
**Tailscale** 連携で、どのマシンからでもダッシュボードとエージェントに安全にアクセス。トンネル制御も内蔵。

### 一部が落ちても、全部は落ちない
各セクションは**エラーバウンダリ**で包まれています。1つのビューが壊れても、残りは走り続けます。再試行を押せば戻り、ページ全体の再読み込みは不要です。

---

## クイックスタート

### 1. エンジンが入っているか確認

```bash
# Install OpenClaw if you haven't already
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify it's running
openclaw --version
```

### 2. Mission Control をインストール

```bash
cd ~/.openclaw
git clone https://github.com/robsannaa/openclaw-mission-control.git
cd openclaw-mission-control
./setup.sh
```

これだけ。`http://localhost:3333` を開きます。

**その他の起動方法：**

```bash
# Change the port
PORT=8080 ./setup.sh

# Development mode (no background service)
./setup.sh --dev --no-service

# Manual mode
npm install && npm run dev
```

> **設定ゼロ。** `~/.openclaw` ディレクトリと `openclaw` バイナリを自分で見つけます。セットアップ不要。

### あるいは、エージェントに任せる

すでにエージェントと話している？そのまま渡してください：

```
Hey, install Mission Control for me — here's the repo:
https://github.com/robsannaa/openclaw-mission-control
```

クローンして、依存関係を入れて、起動までやってくれます。

---

## リモートアクセス

サーバーで動かしている？SSH トンネルでノートPCから届きます：

```bash
ssh -N -L 3333:127.0.0.1:3333 user@your-server
```

そのうえでローカルで `http://localhost:3333` を開きます。

---

## 環境変数（任意）

すべて自動検出されます。必要なら上書きしてください：

| 変数 | デフォルト | 役割 |
|---|---|---|
| `OPENCLAW_HOME` | `~/.openclaw` | エージェントデータの場所 |
| `OPENCLAW_BIN` | 自動検出 | `openclaw` コマンドのパス |
| `OPENCLAW_WORKSPACE` | 自動検出 | デフォルトのワークスペースフォルダ |
| `OPENCLAW_TRANSPORT` | `auto` | ゲートウェイへの接続方法：`auto`、`http`、`cli` |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | ゲートウェイのアドレス（リモート構成用） |
| `OPENCLAW_GATEWAY_TOKEN` | _（空）_ | 認証付き HTTP アクセス用の Bearer トークン |
| `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS` | _（未設定）_ | `1` にすると CLI がプライベート／自己署名の WebSocket エンドポイント（例：ローカルゲートウェイの `ws://`）へ接続できます。Mission Control は CLI 呼び出し時にこれを設定します。挙動を変えたい場合のみ上書きしてください。 |

---

## FAQ

<details>
<summary><strong>「OpenClaw not found」と出たら？</strong></summary>

まずターミナルで `openclaw` コマンドが動くか確認：

```bash
openclaw --version
```

動くのにダッシュボードが文句を言うなら、直接パスを指定：

```bash
OPENCLAW_BIN=$(which openclaw) npm run dev
```

未インストールなら、[こちらから](https://docs.openclaw.ai/install)。
</details>

<details>
<summary><strong>データはどこかに送られますか？</strong></summary>

いいえ。Mission Control は何も送りません。解析なし、トラッキングなし、ホームへの通信なし。ネットワーク通信はあなたが構成したものだけ：あなたのゲートウェイと、あなたが設定したモデルプロバイダー（完全ローカルのモデルを含め、あなたが選びます）。
</details>

<details>
<summary><strong>複数のセットアップを扱えますか？</strong></summary>

はい。別のインストールを指すだけ：

```bash
OPENCLAW_HOME=/path/to/other/.openclaw npm run dev -- --port 3001
```
</details>

<details>
<summary><strong>ポートが使用中？</strong></summary>

別のポートを選んでください：

```bash
npm run dev -- --port 8080
```
</details>

---

## コントリビュート

プルリクエスト歓迎。バグやアイデアがあれば、[Issue を立ててください](https://github.com/robsannaa/openclaw-mission-control/issues)。

---

## ライセンス

MIT
