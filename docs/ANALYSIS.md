# Ob-Mail 技术分析报告

> 基于 v1.4.0 源码（`src/main.ts`，约 4350 行）的复盘：优势、取舍、问题与技术债务、改进路线。

## 1. 优势

### 1.1 「邮件即笔记」的原生融合

这是整个插件最核心的设计资产。邮件落地为带 frontmatter 的普通 Markdown 文件后，**免费获得** Obsidian 生态的全部能力：

- 全文搜索、标签、双链引用、Dataview 等社区插件查询（frontmatter 字段即结构化数据）；
- 用户可用 Obsidian 编辑器直接修改邮件笔记（加批注、关联到项目笔记）；
- 数据完全属于用户，卸载插件不丢数据，天然可备份（Vault 同步即邮件备份）。

### 1.2 视图与数据解耦

三栏视图不维护私有数据库，`refresh()` 直接扫描 Vault 目录 + `metadataCache`。任何途径产生的邮件笔记（包括手工创建的、外部同步进来的）都会被视图识别；反过来手工移动笔记即可改变所属文件夹。数据源唯一，无双写一致性问题。

### 1.3 健壮的地址解析

`parseEmailList` 是手写的状态机式解析器，覆盖了真实办公场景的脏输入：中英文逗号/分号、换行、制表符（Excel 复制）、`姓名<邮箱>`、引号内逗号不作为分隔符、纯邮箱混排。配合 `isValidEmail` 在发送前统一拦截，配合批量粘贴的「新增/去重/无效」计数反馈，是本项目中完成度最高的模块之一（有 `.cowork-temp/test-parse.js` 单元测试兜底）。

### 1.4 安全与兼容的平衡

密码走 Obsidian Keychain（`passwordSecretId` + `SecretComponent`），配置文件中不落明文；同时保留 `@deprecated` 明文回退路径，旧版本用户升级不中断。`getPasswordFromKeychain` 对「API 不存在 / 密钥缺失 / 异常」三类失败都有明确降级与错误提示。

### 1.5 作用域 CSS 隔离

html-styled 模式保留邮件原始样式但用 `simpleHash` 生成每封邮件独立的作用域类，既还原邮件排版又不污染 Obsidian 全局；插件自身样式全部带 `foxmail-`/`obmail-`/`mail-account-` 前缀。

## 2. 取舍（有意为之的决策）

| 取舍 | 选择 | 代价 | 理由 |
| --- | --- | --- | --- |
| 视图形态 | Foxmail 三栏 而非最初规划的 Kanban 看板 | 失去任务流转语义 | 日常收发效率优先；状态流转与 Obsidian 看板生态重叠（详见 design.md §5） |
| 代码组织 | 单文件 4350 行 + 顶部结构索引 | 可读性依赖索引、改动易冲突 | 早期快速迭代；单文件降低了构建与测试脚手架复杂度 |
| 时区 | 硬编码东八区（`getCSTDateString`/`convertUTCToCST`） | 非东八区用户时间不准 | 目标用户为国内办公场景，换取实现简单 |
| 附件策略 | 发送前全量读入内存（`FileReader → Buffer`） | 大附件内存占用高 | 实现简单且覆盖绝大多数日常附件（文档/图片）；无需流式临时文件管理 |
| frontmatter 读写 | 收取侧部分用正则手拼/手解，视图侧用 `metadataCache` | 两套路径并存，易不一致 | 写入路径需要精确控制字段顺序与格式；读取走缓存性能好 |
| 依赖选型 | `imap`（node-imap，已停维）+ `nodemailer` + `mailparser` | 依赖链老化 | 均为 Node 生态成熟件，Obsidian 桌面端可直接 require |

## 3. 问题与技术债务清单

按风险/影响排序，本次迭代**仅记录不实施**（除标注「已修」项）：

