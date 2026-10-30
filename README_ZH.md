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
值做 EXP 徽章特判)。任意模型路由可用:审查器跟随会话自己的 provider 和 model。

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

三十项检查覆盖:决策映射、提权门控、信号完整性、卡片答复保留、原因发布、
fail-closed 行为与卸载语义。

## 许可证

[MIT](./LICENSE)
