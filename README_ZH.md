<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

# dsh-auto-review-ww

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-202724)

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的沙箱优先 Auto Review。**
日常工作在真实的 `workspace-write` 沙箱内直接执行,**不经任何审核、不花一个审核 token**;
只有越出工作区的提权请求,才付出一次 LLM 评审。全程无人值守:审查器**绝不回退到人工**,
每次拒绝都会把原因发回给发起请求的 agent。

```text
任何工具调用
  ├─ workspace-write 沙箱内能完成?  → 直接执行,零审核、零 token
  └─ 请求越出沙箱                    → 一次提权评审
        low    → 放行
        medium → 实质判断(任务契合度、实际效果、可逆性)
        high   → 拒绝
        审查器自身故障 → fail closed,原因发布给 agent
```

> [!IMPORTANT]
> **请保持官方 `@deepseek-ai/dsh-experimental-auto-review` 行处于启用状态。**
> `auto` 是保留预设 id,运行时只能由官方行提供;最后一条 `permission/preset` 为 `auto`
> 的会话在没有它时无法冷打开。本插件与官方行共存:官方行拥有保留的 `auto` 状态,
> 本包拥有 `auto-review` 预设和它的审查器,双方互不注册对方身份。

## 为什么不用官方 Auto review?

官方实验版 Auto review 运行在 `danger-full-access` 底座上,审核伴随每个请求。本插件
选择相反的权衡:

| | 官方 Auto review | dsh-auto-review-ww |
| --- | --- | --- |
| 沙箱底座 | `danger-full-access`(无沙箱) | `workspace-write`(真实沙箱) |
| 审核触发 | 每个命令都审 | 仅越权提权 |
| Token 开销 | 每请求一次评审 | **沙箱内工作 0**;每次越权一份裁剪快照 |
| 一次性无人值守 | 可以,但一切都在无沙箱下运行 | 可以,且风险动作仍要过审 |
| 审查器故障 | 请求失败 | fail closed,**原因发布给 agent** |
| 预设来源 | 保留字 `auto`(官方行) | 普通行配置 `auto-review`,零私有常量 |
| 升级韧性 | 绑定官方行 | 不碰宿主私有常量;插件崩溃后预设仍可选(退化为人工审批) |

典型场景:想要一次性自主完成任务、不愿交出 `danger-full-access`、也不希望流程中间
停下来等人点确认。

## 安装

在 Harness 中打开 **Plugins → Add plugin**,输入:

```text
dsh-auto-review-ww
https://github.com/Andy-Xie-1145/dsh-auto-review-ww
```

或对 Web profile 执行:

```sh
dsh plugin --profile web add github:Andy-Xie-1145/dsh-auto-review-ww
```

然后完整重启 Harness,选择 **Auto review** 预设(普通条目 —— 客户端只对官方 `auto`
值做 EXP 徽章特判)。任意模型路由可用:默认审查器跟随会话自己的 provider 和 model;
可选的决策模型可以接管这条廉价路径(见下文)。

## 审查器如何判断

每次提权向会话自己的 provider/model 发送五段快照:

| 段 | 内容 |
| --- | --- |
| `REVIEW_POLICY` | 固定判断策略 |
| `ENVIRONMENT` | 会话 `cwd` |
| `PROJECT_INSTRUCTIONS` | 项目级约束文本 |
| `FILTERED_HISTORY` | 角色标注的历史:人类指令、父指令、checkpoint、事实(已执行的工具调用及其参数、问题卡片的人类答复) |
| `PENDING_ACTION` | 被审调用的准确内容:工具名、完整参数、工具 schema、提权理由 |

策略只问一个问题 —— *鉴于本会话可见的一切,这个调用现在该不该执行?* —— 并以封闭
JSON 协议作答 `{"risk":"low|medium|high","decision":"allow|deny","reason":"..."}`。
具体而言:

- 会话任务明显需要的动作,不需要额外的祝福仪式,
- 有授权但不该执行的动作,仍然拒绝,
- 声称目的与真实效果不符,拒绝,
- 效果不可知或与会话毫无关联,fail closed。

