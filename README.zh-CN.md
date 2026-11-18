# Infinity

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/sakura-infinity)](https://www.npmjs.com/package/sakura-infinity)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-3c873a)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**多个 Coding Agent 做同一个任务。每次尝试都会评分，你保留最好的结果。**

Infinity 让 1 到 100 个 Agent 并行处理同一个任务，并用你的评测程序给每次提交打分：可以是模型在隐藏数据上的准确率、程序的运行速度、一个 loss，或者一个 Lean 4 证明。它基于 [Sakura](https://github.com/Vist233/Sakura)（一个你可以在其上构建的完整 Coding Agent）构建，在 npm 上发布为 `sakura-infinity`。

## 为什么是 Infinity

多跑几个 Agent 很容易，让它们真正多产出却不容易。Agent 大部分时间在等模型回复，而训练模型、跑测试却要占用 CPU。Infinity 把这两件事分开：**有多少个 Agent 在探索，和同时跑多少个重型任务，是两个独立的上限。**

在一组 16 vCPU 的容量实验里（共约 4.5 小时），只增加 Agent 数量时，`load/core` 从 1.63 升到 1.97，分数没有稳定提升。16 个 Agent 共用 8 个重型任务槽位后，`load/core` 降到约 1.02，首个评分结果从 29.3 分钟提前到 16.5 分钟。GPU 利用率接近 0%：这个任务的瓶颈是 CPU。这是一台机器上一个任务的结果，不是保证。

## 快速开始

需要 Node 22.18 或更新版本，以及 DeepSeek、OpenAI 或 Anthropic 的 API Key。数学任务还需要 Lean 4（`curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`）；代码任务需要你的评测程序用到的环境（模板用 Python）。

```sh
npm install -g sakura-infinity
export DEEPSEEK_API_KEY=...   # 或 INFINITY_PROVIDER=openai 加 OPENAI_API_KEY，或 anthropic 加 ANTHROPIC_API_KEY

infinity run math-parity --agents 3 --view   # 自带示例：证明 "n % 2 = 0 or n % 2 = 1"；第一个证明被接受时结束

infinity new code my-task                    # 生成 my-task/task.mts（任务表单）和 my-task/evaluate.py（示例评分程序）
# 修改 task.mts 里的提示和 evaluate.py 里的评分，然后：
infinity run ./my-task --agents 4 --wall-minutes 30 --view
```

`--view` 会在 `http://127.0.0.1:4173/` 打开运行页面：最上面是最好的结果（分数、Agent、提交、目录），然后是时间和 token 与上限的对比、分数随时间的变化和各个 Agent。`infinity --help` 列出所有参数；`infinity recommend --write machine.json` 保存这台电脑能承载多少。

API Key 只从环境变量读取一次，读完就从环境中移除：Agent 运行的命令看不到它，它也不会被打印或写入文件。`INFINITY_MODEL` 可以选择同一供应商的其他模型。

## 一次运行是怎样进行的

- **任务就是一张表单。** 用文字写清问题、Agent 能看到什么、什么是隐藏的，再加一个给提交打分的程序。这台电脑能承载多少，写在单独的机器文件里。任何"改进一个结果"的任务都适用。
- **两套工具。** `code` 预设给每个 Agent `read`、`write`、`edit`、`bash`、`submit` 和 `handoff`；一次提交包括命令、列出的文件和一个 Git 提交，由你的评测程序在 Agent 看不到的数据上打分。`math` 预设给文件工具和 `lean` 检查；Lean 验证器就是评测程序，第一个证明被接受时运行结束。
- **Agent 数量逐级增加。** 运行从一个 Agent 开始，模型供应商不限流时逐级翻倍（1、2、4……直到你设的上限）；遇到限流就降一级，配额用完就停止。
- **重型任务有槽位。** CPU 槽位（`--slots N`）、评测槽位、Lean 槽位和 GPU 槽位限制同时运行的重型任务数，与 Agent 数量无关。
- **隐藏数据保持隐藏。** Agent 工作时，标签被移到一个私有路径并记下日志，结束时放回原处；按 Ctrl-C 或崩溃时也会放回。
- **一切都是文件。** 每个 Agent 在自己的 Git 目录里工作，每轮结束都提交一次；账本、事件、排行榜和报告都写在运行目录里，查看页面只读取它们。
- **停止条件。** 第一个证明、目标分数、token 预算、运行时间、配额，或者你手动停止。

## 基于 Sakura

每个 Agent 都是一个 Sakura Agent，有自己的工作目录、会话文件、工具和目标。两种 Reviewer 用到了 Sakura 的组合能力：

- **安全审查。** 由 Sakura 的审查插件判断有风险的命令；在它之前，Infinity 自己的规则会拒绝推送、ssh、上传、按名字杀进程、读凭据文件、访问隐藏数据、进入其他 Agent 的目录和改动运行自身的文件。在任务里写 `review: false` 可以关掉它，报告里会注明。
- **Branch Review（可选）。** 每隔几分钟，把一个 Agent 的会话 fork 成一个 Reviewer。它用同样的模型、系统提示和工具声明，所以供应商的缓存仍然有效；但 Guard 只允许它 `read` 这个 Agent 目录里的文件。它回答 `OK` 或给出简短建议，建议会注入这个 Agent，并标明不是来自用户。调度、结果和生命周期是 Infinity 的代码；Sakura 提供会话 fork、装配、插件和执行边界。它的收益还没有测量过，而且要花 token（在一次真实运行里约占一半）；`--no-review` 可以不用它。

## 你自己的任务

```sh
infinity recommend --write machine.json   # 这台电脑能承载多少（Agent、槽位、线程）；可以手动修改
infinity new code my-task                 # 或者：infinity new math my-statement
infinity run ./my-task --machine machine.json --view
```

表单的字段和写好评测程序的规则见 [AGENT-GUIDE.md](AGENT-GUIDE.md)，它是写给同样会运行 Infinity 的 AI 或脚本看的。[`tasks/covertype/task.ts`](tasks/covertype/task.ts) 是一个完整的真实例子：预测森林覆盖类型（7 类），按隐藏标签上的准确率打分。

## 运行结果

每次运行写入 `runs/<task>-<time>/`：

| 文件 | 内容 |
|---|---|
| `report/report.html` | 排行榜、分数随时间的变化、审查记录、警告 |
| `report/leaderboard.csv` | 每个评分结果一行：Agent、分数、提交、工作目录 |
| `ledger.jsonl` | 每个 Agent 做了什么；`result` 行是提交 |
| `events.jsonl` | 级数变化、限流、审查、拒绝、警告、`run_end` |
| `machine.jsonl` | 每 5 秒一次的机器读数（仅 Linux） |
| `agents/NNN/work/` | 每个 Agent 一个 Git 仓库；最好的方案是排行榜第一行指向的提交 |

最后打印的一行是运行结果，例如 `{"reason":"target","tokensUsed":8781,"bestScore":1}`。

- **查看页面。** `infinity view runs` 为正在运行或已结束的运行提供一个只读页面。它只绑定 `127.0.0.1`，只响应 GET，从不写入运行目录。在远程机器上可以转发端口（`ssh -L 4173:127.0.0.1:4173 host`），或者用 `--host 0.0.0.0 --token <secret>` 分享给别人。
- **停止。** Ctrl-C、SIGTERM 或 `stop()` 会按顺序停止 Agent、放回隐藏标签并写出报告。`--wall-minutes N` 和 `--tokens N` 设置上限。
- **续接。** `infinity run <task> --resume runs/<run> <同样的参数>` 重新打开会话和工作目录。被强制结束（`kill -9`、断电）之后，先在克隆的仓库里放回隐藏标签：`node examples/recover-hidden.ts runs/<run>/.keeper`。

## 从代码或 Agent 中使用

```ts
import { startRun } from "./src/launch.ts";
import { createInfinityTools } from "./src/sakura-tools.ts";
import { formPackage } from "./src/form.ts";
import form from "./tasks/covertype/task.ts";

const covertype = formPackage(form, "./tasks/covertype");
const run = await startRun(covertype, { model, agents: 8, wallMinutes: 45 }); // 立即返回；运行在当前进程里继续
console.log(run.status());                                                     // 状态、存活的 Agent、token、最好分数
await run.stop();                                                              // 按顺序结束运行并等待

// 把 infinity_run、infinity_status、infinity_stop 和 infinity_recommend 作为工具交给一个 Sakura Agent
const tools = createInfinityTools({ packs: [covertype], model });
```

这些 import 在克隆的仓库里可用。

## 限制

- **完整功能需要 Linux。** 在 macOS 上可以运行，但不支持机器读数、命令限制和清理残留进程；报告里会注明。
- **没有沙箱。** Agent 运行的代码和 Lean 证明文件拥有你这个用户的权限，包括网络。规则和审查只能降低风险，不能证明安全。请在丢了文件也无所谓、主目录里没有密钥的机器上运行。
- **隐藏标签没有在操作系统层面封锁。** 运行期间它们被移到一个难以猜到的路径；Shell 能读到你这个用户能读的任何东西。
- **尚未验证：** macOS 上超过 8 个 Agent 的运行、真实硬件上的 GPU 槽位，以及 Branch Review 的收益。

<details>
<summary>Lean 的安全</summary>

证明文件就是程序：Lean 在编译时会运行代码（`#eval`、宏、`initialize`）。默认没有沙箱，而是这样处理：Lean 进程只拿到干净的环境变量（只有 `PATH`、`HOME`、`LEAN_PATH`，没有密钥）；数学任务的 Agent 没有 Shell，文件工具被限制在它的工作目录里；`submit` 时用一份黑名单拒绝 `#eval`、宏、`elab`、`initialize`、`unsafe`、`extern` 和其他 import（这不是边界）。在任务里写 `sandbox: true` 会在 macOS 上用 `sandbox-exec` 限制每个 Lean 进程；这个版本在 Linux 上没有沙箱。

只有同时满足以下条件，证明才会被接受：能编译、没有 `sorry`、只依赖 `propext`、`Classical.choice` 和 `Quot.sound`，并且 `theorem main` 的类型恰好是 `Statement.Goal`。

</details>

## 开发

```sh
git clone https://github.com/Vist233/infinity_Agents.git infinity-agent
cd infinity-agent
npm ci
npm run check            # 类型、lint、格式、测试（约 3 分钟；装了 Lean 时会用真实的 Lean）
node bin/infinity.ts run math-parity --agents 1
```

在克隆的仓库里，用 `node bin/infinity.ts` 代替 `infinity`。Covertype 示例需要先运行 `python3 -m venv .venv-ml && .venv-ml/bin/pip install numpy pandas scikit-learn`，再运行一次 `.venv-ml/bin/python tasks/covertype/prepare.py 150000`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
