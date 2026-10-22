# dsh-appdata-scanner · 安装说明

一个只读的 AppData 目录分析插件：以资源管理器式下钻浏览，显示每个目录的递归体积、
由哪个软件生成、用途、以及能不能删。**不提供任何删除功能。**

## 一、前置条件

| 项 | 要求 |
|---|---|
| DSH | >= 0.2.1-rc.2（见 package.json 的 `dsh.engines.dsh`） |
| 宿主服务 | `webServer`（必需）；`web`、`llm`（可选，缺失只影响联网查询） |
| 客户端槽位 | `sidebarRightTabs`、`sidebar.right.pane.tab`、`slots`、`locale` |
| client 模块 | 需能解析 `dsh.client.inject` 列出的四个 `@deepseek-ai/dsh-client-ui-*` 包 |
| 平台 | Windows（「在资源管理器中打开」依赖 explorer.exe；扫描与判定本身跨平台） |
| profile | 该 profile 需先被桌面客户端打开过一次 |

## 二、安装

### 三种输入任选其一

```
dsh-appdata-scanner
https://github.com/twoweeks1995/dsh-appdata-scanner
D:\temp\dsh-appdata-scanner-0.6.2.tgz
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

1. 右侧边栏出现「AppData Scanner」标签页
2. 首次打开约 18~25 秒出数据（需完整扫描一遍才能给出精确体积），之后走缓存
3. 顶层显示 AppData 下的目录（Local / LocalLow / Roaming 等）
4. 点任意一行进入该目录；顶部「← 返回上一级」可回退
5. 点行尾文件夹图标 → 资源管理器打开并选中该目录

## 五、可选能力：联网查询

点行内「❓ 查一下」可让插件解释这个目录。

| 部署情况 | 行为 |
|---|---|
| 配置了 `DEEPSEEK_API_KEY`（或等价凭据） | 检索 + 模型总结，返回结论与带摘要的来源 |
| 未配置凭据 | 自动降级：把查询串复制到剪贴板，供你粘到对话里问 agent |
| 完全没有 `web` 服务 | 同上，降级为复制查询串 |

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

多半是 `inject` 里声明了该部署没有的服务。打开 `plugin/index.js` 顶部：

```js
export const inject = ["webServer", "web"];
//                               ^ 部署里没有联网服务时，去掉 "web"
```

改完重启即可。去掉后联网查询降级为「生成查询」，其余功能不受影响。

### 点「打开资源管理器」报错

| 现象 | 原因 |
|---|---|
| `code=3221225794` | 0xC0000142，进程被受限令牌挡下 |
| `HTTP 400` | 路径不在 AppData 之下，或不是已存在的目录（安全校验拦截） |
| 无反应也无报错 | 用户态 explorer.exe 被策略限制 |

### 体积偏小 / 显示「统计中断」

单个目录统计有 5 秒预算，超大目录会返回部分结果并标注「统计中断」。
重新进入该目录通常会算全；首次打开面板需要完整扫描一次（~20 秒）才能得到精确值。

### 判定不准

判定来自内置知识库（150 余条）+ 启发式，未命中的目录会标记为推测。
把判错的条目录反馈给维护者，比改代码更有价值。
