# dsh-appdata-scanner · 安装说明

一个只读的 AppData 目录分析插件：以资源管理器式下钻浏览，显示每个目录的递归体积、
由哪个软件生成、用途、以及能不能删。**插件不执行任何删除操作**——它的用途是帮你在动手清理
AppData 之前，先看清每一块空间被谁占用、删了会怎样。

## 一、前置条件

| 项 | 要求 |
|---|---|
| DSH | >= 0.2.1-rc.2（见 package.json 的 `dsh.engines.dsh`） |
| 宿主服务 | `webServer`（必需）；`web`（**同样必需**——缺失时插件不加载，见第七节）；`llm`（可选，缺失只影响模型总结） |
| 客户端槽位 | `sidebar.panellist`（左侧栏图标）、`main`（主区面板） |
| 客户端服务 | `slots`、`locale`（cordis 服务名，客户端 `inject` 声明） |
| client 模块 | 客户端脚本只 `require("react")`（宿主提供）；`dsh.client.inject` 现声明 3 个 `@deepseek-ai/dsh-client-ui-*`（sidebar-right / layout / locale），脚本并未直接引用它们，属"向宿主表明运行环境"的声明。历史上还声明过 `dsh-client-ui-primitives`（DSH 0.2.1-rc.2 宿主中不存在），已移除 |
| 平台 | Windows（「在资源管理器中打开」依赖 explorer.exe；扫描与判定本身跨平台） |
| profile | 该 profile 需先被桌面客户端打开过一次 |

## 二、安装

### 三种输入任选其一

```
dsh-appdata-scanner
https://github.com/twoweeks1995/dsh-appdata-scanner
D:\temp\dsh-appdata-scanner-0.7.1.tgz   ← 换成你实际下载到的 tgz 绝对路径（版本号以 Releases 页为准）
```

### 从本地文件安装

### 方式 A：从 tarball 安装（适合分发）

```powershell
dsh plugin --profile <profile名> add file:<tarball 的绝对路径>
```

### 方式 B：从目录链接安装（适合开发调试）

```powershell
dsh plugin --profile <profile名> add link:<包目录的绝对路径>
```

`link:` 是符号链接，改代码后重启客户端即生效；`file:` 会把包复制进 profile。

### 不知道 profile 名？

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object -ExpandProperty Name
```

> 若设置过 `DSH_HOME`，profile 在 `$env:DSH_HOME\profiles` 下。

## 三、重启客户端

完全退出（含托盘图标）后重启。**必须重启才会加载插件。**

## 四、安装后验证

1. 左侧栏出现「AppData Scanner」图标；点它，主区会打开面板（不是右侧栏的标签页）
2. 首次打开约 18~25 秒出数据（需完整扫描一遍才能给出精确体积），之后走内存缓存
3. 顶层按本机实际情况列出 AppData 下的目录（如 Local / LocalLow / Roaming / Flash Player）
4. 点任意一行进入该目录；顶部「← 返回上一级」可回退
5. 点行尾文件夹图标 → 资源管理器打开并选中该目录

## 五、可选能力：联网查询

点行内「❓ 查一下」可让插件解释这个目录。

| 部署情况 | 行为 |
|---|---|
| 配置了 `DEEPSEEK_API_KEY`（或等价凭据） | 检索 + 模型总结，返回结论与带摘要的来源 |
| 未配置凭据 | 自动降级：把查询串复制到剪贴板，供你粘到对话里问 agent |
| 完全没有 `web` 服务 | 插件不会加载（`inject` 里声明了必需服务）。处理办法见第七节 |

> 另外，**打开面板时**插件会做一次「能力探测」：用一条最小查询确认检索是否真的可用，
> 结果缓存 5 分钟。也就是说，配好凭据的情况下，光是打开面板就会产生一次远端检索请求；
> 除此之外，只有你点「❓ 查一下」并确认之后才会再次联网。

按钮文案随能力自动变化：「❓ 查一下」或「📋 生成查询」。

> 说明：插件内的 HTTP 路由无法使用 DeepSeek **账号**登录态检索——框架要求调用方处于
> agent 调用链内（`currentInitiator()` 非空），而裸 HTTP 路由没有该上下文。
> 因此只能走 API key。这是设计约束，不是配置错误。

## 六、卸载

```powershell
dsh plugin --profile <profile名> remove dsh-appdata-scanner
```

## 七、故障排查

### 面板消失 / 插件没加载

最可能的原因是 `inject` 里声明的服务在该部署中不存在。`plugin/index.js` 顶部是：

```js
export const inject = ["webServer", "web"];
//                               ^ 必需声明：没有 web 服务时插件整体不加载，而不是只关掉联网
```

部署里没有 `web` 服务时，把 `"web"` 从数组里去掉再重启即可。

- 去掉后：联网查询退化为「📋 生成查询」（把查询串复制到剪贴板，你自己去问），其余功能不受影响；
- 不去掉：面板根本不会出现——这是"声明为必需"的直接后果，不是配置错误。

`webServer` 不能去掉：面板的树、汇总、清理建议都靠它挂的 HTTP 路由。

### 点「打开资源管理器」报错

| 现象 | 原因 |
|---|---|
| `code=3221225794` | 0xC0000142，进程被受限令牌挡下 |
| `HTTP 400` | 路径不在 AppData 之下，或不是已存在的目录（安全校验拦截） |
| 无反应也无报错 | 用户态 explorer.exe 被策略限制 |

### 体积偏小 / 显示「统计中断」

树视图里**单个目录**的统计预算是 5 秒、**单次请求**总预算是 20 秒，超出会返回已统计到的部分并标注「统计中断」。
首次打开面板还要先跑一次全量扫描，**每个顶层目录**的预算是 15 秒（本机实测整轮约 18~25 秒）。
重新进入该目录通常会算全，因为缓存里已有部分结果。

### 判定不准

判定来自内置知识库（146 条主条目 + 450 条子项规则）+ 启发式，未命中的目录会标记为推测。
把判错的条目反馈给维护者，比改代码更有价值。

需要注意的是，启发式的**缓存名规则排在数据库文件检测之前**：名字里带 cache/temp 的目录
即使内含 `.db`/SQLite，也可能被判为「可安全删除」。这类目录请自己再确认一遍用途。