拒绝原因通过专用通道回传:一个 append-only 上下文块,相同拒绝的字节完全稳定 ——
重复拒绝不产生额外成本,也绝不破坏提示缓存。审查器自身故障同样发布稳定说明
("审查器故障,非风险裁决"),而不是无声拒绝。

## 决策模型审查器(可选,Beta)

**决策模型**(decision model)是校准过的分类器,不是聊天模型:给它一段 JSON 状态和
一组命名问题,它返回带概率的类型化答案,而不是生成文本。本插件支持两种协议 ——
它们是完全不同的服务:

| API id | 服务 | 端点 | 是/否问题类型 |
| --- | --- | --- | --- |
| `typesafe-system-one` | [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one)(Jev) | `POST <baseUrl>/systemone` | `type: "noul"` |
| `openai-decisions` | [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)(GPT-6 Luna) | `POST <baseUrl>/decisions` | `type: "predicate"` |

两者单次评审成本都远低于推理模型(目录价:Jev $42 / 十亿输入 token,GPT-6 Luna
$0.10 / 百万 —— 一次 1.5 万 token 的评审分别约 $0.0006 与 $0.0015),而决策模式就是
为了守住这个成本:**除非你主动打开下面的升级开关,否则一次聊天调用都不会发生**。

### 它如何判断

同一份冻结快照成为模型的 **state**(`cwd`、`project_instructions`、`history`、
`pending_action`),三个问题承载整个决策:

| 问题 | 类型 | 含义 |
| --- | --- | --- |
| `authorized` | 是/否 | 这个精确的调用(目标与范围)是否属于本会话人类委托的工作? |
| `risk` | 选择 `low`/`medium`/`high` | 如果判断错了,最坏会造成多大破坏? |
| `objection` | 选择 | 不该执行时,最强反对理由是哪一类? |

`objection` 的选项会变成面向 agent 的拒绝理由(分类器自己写不出句子),并与校准概率
一起呈现。策略保留聊天审查器的全部安全不变量:

- `high` 风险永远拒绝,即使授权概率高达 99%;
- allow 只允许 `low`/`medium`,deny 只允许 `medium`/`high`;
- 概率落在 deny 与 allow 两个阈值之间时**绝不**放行 —— 默认 fail closed(除非你
  打开下面的升级开关)。

### 取舍开关(默认全关)

决策模式就是图便宜,所以默认**不调用聊天模型**:不确定裁决、状态被裁剪、服务故障、
`medium` 拒绝,全部在本地决定,只花决策调用本身的钱。每一项质量升级都是显式选项,
只为你在意的那一项付费:

| 开关 | 默认 | 买到什么 | 代价 |
| --- | --- | --- | --- |
| `escalate: chat` | `deny` | 不确定裁决或决策服务故障改由聊天模型复核,而不是 fail closed | 每次不确定/失败调用一次聊天评审 |
| `confirmDenials: true` | `false` | `medium` 拒绝获得实质理由,错误的廉价拒绝可被推翻 | 每次 `medium` 拒绝一次聊天评审 |
| `escalateOnTruncation: true` | `false` | 历史被裁剪过时,改由能读完整上下文的审查器裁决 | 每次裁剪状态一次聊天评审 |

取舍权在你:全关最便宜;只打开与你工作负载相关的那一项。无论开关如何,`high` 风险
永远拒绝且不可被推翻。

### 配置

在本包的 `cordis.patch.yml` 中给插件行加 `config` 块(`AUTO_REVIEW_WW_*` 环境变量
可覆盖,便于不重启处理运维):