| # | 债务 | 现状与影响 | 状态 |
| --- | --- | --- | --- |
| 1 | **代理密码明文存储** | `proxyPassword` 直接存于 `data.json`，与主密码的 Keychain 化不一致 | 待办，应纳入 Keychain |
| 2 | **单文件 4300+ 行** | 10 个区块挤在 `main.ts`，重构窗口越来越小 | 待办，建议按区块拆模块 |
| 3 | **海量调试 `console.log`** | 收发全链路日志直出控制台，含连接细节，正式用户无过滤手段 | 待办，引入日志级别开关 |
| 4 | **`fetchedEmailIds` 线性膨胀** | 每账户的 messageId 数组全量存 `data.json`，邮件上万后设置文件显著变大、加载变慢 | 待办，改增量游标（UID/日期窗口）或外置索引 |
| 5 | **`src/todo.txt` 混入源码目录** | 开发过程记录（中文流水账）放在 `src/` 下，参与仓库观感 | 待办，迁移到 `docs/` 或仓库根 |
| 6 | **正则手解 frontmatter 与 metadataCache 并存** | 写入用字符串拼接、部分读取用正则，与官方缓存路径重复且更脆 | 待办，统一到官方 API |
| 7 | **`.cowork-temp` 测试脚手架非正式** | 测试通过 esbuild 现场打包真实源码再断言（可用但命名临时、无 CI 接入） | 待办，转正为 `tests/` + npm script |
| 8 | **`imap` 依赖已停维** | node-imap 多年无更新，异常处理需大量手工补丁（构造函数问题等历史修复见 todo.txt） | 待办，评估 `imapflow` |
| 9 | **硬编码东八区** | 见 §2，跨时区用户时间错误 | 待办，改用本地时区或账户级配置 |
| 10 | **附件全量内存化** | 见 §2，大附件风险 | 待办，可加大小上限提示或流式读取 |
| 11 | **无搜索正则/高级筛选** | 原需求中的字段级正则搜索未实现，当前仅子串过滤 | 待办 |
| 12 | ~~发布资产滞后~~ | `main.js` 已由 `.gitignore` 排除（审查要求作为 GitHub Release 资产上传，不得进仓库）；发布流程已在 readme.md「发布流程」与 RELEASE_NOTES v1.4.1 说明 | **v1.4.1 已修**（文档化发布流程 + 目录改名 ob-mail-client） |
| 13 | ~~`addStylesheet()` 手动 fs 注入样式~~ | 脆弱的 `require('fs')` 读取 styles.css 逻辑 | **v1.4.0 已修**：移除，改用 Obsidian 自动加载 |
| 14 | ~~`require('obsidian').MarkdownView` 运行期 require~~ | 与文件顶部静态导入并存 | **v1.4.0 已修**：改用静态导入 |
| 15 | ~~根 `readme.md` 内容为 CSS 片段，与项目脱节~~ | 文档错位 | **v1.4.0 已修**：改名保留至 `styles/README-css-snippets.md`，根 readme 重写 |

## 4. 改进路线建议

**第一阶段（低风险，纯增量）**
1. 代理密码接入 Keychain（复用 `SecretComponent`）；
2. 日志分级（`debug` 开关进设置页），默认静默连接细节；
3. `.cowork-temp` 转正：`tests/` 目录 + `npm test` 脚本 + 最小 CI。

**第二阶段（结构治理）**
4. `main.ts` 按顶部索引拆为 `address.ts / types.ts / settings.ts / views/ / compose/ / mailops.ts` 等模块，esbuild 入口不变；
5. `fetchedEmailIds` 迁移：新账户用 IMAP UID 游标，旧数据一次性转换；
6. frontmatter 读写统一到生成器函数 + `metadataCache`。

**第三阶段（能力演进）**
7. 依赖升级评估：`imap → imapflow`（Promise 化，可删大量回调补丁）；
8. 时区配置化；附件大小保护（超限提示并建议改用网盘链接）；
9. 可选看板视图：在现有笔记契约（frontmatter `status`）之上叠加，不改动存储层——最初的 `reaadme.md` 设计可作为输入。

## 5. 测试现状

- `.cowork-temp/test-parse.js`：地址解析/格式化/校验/HTML 清理断言（esbuild 打包真实源码后执行），v1.4.0 补充了制表符与 Excel 两列粘贴用例；
- `.cowork-temp/test-htmlconv.js`：HTML→Markdown 转换用例；
- 构建验证：`npm run build` 产物输出到 `test_note/.obsidian/plugins/ob-mail-client/`（main.js + styles.css + manifest.json），用内置 `test_note` Vault 手工回归（收发、拖拽附件、批量粘贴、回复/转发、草稿闭环）。

## 6. 插件目录审查合规（v1.4.1）

针对 Obsidian 官方插件目录自动审查（fix.txt，基于 1.4.0 / commit 6c556d9）的整改。整改后 `npm run build`、`npx tsc --noEmit`（exit 0）、31 项解析器单测全部通过。

### 6.1 已修复

**Error（阻断上架，全部清零）**

