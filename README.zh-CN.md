![Mission Control — OpenClaw GUI 与 AI 智能体仪表盘](cover.png)

# Mission Control（任务控制中心）

[English](README.md) | **中文** | [日本語](README.ja.md)

**你的 [OpenClaw](https://github.com/openclaw) 指挥中心。一屏总览，一键掌控。**

实时监控你的 AI 智能体、与它们对话、调度定时任务、追踪费用、管理记忆 —— 一切在浏览器中完成，一切在你自己的设备上运行。

## ⚡ 让 AI 智能体帮你安装 —— 复制、粘贴、完成

在用 Claude Code、Codex、或 OpenClaw 本身？把下面这段粘贴给它，剩下的交给智能体：

```text
在这台机器上安装 Mission Control（OpenClaw 的仪表盘）。

1. 检查前提：`node --version` 必须 >= 20，`openclaw --version` 必须可用。
   如果没装 OpenClaw，先按 https://docs.openclaw.ai/install 安装并完成初始化。
2. 安装：
     cd ~/.openclaw
     git clone https://github.com/robsannaa/openclaw-mission-control.git
     cd openclaw-mission-control
     ./setup.sh
   （setup.sh 失败后可安全重跑。）
3. 如果 3333 端口被占用，改用：PORT=3344 ./setup.sh
4. 验证：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3333`
   必须输出 200（用你实际选择的端口）。
5. 该检查通过前不要结束任务；完成后告诉我打开哪个 URL，
   以及后台服务是如何注册的（launchd/systemd/nohup）。
```

## 如果觉得好用，欢迎请我喝杯咖啡（或买个 Claude Code 订阅）！
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-orange?logo=buy-me-a-coffee)](https://www.buymeacoffee.com/robsanna)

---

## 为什么选择 Mission Control？

**告别多个终端窗口。** 如果你在用 OpenClaw，你已经了解它的强大。Mission Control 给你全局视野 —— 在一个地方看到智能体在做什么、花了多少钱、系统是否健康。

**数据不出你的机器。** Mission Control 完全本地运行。没有云端账户、没有遥测上报。它只是一扇窗，通向你机器上已经在运行的 OpenClaw 系统。

**开箱即用。** 安装后打开浏览器即可。Mission Control 自动发现你的 OpenClaw 环境 —— 无需配置文件，无需搭建数据库。

---

## 「薄层」哲学

Mission Control **不是**一个独立平台。它不保存你的数据副本，也不试图成为「事实来源」。

它是通向 OpenClaw 的**透明窗口**。屏幕上的每个数字、每个状态都实时来自你正在运行的 OpenClaw。你在 Mission Control 里做的每个修改都直接写入 OpenClaw —— 没有同步延迟，没有过期缓存。（Mission Control 自身只保留极少量本地文件：用量历史和看板数据，绝不复制你的 OpenClaw 数据。）

**这对你意味着：**
- **永远准确** —— 你看到的就是正在发生的
- **零维护** —— 没有数据库迁移、没有备份脚本
- **坏不了** —— 就算 Mission Control 挂了，你的智能体照常运行

就像汽车的仪表盘：显示速度、油量、引擎状态 —— 但拆掉它，车照样能开。

---

## 功能一览

### 一眼看清全局
**仪表盘**打开即见实时总览 —— 活跃的智能体、网关健康状态、运行中的定时任务、系统资源（CPU、内存、磁盘）。

### 与智能体对话
**聊天**让你在浏览器里直接与任意智能体交谈。支持附件、选择模型、流式回复，切换智能体不丢上下文。

### 可视化管理工作
**任务**是内置看板（待办、进行中、评审、完成），与工作区同步。拖拽卡片，掌握进度。

### 想调度什么都行
**定时任务**支持「每天早上总结我的收件箱」这类周期任务。创建、编辑、暂停、测试，完整运行历史一目了然。

### 花了多少钱，清清楚楚
**用量**追踪每个模型、每个智能体的每一个 token。图表化的费用拆解，一眼看出谁在烧预算。

### 管理你的智能体团队
**智能体**以交互式组织架构图展示全部智能体 —— 谁在线、连了哪些渠道、用哪个工作区，随时启停子智能体。

### 保持记忆敏锐
**记忆**可查看和编辑智能体的长期记忆与日志。**向量搜索**让你即刻找到语义记忆里的任何内容。

### 管理模型与密钥
**模型**在一处集中查看所有可用 AI 模型、配置提供商凭证、设置回退链、按智能体切换模型。不用再手改配置文件。

### 健康监控
**诊断**运行体检并指出问题所在，常见问题一键修复。**网关**状态始终可见。

### 内置终端
**终端**在仪表盘里给你完整命令行 —— 多标签、彩色输出，无需切换窗口。

### 连接消息渠道
**渠道**配置智能体与 Telegram、Discord、WhatsApp、Signal、Slack 的连接，支持二维码配对。

### 浏览文件
**文档**浏览所有工作区文件。**搜索**（`Cmd+K`）全局语义搜索。

### 安全为先
**安全**审计你的配置并标记问题。**权限**控制智能体可以执行什么。**账户与密钥**统一管理所有凭证。

### 远程访问
**Tailscale** 集成让你从任何地方安全访问仪表盘和智能体。

### 崩溃隔离
每个板块都有**错误边界** —— 一个视图出问题，其余照常工作。

---

## 快速开始

### 1. 确认已安装 OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw --version
```

### 2. 安装 Mission Control

```bash
cd ~/.openclaw
git clone https://github.com/robsannaa/openclaw-mission-control.git
cd openclaw-mission-control
./setup.sh
```

完成。浏览器打开 `http://localhost:3333`。

**其他启动方式：**

```bash
# 换端口
PORT=8080 ./setup.sh

# 开发模式（不注册后台服务）
./setup.sh --dev --no-service

# 手动模式
npm install && npm run dev
```

> **零配置。** Mission Control 自动找到你的 `~/.openclaw` 目录和 `openclaw` 命令。

### 让你的智能体替你安装

已经在和 OpenClaw 智能体聊天？直接说：

```
帮我安装 Mission Control，仓库在这里：
https://github.com/robsannaa/openclaw-mission-control
```

---

## 远程访问

OpenClaw 跑在服务器上？用 SSH 隧道从笔记本访问：

```bash
ssh -N -L 3333:127.0.0.1:3333 user@your-server
```

然后在本地打开 `http://localhost:3333`。

---

## 环境变量（可选）

一切自动检测，需要时可覆盖：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `OPENCLAW_HOME` | `~/.openclaw` | OpenClaw 数据目录 |
| `OPENCLAW_BIN` | 自动检测 | `openclaw` 命令路径 |
| `OPENCLAW_WORKSPACE` | 自动检测 | 默认工作区目录 |
| `OPENCLAW_TRANSPORT` | `auto` | 网关连接方式：`auto`、`http` 或 `cli` |
| `OPENCLAW_GATEWAY_URL` | `http://127.0.0.1:18789` | 网关地址（远程部署用） |
| `OPENCLAW_GATEWAY_TOKEN` | _（空）_ | 网关 HTTP 认证令牌 |

---

## 常见问题

<details>
<summary><strong>提示「OpenClaw not found」怎么办？</strong></summary>

先确认终端里 `openclaw --version` 能正常执行。如果可以但仪表盘仍报错，直接指定路径：

```bash
OPENCLAW_BIN=$(which openclaw) npm run dev
```

还没安装 OpenClaw？[点这里安装](https://docs.openclaw.ai/install)。
</details>

<details>
<summary><strong>我的数据会被发送到别处吗？</strong></summary>

Mission Control 自身不向任何地方发送数据 —— 没有统计、没有追踪。唯一的网络请求是你自己配置的：你的 OpenClaw 网关，以及你选择的 AI 模型提供商（包括完全本地的模型）。
</details>

<details>
<summary><strong>能同时管理多套 OpenClaw 吗？</strong></summary>

可以，指向另一个安装即可：

```bash
OPENCLAW_HOME=/path/to/other/.openclaw npm run dev -- --port 3001
```
</details>

<details>
<summary><strong>端口被占用？</strong></summary>

```bash
npm run dev -- --port 8080
```
</details>

---

## 参与贡献

欢迎 Pull Request。发现 bug 或有想法？[提交 issue](https://github.com/robsannaa/openclaw-mission-control/issues)。

---

## 许可证

MIT
