# dsh-live-reload

**一键热刷新 DSH 插件组合 —— 进程不退出。**

`dsh-live-reload` 会重新读取当前 profile 的**完整插件组合**——所有 bundle 层
(`dsh.profile.bundles`)、profile 用户层(`cordis.patch.yml`)、home 用户层
(`$DSH_HOME/cordis.patch.yml`)以及 launcher 覆盖层(`--patch`、agent-presets 系统预设根、
`DSH_TELEMETRY_DISABLED` 开关)——并通过根 Include **即时应用**到运行中的组件树。进程、
Web 服务器和所有已打开会话都保持存活:loader 事务性地挂载新行、配置更新变更行、移除被删行,
失败自动回滚,只有真正变化的行才会被触及。

> 现在的痛点:装一个新插件(比如在插件市场里点安装)经常以「重启 DeepSeek Harness 后生效」
> 收场。这个插件就是通用解法:设置页一个按钮热应用整个组合,仅当出现新的*客户端* bundle 时
> 才提示刷新页面(宿主进程本身永不退出)。

## 特性

- **一键刷新** —— 设置页新增「插件刷新 / Plugin Refresh」区块。
- **全量重组** —— 覆盖 bundle 层(普通启动会冻结的部分)、用户补丁层、`--patch` 覆盖层、
  agent-presets 系统预设根与 telemetry 开关;已与 launcher 自己的
  `dsh --profile <name> --dump-config` 输出做逐行校验(见 `scripts/validate-composition.mjs`)。
- **构造安全** —— 复用了内置 HMR 在每次保存 `cordis.patch.yml` 时使用的同一条事务更新路径;
  未变行永不重启、失败整体回滚、刷新互斥且有超时上限。
- **结果报告** —— 按钮展示新增/移除/更新行与激活错误;仅当出现新客户端 bundle 时提供
  「刷新页面」按钮。
- **进程不退出** —— 宿主持续运行;页面重载后会话历史从持久化日志重放(Web 应用标准
  reload recovery)。
- **插件包热更新(0.2.0)** —— 每个 bundle 都会在磁盘上做指纹快照(启动时播种);当已挂载
  包的磁盘文件发生变化(市场重装/更新),刷新会把它的 loader 行改指向带 rev 的缓存破除
  URL,loader 重新导入并运行**新代码**——无需重启,也不会再出现 "tool already registered"
  撞名(loader 会先撤销旧 fiber 的注册再启动新行)。

## 安装

```bash
# 从仓库或发布版安装:
dsh plugin --profile web add github:<你的名字>/dsh-live-reload

# 本地开发迭代(link 安装,改代码即生效):
dsh plugin --profile web add link:D:/绝对/路径/dsh-live-reload
```

bundle 层在下次 `dsh web` 启动时激活——**仅安装本插件自身需要这一次重启**。之后安装/移除/
改配置插件都可用刷新按钮热应用,不再需要重启。

## 使用方法

1. 打开 Web GUI → 设置 → **插件刷新 / Plugin Refresh**。
2. 点击 **一键刷新插件 / Refresh Plugins**。
3. 查看结果:`✓ 已热刷新` 并列出新增/移除/更新行,或错误列表。
4. 若提示出现新客户端插件,点击 **刷新页面 / Reload Page**(宿主进程不退出,仅浏览器重载)。

高级用户可直接调用接口:

```bash
curl -s http://127.0.0.1:3080/dsh-live-reload/status
curl -s -X POST -H 'origin: http://127.0.0.1:3080' http://127.0.0.1:3080/dsh-live-reload/refresh
```

## 工作原理

```
设置页按钮 ──POST──▶ /dsh-live-reload/refresh
                          │
                          ▼
              composeFresh(profileDir)          # 重读 bundle + 用户层 + 覆盖层
                          │
                          ▼
        根 Include entry.update({ config: { …includeConfig, patches } })
                          │        # 与用户补丁 HMR 完全相同的调用
                          ▼
        loader 协调:挂载新行 · 配置更新变更行 · 移除被删行
                          │
                          ▼
        审计(每个启用行都有活动 fiber)+ diff 报告 + 客户端图变更标记
```

