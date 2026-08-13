![Mission Control — AI 智能体 Harness 与仪表盘](cover.png)

# Mission Control（任务控制中心）

[English](README.md) | **中文** | [日本語](README.ja.md)

**一套用来在一块屏幕上驾驭 AI 智能体舰队的 harness。看见一切、调度一切，全部跑在你自己的机器上。**

我同时跑着很多智能体。一个在写代码，一个在翻研究资料，一个盯着收件箱，还有几个在做我早上随手交代的活儿。超过两三个，终端就不再是一个能用的界面了。于是我给自己造了这套 harness。就是它。

Mission Control 是这支舰队之上的控制面。实时看着智能体干活、把任务丢给它们让它们自己接手、随手拉起子智能体并把它们铺开、看清每一分花费、让整支舰队保持健康。它跑在本地，底层由 [OpenClaw](https://github.com/openclaw) 作为引擎驱动。

## ⚡ 交给你的智能体来安装

现在谁还手动装东西。把 Claude Code、Codex，或者你惯用的任何工具指向下面这段，剩下的它自己搞定：

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

这里面有相当一部分，是由它所驱动的这些智能体写出来的。这正是它存在的意义。

## 请考虑支持我，给我买一份 Claude Code 订阅！
[![Buy Me a Claude Code Subscription!](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-orange?logo=buy-me-a-coffee)](https://www.buymeacoffee.com/robsanna)

[![AI Agent Harness](https://img.shields.io/badge/AI_Agent-Harness-7c3aed?style=flat-square)](https://github.com/robsannaa/openclaw-mission-control) ![Self-Hosted](https://img.shields.io/badge/Self--Hosted-Local_AI-f59e0b?style=flat-square) ![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## 为什么会有它

超过两三个智能体之后，瓶颈就不再是模型，而是你自己。你在一堆终端之间切来切去，记不清什么还在跑，也猜不出花了多少钱。一套 harness 就能解决这件事。你把一个智能体指向某个问题，丢到看板上，然后转身去开下一个，它自己会跑。

harness 永远不该是最有意思的那部分。智能体才是正事。Mission Control 被造来待在它们身后、不碍事：没有东西要照看，没有东西要同步，也很难弄坏。你应该能忘了它的存在，只管一路往前发货。

---

## 刻意做薄

Mission Control 不存你的数据、不跑数据库，也不试图成为“真相之源”。它直接读写底层引擎，实时进行。你在这里改一下，立刻生效，没有同步步骤，也没有会过期的缓存。它自己只保留两个很小的本地文件：用量历史和任务看板。

这样一来，它：

- **永远准确。** 你看到的，就是此刻真正在跑的。
- **维护起来无聊。** 没有迁移、没有备份、没有清理任务。故意如此。
- **很难弄坏。** 仪表盘挂了，智能体照样继续跑。
- **即刻可用。** 无需预置，版本间也无需升级。

把仪表盘拆掉，舰队照样运转。它是引擎之上的那块玻璃，不是引擎本身。

---

## 它能做什么

### 看清整支舰队
**仪表盘**打开就是实时总览：哪些智能体在活动、网关是否健康、哪些定时任务在跑、系统负载（CPU、内存、磁盘）。不用到处点，就知道一切是否正常。

### 和它们任何一个对话
**聊天**是在浏览器里与任意智能体的真正对话。附加文件、挑选模型、流式回复、切换智能体也不丢上下文。`/` 唤出命令，`@` 引入文件。

### 把智能体指向工作，看着它推进
**任务**是一块看板（待办、进行中、评审、完成），但这里的卡片不是便利贴，而是一个智能体真正会去跑的活儿。丢进去，一个智能体接手，你看着它横穿到“完成”。所谓“把几个智能体指向问题然后放手”，在这里变成看得见的东西。

### 让智能体在你不在时继续干
**定时任务**让智能体按计划工作：每天早上总结收件箱，每小时查一次更新。创建、编辑、暂停、测试，带完整运行历史，你能确切知道昨夜发生了什么。

### 指挥这支团队
**智能体**把整个层级画成一张实时组织图：每一个智能体和子智能体、谁在活动、连着哪些渠道、在哪个工作区。随手拉起新的子智能体，当场把它们铺开。

### 精确到每个 token 的花费
**用量**追踪每个模型、每个智能体上的每一个 token。费用拆解、哪个智能体在烧预算、钱到底花在了哪儿。用图表，不是电子表格。

### 让它们的记忆保持锋利
**记忆**查看并编辑长期记忆和每日日志。**向量搜索**瞬间在语义记忆里找到任何东西。

### 掌控模型与密钥
**模型**把一切集中到一处：查看所有可用模型、配置供应商凭证、设置回退链、按智能体切换模型。不用再手改配置文件。

### 让舰队保持健康
**Doctor** 跑诊断，明确告诉你什么健康、什么需要关注，常见问题一键修复。**网关**状态始终可见，你随时知道它是否连通。

### 进一个 shell
**终端**在仪表盘里给你一个完整命令行：多标签、彩色支持，不用切窗口。

### 在你已在的地方触达它们
**渠道**把你的智能体接到 Telegram、Discord、WhatsApp、Signal 和 Slack，支持的地方用二维码配对。

### 浏览它们碰过的一切
**文档**浏览各智能体的工作区文件。**搜索**（`Cmd+K`）对全部内容做即时语义搜索。

### 始终掌控
**安全**审计你的配置并标出问题。**权限**控制智能体被允许执行什么。**账户与密钥**在一处管理每一份凭证，并妥善打码。

### 从任何地方运行它
**Tailscale** 集成让你从任意机器安全地访问仪表盘与智能体，隧道控制内建其中。

### 一处出问题，不会拖垮全部
每个板块都包在**错误边界**里。一个视图坏了，其余照常运行。点一下重试就回来，无需整页刷新。

---

## 快速开始

### 1. 先确保引擎已装好

```bash
# Install OpenClaw if you haven't already
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify it's running
openclaw --version
```

### 2. 安装 Mission Control

```bash
cd ~/.openclaw
git clone https://github.com/robsannaa/openclaw-mission-control.git
cd openclaw-mission-control
./setup.sh
```

就这样。打开 `http://localhost:3333`。

**其他启动方式：**

```bash
# Change the port
PORT=8080 ./setup.sh

# Development mode (no background service)
./setup.sh --dev --no-service

# Manual mode
npm install && npm run dev
```

> **零配置。** 它会自己找到你的 `~/.openclaw` 目录和 `openclaw` 可执行文件。无需设置。

### 或者，直接让你的智能体来

已经在和某个智能体对话了？把活儿交给它：

```
Hey, install Mission Control for me — here's the repo:
https://github.com/robsannaa/openclaw-mission-control
```

它会克隆仓库、安装依赖并启动起来。

---

## 远程访问

跑在服务器上？用 SSH 隧道从笔记本触达：

```bash
ssh -N -L 3333:127.0.0.1:3333 user@your-server
```

然后在本地打开 `http://localhost:3333`。

---

## 环境变量（可选）

一切都会自动检测。需要时可以覆盖：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `OPENCLAW_HOME` | `~/.openclaw` | 你的智能体数据所在处 |
| `OPENCLAW_BIN` | 自动检测 | `openclaw` 命令的路径 |
| `OPENCLAW_WORKSPACE` | 自动检测 | 你的默认工作区目录 |
| `OPENCLAW_TRANSPORT` | `auto` | 如何连接网关：`auto`、`http` 或 `cli` |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | 网关地址（用于远程配置） |
| `OPENCLAW_GATEWAY_TOKEN` | _（空）_ | 通过 HTTP 访问网关的 Bearer 令牌 |
| `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS` | _（未设置）_ | 设为 `1` 以允许 CLI 连接私有/自签名的 WebSocket 端点（例如本地网关的 `ws://`）。Mission Control 在调用 CLI 时会设置它；仅在你需要不同行为时覆盖。 |

---

## 常见问题

<details>
<summary><strong>提示 “OpenClaw not found” 怎么办？</strong></summary>

先确认 `openclaw` 命令在终端里能用：

```bash
openclaw --version
```

如果它能用，但仪表盘仍然报错，就直接指定路径：

```bash
OPENCLAW_BIN=$(which openclaw) npm run dev
```

如果还没装，[点这里获取](https://docs.openclaw.ai/install)。
</details>

<details>
<summary><strong>它会把我的数据发到哪儿吗？</strong></summary>

不会。Mission Control 什么都不往外发：没有分析、没有追踪、不回传。唯一的网络请求，是你自己配置的那些：你的网关，以及你所设置的模型供应商（由你挑选，包括完全本地的模型）。
</details>

<details>
<summary><strong>可以同时管理多套安装吗？</strong></summary>

可以。指向另一份安装即可：

```bash
OPENCLAW_HOME=/path/to/other/.openclaw npm run dev -- --port 3001
```
</details>

<details>
<summary><strong>端口被占用了？</strong></summary>

换一个：

```bash
npm run dev -- --port 8080
```
</details>

---

## 参与贡献

欢迎提 PR。发现 bug 或有想法？[开个 issue](https://github.com/robsannaa/openclaw-mission-control/issues)。

---

## 许可证

MIT
