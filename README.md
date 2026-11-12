# 输入预测（Composer Predict）

在对话输入框里预测你**接下来要打的字**，以灰色“幽灵文本”内联显示在输入框内，按 `Tab` 采纳、`Esc` 忽略。目标：根据上下文和当前草稿，帮你省打字。

- 包名：`dsh-composer-autocomplete`
- 平台：web（Client 插件 + 一个 Host 预测路由）
- 版本：1.0.1

## 功能与交互

- **打字时**：本地启发式能补全（本会话里你说过的话 / 常见短语）就瞬时显示灰字；不能补全时，停顿约 200ms 自动用远端模型预测。
- **0 字符时（第二轮及以后）**：助手每回复一次，自动根据最近对话预测你下一条最可能的回复（例如助手给选项时优先猜“方案一”“第 2 个”）。
- **显示位置**：始终在输入框内、最后一个字符右边；光标在左/中也不会跟光标走、不会和中间文字重叠；超长会贴边换行并省略，不跑出输入框。
- **不聚焦也显示**：鼠标点到别处、整页失焦时灰字仍显示；灰字 `pointer-events:none`，不抢焦点、不挡点击。
- **采纳**：`Tab` 把预测追加到草稿末尾（`setDraft`），光标在中间也不会插错。`Esc` 忽略当前预测。

## 安装

在 Harness 的插件管理里安装本包（`dsh.bundle.patch` 指向 `cordis.patch.yml`）。安装后Client 会注册到 `conversation.input.overlay`，Host 注册路由 `/plugins/dsh-composer-predict/predict`。

- 首次安装：`plugin_manager` → `install_bundle`，target 为本包目录（本地目录安装）。
- 更新已安装包：替换包内容后重载插件（或重启 Harness），使新的 Host/Client 模块生效。
- 卸载：`plugin_manager` → `remove_bundle`。

## 权限与数据访问（重要）

本插件只做“读草稿 + 读最近对话 + 调模型 + 顶端画灰字”，具体如下：

- **读取**：当前会话的输入草稿（`useInput().draft`）；最近对话消息（`useChat`，取最近最多 8 条、每条截断 400 字，用于给模型理解目的）；输入框 placeholder 元素的几何位置（仅用于对齐灰字）。
- **写入**：仅在你按 `Tab` 时把预测文字追加进草稿（`inputActions.setDraft`）；在显示 0 字符预测时临时隐藏 placeholder（不改变其内容）。
- **不写会话日志**：不追加任何 Session 事件，不修改历史消息。
- **不上传文件/不写磁盘/不发外部网络**：唯一的网络访问是调用本机 Harness 的模型服务。
- **本地 HTTP 路由**：`POST /plugins/dsh-composer-predict/predict`。限制为：仅本机回环地址、必须带请求头 `x-composer-predict: 1`、`content-type: application/json`。用以阻止跨站/脚本滥用触发模型调用。
- **模型调用**：使用当前 profile 的**默认模型**（`agentDefaultModel.currentSelection()`）。会消耗 token（见下）。不会使用你的账号凭据做其它事情。

## Token 成本（实测）

- **0 字符预测**：每次约 **190~240 token**（系统提示约 150 + 最近对话）。示例：短上下文 `input 190 / output 1`；四轮上下文 `input 232 / output 6`。每轮助手回复后触发 1 次。
- **打字自动预测**：单次同量级（约 200~400 token）；一条消息常见触发 3~8 次，故更贵。
- **本地启发式命中**：0 token。
- 上下文截断上限 6000 字符；输出上限 80 token。

## 失败降级

- **未配置默认模型 / 无可用模型**：预测接口返回 `ok:false`，不显示灰字；本地启发式仍可用。
- **模型报错 / 超时**：Client 端 8 秒超时、Host 端 20 秒超时后清理，不会卡住；失败时清空加载态（不会长期停留在“…”）。
- **模型返回空**：不显示预测。
- **拿不到输入框 DOM 或 placeholder**：不绘制灰字（静默降级），不影响输入框本身。
- **组件渲染异常**：内置错误边界，只在角落显示“预测组件出错：…”，不影响输入框与其它功能。
- **插件被禁用/卸载**：Host 路由与 Client 槽位注册随上下文一起移除。

## 目录结构

- `index.js` — Host 半：注册预测路由，调用 `ctx.llm.stream`（支持流式，当前 Client 使用缓冲 JSON）。
- `client.js` — Client 半：注册 `conversation.input.overlay`，内联灰字、定位、Tab 采纳、0 字符预测。
- `cordis.patch.yml` — 插入 `composer-predict` 行。
- `locale/*.json`、`icon.svg` — 显示元数据与图标。

## 已知限制

- 远端模型首字约 1.8 秒（实测），做不到 GPT 那种“几乎瞬间”；要更快需换更快的模型或本地模型。
- 纯本地只有启发式补全（0 token），质量有限，不是真正的语义预测。
- 0 字符预测依赖“最近对话”能取到（本地会话历史可用时才生效）。