组合代码(`composeFresh`)与 launcher 的 `composeProfile`/`composeLive` 完全对齐,
包括两个最容易遗漏的 boot 专属覆盖层:

- **agent-presets 系统预设根覆盖层**(缺少它刷新会丢掉安装自带的 preset 根);
- **telemetry 开关**(`DSH_TELEMETRY_DISABLED`)。

## 兼容性

- 由 `dsh --profile` launcher 启动的 profile(web、headless、自定义);手建无 profile 目录
  的树会被识别并报错。
- 运行时需要 `@deepseek-ai/dsh-app-boot`——通过 profile 的 node_modules /
  `$DSH_HOME/profiles/node_modules` 安装回退解析(不声明为依赖,与生态市场插件同款做法)。
- 不锁定 `dsh.bundle` 版本。**实测于 `0.1.0-rc.5`**(提供回退模块的 Harness);其他 rc 版本
  预期行为一致,但未逐一实测。
- Windows / macOS / Linux —— 纯 Node ESM 宿主,零原生依赖。

## 验证

`dsh-live-reload` 已在真实启动的隔离实例上完成端到端验证(独立 `DSH_HOME`、OS 分配端口、
`node_modules` 通过 junction 共享安装回退):

- `GET /dsh-live-reload/status` → `200`,profile 正确。
- `POST /dsh-live-reload/refresh` → `200 {ok: true}`,零变化,重复刷新稳定(无抖动)。
- 向 `dsh.profile.bundles` 追加新 bundle 后刷新 → `added: ["<行>"]`、`errors: []`
  —— 该行**即时挂载**,审计干净。
- 移除后再刷新 → `removed: ["<行>"]` —— 该行即时卸载。
- `GET /plugins/dsh-live-reload/client.js` → `200`;启动清单(`window.__DSH_BOOT__`)
  携带 `dsh-live-reload` 客户端条目。

组合逻辑另与 launcher 自己的 `dsh --profile <name> --dump-config` 输出做逐行交叉校验
(`node scripts/validate-composition.mjs <profile>`),含 agent-presets 系统预设根覆盖层与
telemetry 开关。

整套验证已脚本化:`npm test` 会启动一个隔离实例,端到端跑状态/幂等/热挂载/热卸载/客户端
下发/`clientGraphChanged`,外加 boot 与 fresh 重组之间的 `agent-presets` 审计
(见 `scripts/e2e.mjs`)。

## 已知交互

内置 HMR watcher 每次保存 `cordis.patch.yml` 时,用的是**启动时捕获**的 bundle 集合来重组。
如果你用本插件热应用了新装的 bundle,之后又手动编辑 `cordis.patch.yml`,内置 watcher 会按
启动时的 bundle 集合重新应用(新 bundle 的行会被移除)——此时再点一次刷新按钮即可:它会
重新读取全部内容并应用完整组合。

## 仍需要重启的场景

- **更新已安装包、但其 loader 行前后完全一致的情况**:刷新会给每个 bundle 做磁盘指纹并对
  变更包的 loader 行做缓存破除(0.2.0)——重装/更新导致的行重放会热加载新代码;但如果
  更新前后的 loader 行**完全相同**,就没有可重放的行,新代码仍需重启(刷新会通过
  `updatedOnDisk` 报告)。
- 改动 Web 前端 shell 本身或 `dsh` 二进制。
- 本插件安装后的首次激活。

## 开发

```bash
npm run build:client   # 本地需装 tsdown:pnpm add -D tsdown@^0.22.14(或 npm i -D tsdown@^0.22.14)
npm run check          # 两个半区 node --check + 发布产物守卫
npm test               # 隔离实例上的脚本化 e2e(见 scripts/e2e.mjs)
node scripts/validate-composition.mjs web   # 对比重组合结果与 launcher dump
```

`client/client.js` 是随包发布的构建产物——改完 `src/client/index.js` 后请重建并提交。
`tsdown` 故意不声明为 devDependency:`client/client.js` 已提交,安装本包(git 或 npm)
不应拖入构建工具链。

## 安全

刷新**不执行任何 shell 命令**,只修改内存中的 loader 树。POST 路由做同源校验(与生态市场
插件一致)。刷新失败会回滚到最后一次良好的树——绝不会留下半应用状态。

## License

MIT
