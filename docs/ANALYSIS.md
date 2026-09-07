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
| 12 | **发布资产滞后** | `release/` 仍为 v1.0.6 包，RELEASE_NOTES 曾停留旧版本号 | 部分已修（v1.4.0 发布说明已补），重新打包待办 |
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
- 构建验证：`npm run build` 产物输出到 `test_note/.obsidian/plugins/obsidian-mail/`，用内置 `test_note` Vault 手工回归（收发、拖拽附件、批量粘贴、回复/转发、草稿闭环）。