```yaml
- insert:
    - id: auto-review-ww
      name: dsh-auto-review-ww
      config:
        mode: auto                    # auto | chat | decision
        decision:
          api: typesafe-system-one    # typesafe-system-one | openai-decisions
          model: jev-latest           # 默认:jev-latest / gpt-6-luna
          apiKeyEnv: TYPESAFE_API_KEY # 或 OPENAI_API_KEY
          allowThreshold: 0.85        # 概率达到该值才放行
          denyThreshold: 0.20         # 概率低于该值直接拒绝
          escalate: deny              # deny:不确定时不再花钱(默认)
                                      # chat:不确定/失败改由聊天复核
          confirmDenials: false       # true:medium 拒绝由聊天审查器给出理由
          escalateOnTruncation: false # true:被裁剪过历史时改由聊天审查器裁决
          maxStateChars: 90000        # 状态预算(Jev);GPT-6 Luna 默认 600000
          timeoutMs: 20000            # 决策调用超时
```

`mode: chat` 就是原始的聊天审查器,保持完全不变且仍是默认。`mode: auto` 只有在存在
API key 时才启用决策审查器,因此已安装的实例在配置 key 之前行为完全不变;
`mode: decision` 强制使用决策模型,缺 key 时在日志中报告配置问题。API key 绝不写入
本仓库:放在环境变量里(`TYPESAFE_API_KEY` / `OPENAI_API_KEY`,或
`AUTO_REVIEW_WW_DECISION_API_KEY`)。

其他环境变量覆盖项:`AUTO_REVIEW_WW_MODE`、`AUTO_REVIEW_WW_DECISION_API`、
`AUTO_REVIEW_WW_DECISION_MODEL`、`AUTO_REVIEW_WW_DECISION_BASE_URL`、
`AUTO_REVIEW_WW_DECISION_API_KEY`、`AUTO_REVIEW_WW_DECISION_ALLOW_THRESHOLD`、
`AUTO_REVIEW_WW_DECISION_DENY_THRESHOLD`、`AUTO_REVIEW_WW_DECISION_ESCALATE`、
`AUTO_REVIEW_WW_DECISION_CONFIRM_DENIALS`、
`AUTO_REVIEW_WW_DECISION_ESCALATE_ON_TRUNCATION`、
`AUTO_REVIEW_WW_DECISION_TIMEOUT_MS`、`AUTO_REVIEW_WW_DECISION_MAX_STATE_CHARS`。

### 验证配置

```sh
node tools/probe-decision.mjs                       # TypeSafe,key 取自 TYPESAFE_API_KEY
node tools/probe-decision.mjs --api openai-decisions
node tools/probe-decision.mjs --task "删除过期的构建缓存"
```

探针通过插件自己的传输层发送一份评审形状的快照,打印裁决、校准概率与 token 用量,
或者确切的上游错误。在把某个 key、模型 id 或代理 base URL 交给真实提权之前,这是
最快的验证方式。

### 故障与局限

- 决策调用失败(网络、HTTP 错误、答案信封格式错误)会记入 `decision-failure`。默认
  按审查器故障 fail closed;只有 `escalate: chat` 才改由聊天模型复核。用户信号的中止
  永远不会被误判为失败。
- 决策模型的上下文比聊天模型小(Jev:每请求 64k、每问题 32k)。状态由
  `maxStateChars` 限定预算(默认:Jev 90,000 字符 ≈ 27k token;GPT-6 Luna 600,000),
  超出时**先丢弃最旧**的历史,丢弃条数写入 `reviewer.log`;项目指令与待审动作永不
  丢弃。被裁剪过的裁决默认仍然有效;想让它改由完整上下文的聊天审查器裁决,打开
  `escalateOnTruncation`。
- 拒绝理由由"分类文本 + 概率"组成,不是定制长句。想要聊天审查器为 `medium` 拒绝
  提供(并复核)理由,打开 `confirmDenials`;想要最省成本就保持关闭。
- OpenAI 的 Decisions 端点需要真实 API key,"Sign in with ChatGPT" 的 OAuth 令牌会被
  该路由拒绝。决策模型同样忽略 `temperature`。

## 裁决复用、评审超时与原始响应日志

- **裁决复用**:同一会话、同一工具、同一理由的相同提权,在复用窗口内直接复用已评审
  的结论,不再调用模型 —— 重试循环与重复维护命令只为同一种操作付一次评审。窗口:
  `AUTO_REVIEW_WW_VERDICT_TTL_MS`(默认 30 分钟)。