| 项 | 处理 |
| --- | --- |
| manifest ID 不一致 | 统一为 `ob-mail-client`；测试 Vault 插件目录同步改名，`community-plugins.json` 更新 |
| 名称/描述含 "Obsidian" 商标 | 名称改 **Mail as Notes**，描述改英文并以句号结尾 |
| 缺少 License | 新增根目录 `LICENSE`（MIT，与 package.json `license` 字段一致） |
| README 无英文 | readme.md 顶部增补英文简介段落 |
| 直接创建标题元素（9 处） | 设置页分节标题改 `new Setting(el).setName(...).setHeading()`；账户名 `h3` 改 `span`（非标题元素，配 `.mail-account-name` 字重） |
| 内联 style 赋值（~36 处） | 全部迁移到 `styles/foxmail-email.css` 的 CSS 类；折叠改用 `is-expanded`/`is-hidden` 类切换 |
| 创建 `<style>` 元素 | 邮件作用域 CSS 改用 `CSSStyleSheet` + `document.adoptedStyleSheets`（幂等 replaceSync，不建 style 节点） |
| Release 缺 main.js/manifest.json 资产 | 发布自动化：`.github/workflows/release.yml`（见 6.3） |

**Warning（低成本项已修）**

- `builtin-modules` → Node 内置 `module.builtinModules`（esbuild.config.js 与测试脚手架同步）；
- 依赖漏洞：升级 `nodemailer`/`mailparser`/`esbuild` 到 advisory 范围外版本（esbuild 因移除 `watch` 选项改用 context API）；
- `vault.trash()` → `fileManager.trashFile()`；`setTimeout` → `window.setTimeout`；`require('net'/'proxy-agent')` → 顶部静态 `import`；
- `prefer-create-el`：`document.createElement('div')` → `createDiv`，弹窗按钮行/容器改 `createDiv`；
- 移除多余正则转义（`\"`、字符类内 `\/`）与未使用变量（`basePath`/`from`/`fromMatch`）；
- tsconfig 增 `skipLibCheck`（消除静态导入 proxy-agent 后 node_modules 内 .d.ts 的连带报错）。

### 6.2 延期项（非阻断 Warning，附理由）

这些均为审查的 **Warning/Recommendation**，不阻断上架；修复面大或需权衡，故记录延后：

| 类别 | 规模 | 延期理由 |
| --- | --- | --- |
| `no-explicit-any` / `no-unsafe-*`（argument/assignment/member-access/call/return） | 数百处 | 根因是 `imap`/`mailparser`/`nodemailer` 无类型 + `(app as any).secretStorage`/`processFrontMatter` 等历史写法；需为三大依赖补 `.d.ts` 或整体类型化，属大重构，回归风险高 |
| `no-console`（调试日志） | 数十处 | 见债务 #3，应随「日志分级开关」一并治理，而非逐行删 |
| floating promise / promise-in-void | 数十处 | 多为事件回调内 `await`，逐个加 `void`/`.catch` 需确认每处错误处理语义，宜随模块拆分推进 |
| `prefer-promise-reject-errors` | 数处 | imap 回调 `reject(err)` 的 `err` 为 `any`，随依赖类型化一并收敛 |
| `getSettingDefinitions()`（声明式设置 API） | 1 处 | 面向 1.13.0+ 的设置搜索，需把整页设置重写为声明式定义，工作量独立且较大 |
| `async onload()` 返回 Promise | 1 处 | Obsidian 官方 sample-plugin 亦用 `async onload()`，属可接受惯例 |
| `password` @deprecated 明文字段 | 2 处 | 有意保留以兼容旧数据（见 §1.4），非缺陷 |

> 结论：阻断上架的 **Error 已全部清零**，可直接重新提交审查；上表 Warning 属代码质量演进项，建议纳入第二/三阶段的结构治理一并偿还。

### 6.3 二次审查修复（2026-09-09，commit 9d58b3b）

第二轮审查仅剩 Release 资产类 Error（需发布动作，已由 Action 自动化），其余新增告警均已在源码侧清零：

- **manifest 移除未知字段 `repo`**：插件目录的仓库信息由 obsidian-releases 侧维护，manifest 内为未知字段；
- **README 更名 `README.md`（大写）**：审查脚本按该文件名读取英文说明，此前小写 `readme.md` 未被识别（内容本身已含英文段落）；
- **CSS lint**：移除 2 处 `!important`（选择器特异性已足够）与 11 处 `:has()`——编辑器标题行 `:has(.cm-header-1)` 改为等价类 `.HyperMD-header-1`；附件卡片网格/列表缩进/mailto 段落背景等装饰规则删除（附件在预览页回退普通列表；自定义三栏视图本就不命中 email-note 作用域，不受影响）；
- **依赖漏洞**：`npm overrides` 将 `utf7`（imap 传递依赖）的 `semver` 固定 5.7.2，避免 audit 建议的 breaking 降级；
- **发布自动化**：新增 `.github/workflows/release.yml`，推送 tag 即执行 `npm ci` → `npm run build` → `gh release create`（上传 main.js/manifest.json/styles.css）。为此 github 发布仓库的 `esbuild.config.js` 与开发副本**有意分叉**：生产构建输出仓库根 `main.js` + `styles.css`（已入 .gitignore），开发副本仍输出 `test_note/` 测试 Vault。
