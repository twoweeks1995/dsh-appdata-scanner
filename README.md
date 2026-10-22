# AppData Scanner

一个 DeepSeek Harness（DSH）客户端插件 + 独立命令行工具：**只读**分析 Windows 的 `AppData` 目录，
回答三个问题——

> 这个目录占了多少空间？是哪个软件生成的？能不能删？

**它不会删除任何东西。** 只帮你定位和解释，删除的决定权始终在你自己手里。

> 截图占位：建议放一张左侧栏图标 + 主区面板的截图

## 特性

- **资源管理器式下钻浏览**：点文件夹进入下一层，顶部「← 返回上一级」+ 面包屑跳级
- **递归体积统计**：显示每个目录含所有后代的真实大小、文件数、最后修改时间
- **三种排序**：名称 / 大小 / 修改日期，可切换升降序，选择会记住
- **三档安全判定**：可安全删除 / 需拆分确认 / 不可删除，混合目录会拆到子项
- **一键定位**：每行一个按钮，在资源管理器中打开并选中该目录
- **按需联网**：对未知目录可联网检索 + 模型总结，给出结论与带摘要的来源
- **按需加载**：不点图标就不扫描、不发请求，不打扰

## 联网查询：只能用 API key

这是框架层面的限制，不是配置疏漏。

插件里的 HTTP 路由**无法使用 DeepSeek 账号登录态**检索。原因在 `dsh-web-search-deepseek` 的实现：

```js
resolveAccountToken: async (endpoint) => {
  if (ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider !== ACCOUNT_PROVIDER)
    return void 0;
  return await ctx.get("deepseekAccount")?.resolveToken(endpoint);
}
```

账号模式要求调用方**正处在一次 agent 调用链里**（`currentInitiator()` 非空）。
插件的 HTTP 路由是裸请求、不在任何调用链上，所以永远走不到账号模式，只能回落到 API key。

| 部署情况 | 行为 |
|---|---|
| 配置了 `DEEPSEEK_API_KEY` | 检索 + 模型总结，返回结论与带摘要的来源 |
| 未配置 | 自动降级：把查询串复制到剪贴板，供你粘到对话里询问 |
| 没有 `web` 服务 | 同样降级为复制查询串 |

按钮文案会随能力自动变化：「❓ 查一下」或「📋 生成查询」。

**降级不是错误。** 缺凭据时接口返回 200 + 查询串，不是 500。

## 安装

### 作为 DSH 插件

```powershell
dsh plugin --profile <profile名> add file:<tarball 绝对路径>
```

或从源码目录链接（开发用，改代码重启即生效）：

```powershell
dsh plugin --profile <profile名> add link:<本目录绝对路径>
```

安装后**重启客户端**，左侧栏会出现「AppData Scanner」图标。

详见 [INSTALL.md](./INSTALL.md)。

### 独立命令行（不需要 DSH）

需要 Node >= 20，零第三方依赖：

```powershell
node src/cli.mjs scan   --min-mb 20 --out out/scan.json
node src/cli.mjs report --input out/scan.json --format table
node src/cli.mjs plan   --input out/scan.json --out out/plan.md
```

## 设计原则

**① 只读**
不修改、不创建、不删除被扫描目录下的任何文件。插件里没有任何删除按钮。

**② 语义优先于体积**
先判用途再看大小。按体积排序然后勾大户，第一个就会建议你删掉聊天记录。

**③ 混合目录必须拆分**
一个目录里同时有缓存和用户数据时（比如 `Edge\User Data` 里书签和缓存是邻居），
不给整块结论，拆到子项分别判定。

**④ 不确定就说不确定**
知识库未命中的目录标记为「推测」；联网结论恒为【联网·未证实】；
模型提示词里明确要求"只依据来源作答，不足就写信息不足"。

## 判定数据从哪来

内置知识库 150 余条（`knowledge/*.json`），覆盖常见 Windows 应用目录；
未命中的走启发式（名称特征、文件类型、数据库文件检测）；再未命中的标记为推测。

判定优先级：**知识库精确匹配 → 混合目录拆分 → 启发式 → 推测**。

## 目录结构

```
plugin/        DSH 插件（host 侧 HTTP 路由 + client 侧界面）
src/           独立可用的引擎（扫描 / 知识库 / 判定 / 报告 / 计划 / 联网）
knowledge/     内置知识库
test/          node:test 自测
```

## 已知限制

- 「在资源管理器中打开」依赖 `explorer.exe`，仅 Windows 可用（扫描与判定本身跨平台）
- 首次打开面板需完整扫描一次（约 18~25 秒）才能给出精确体积，之后走缓存
- 单个目录统计有 5 秒预算，超大目录会返回部分结果并标注「统计中断」

## 许可

[MIT](./LICENSE)