- **评审超时**:单次评审硬封顶(`AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS`,默认 120 秒)。
  超时后该提权 fail closed 并发布原因,而不是让整个任务干等几分钟。
- **原始响应日志**:每次评审都会把路由、载荷大小与模型的**逐字输出**(附 reasoning
  开头)写入插件目录下的 `reviewer.log`(JSONL:路由、载荷大小、模型逐字输出与 reasoning 开头,每次评审一行),
  "到底调没调模型"永远可以从日志证实。设置 `AUTO_REVIEW_WW_DEBUG_LOG=<文件>` 可获得
  完整证据文件。
## 兼容性说明

- 声明兼容区间:`0.2.0-rc.2 || >=0.2.1-rc.0 <0.4.0-0`(覆盖 0.2.0-rc.2、0.2.1 全部 rc 与正式版直到 0.2.5+/0.3 线;已用 node-semver 在 strict 与 includePrerelease 两种模式下验证)。插件不声明任何宿主私有常量、不导入宿主模块,只要权限行配置形状不变即可工作;升级宿主后请跑一遍 `node selftest.mjs`。可选沙箱补丁按内容精确匹配自守卫,宿主变更时拒绝盲改。
- 官方 `@deepseek-ai/dsh-experimental-auto-review` 行保持**启用**。选择器里会出现两个
  预设:官方 `auto`(带 EXP 徽章)与本包的 `auto-review`(普通条目 —— 客户端只装饰
  `auto`)。
- 零运行时依赖:宿主辅助函数全部内联,`link:`/junction 安装方式解析干净。

## 可选:把拒绝原因写进工具返回(实验性宿主补丁)

宿主在 `@deepseek-ai/dsh-sandbox` 内部用固定模板拼装提权拒绝文本("the user
rejected escalating this ..."),而审批协议本身不携带理由字段 —— 插件无法凭自己
改写这句话。因此本仓库提供一个可选的单行宿主补丁:

```sh
node tools/patch-sandbox-rejection.mjs            # 应用(幂等)
node tools/patch-sandbox-rejection.mjs --revert   # 恢复原始行
```

打补丁后,本审查器的拒绝会读作:

```text
the Auto Reviewer denied escalating this <subject> to "<mode>": <reason> ...
```

未打补丁的宿主完全不受影响(注册表根本不会被读取),无人值守语义不变;每次
Harness 升级后需要重新应用。不打补丁时,拒绝原因依然通过上下文通道到达 agent。
## 生产教训(每条都是一个回归测试)

1. **永远不要冻结 `AbortSignal`。** `deepFreeze(options)` 曾把组合信号一起冻结,下游
   `AbortSignal.any()` 抛出 `Cannot add property Symbol(kDependantSignals), object is
   not extensible`,所有评审在个位数毫秒内死亡。
2. **不要强制 `temperature: 0`。** 某些 `openai-responses` 中转通道会以不透明的上游
   失败拒绝它,而同一路由服务 agent 循环流量一切正常。
3. **审查器故障必须发布原因。** 静默 fail-closed 拒绝完全无法调试;失败分支发布稳定
   的"审查器故障"说明,确切的上游错误留在宿主日志。
4. **问题卡片的人类答复就是人类指令。** 它们以工具结果形式到达,`retainedContext`
   以 `human-instruction` 角色保留 —— 卡片里做的决定与打字授权同等有效。
5. **永远不要禁用官方 auto-review 行。** `auto` 是保留字;持久化在 `auto` 上的会话
   没有它的提供者就无法冷打开,界面会显示永久不可用。

## 自测

```sh
node selftest.mjs
```

一百一十九项检查覆盖:决策映射、提权门控、信号完整性、卡片答复保留、原因发布、
fail-closed 行为、卸载语义、两种决策模型协议 —— URL、鉴权头、
`noul`/`predicate` 问题形状、JSON 文本状态、带"丢弃最旧历史"的状态预算、阈值策略、
升级、拒绝复核与推翻、截断升级 —— 全部由录制式 `fetch` 驱动,不触网,以及探针工具。

## 许可证

[MIT](./LICENSE)
