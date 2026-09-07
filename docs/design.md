# Ob-Mail 设计文档

> 版本：1.4.0 ｜ 源码：`src/main.ts`（单文件，约 4350 行，文件顶部含模块结构索引注释）

## 1. 总体架构

插件为单入口 `main.ts`，按职责自上而下划分为 10 个区块（源码顶部注释即为索引）：

```
1. 工具函数        formatHTMLSafely / formatHTMLIndentation / cleanHtmlForMarkdown / simpleHash
2. 地址解析        ParsedAddress / parseEmailList / formatAddress / isValidEmail
3. 数据类型        MailAccount / Contact / MailSettings / DEFAULT_SETTINGS
4. Keychain       getPasswordFromKeychain（含降级回退）
5. 设置页          MailSettingTab（全局设置 + 多账户折叠面板 + 连接测试）
6. 通用弹窗        ConfirmModal
7. 三栏邮件视图    MAIL_VIEW_TYPE / MailEntry / MailFoxmailView
8. 写信标签页      COMPOSE_VIEW_TYPE / askComposeCloseChoice / ContactPickerModal /
                   buildContactField / ObMailComposeView
9. 主插件类        MailPlugin（收取 / 发送 / 草稿 / 联系人 / 同步 / 视图入口 / 已读跟踪）
10. 邮件操作函数   replyToEmail / replyAllEmail / forwardEmail /
                   forwardEmailAsAttachment / markEmailAsSpam（模块级函数，任意位置可调用）
```

### 1.1 视图模型

| 视图 | 类型常量 | 说明 |
| --- | --- | --- |
| `MailFoxmailView` | `obsidian-mail-foxmail-view` | 三栏视图：左栏账户/文件夹树（收件箱📥/已发送📤/草稿箱📝/垃圾邮件🚫+未读角标），中栏邮件列表（搜索过滤、Foxmail 式日期），右栏阅读窗格（`MarkdownRenderer` 渲染 + 回复/转发等操作按钮）。工具栏提供收取、写邮件、刷新入口 |
| `ObMailComposeView` | `obsidian-mail-compose-view` | 标签页式写信界面：发件账户选择、收件人/抄送/密送（联系人补全）、主题、正文（Markdown）、附件区（选择器 + 拖拽）、发送/保存草稿。带脏标记（`dirty`），关闭时经 `askComposeCloseChoice` 三选一 |

三栏视图的数据来源是 **Vault 本身**：`refresh()` 扫描 `{obmailStoragePath}` 下所有 Markdown 文件，依据路径中的 `收件箱/已发送/草稿箱/垃圾邮件` 判定文件夹，依据 frontmatter `type` 判定邮件笔记，因此视图与笔记文件始终一致，外部修改笔记（如手动移动到其他文件夹）也会被 800ms 防抖的 vault 事件监听自动反映。

## 2. 数据结构

### 2.1 核心接口

- **`MailAccount`**：账户配置。含 `id / name / email`、IMAP/SMTP 主机端口、`username`、`passwordSecretId`（Keychain 密钥 ID，**不存明文**；`password` 字段标记 `@deprecated` 仅作旧数据兼容）、`secure / tls`（跳过证书验证）、`signature`、代理六元组（`proxyEnabled/Host/Port/Type/Username/Password`）。
- **`Contact`**：`{ id, name, email }`，存于全局设置，用于写信补全；同时镜像写入 `{存储路径}/联系人/联系人.md`（`- 姓名 <邮箱>` 列表，按姓名排序），便于用户在 Obsidian 内检索维护。
- **`MailSettings`**：`accounts / obmailStoragePath（默认 3-mail）/ obmailAttachmentDir（默认 attachments）/ contacts / fetchedEmailIds（账户 → 已收 messageId 数组，增量去重）/ syncInterval（默认 5 分钟）/ htmlDisplayMode（html-styled | markdown | formatted）`。

### 2.2 邮件笔记 frontmatter 契约

每封邮件 = 一条带 frontmatter 的 Markdown 笔记，是三栏视图、回复/转发、已读跟踪的共同数据契约：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `type` | `邮件笔记` / `发出邮件` / `draft` | 收件 / 已发送 / 草稿；视图扫描只收录这三种 |
| `status` | `未读` / `已读` / `垃圾邮件` | 预览即改「已读」；标记垃圾邮件后移入垃圾邮件目录 |
| `from / to / cc / bcc` | RFC 5322 风格字符串 | 由 `parseEmailList`/`formatAddress` 读写 |
| `subject / account / created / mailID` | — | 主题、所属账户名、时间（东八区）、服务器 Message-ID |
| `atta` | 附件路径列表 | 正文同时以 `## 附件` 小节列出链接（双保险检测） |
| `cssclasses` | `[email-note]` | 触发邮件样式；配合 `simpleHash` 生成作用域类隔离内联样式 |
| `obmailscope / obmailcss` | — | html-styled 模式下记录作用域类名与原始邮件 CSS |
| `sourceFile` | 笔记路径 | 回复/转发时指回原邮件，实现双向关联（双链） |

### 2.3 Vault 存储布局

```
{obmailStoragePath}/（默认 3-mail）
├── {账户名}/
│   ├── 收件箱/{YYYY-MM}/主题2026-08-22-15-04-05-000000.md   # 按月分桶，文件名日期前缀保证时间排序
│   │   └── （同名冲突自动追加 -1、-2 序号）
│   ├── 收件箱/{obmailAttachmentDir}/{YYYY-MM-DD}/xxx.pdf    # 附件按天分桶
│   ├── 已发送/{周一日期}/…                                   # 按周归档，附件同目录规则
│   ├── 草稿箱/…                                              # 未选账户时落到 {basePath}/草稿箱（默认账户）
│   └── 垃圾邮件/…
└── 联系人/联系人.md                                           # 联系人镜像
```

文件名规则：主题去特殊字符（`\/*?:"<>| 空格` → `_`）+ 东八区日期 + 时间戳，保证可排序且跨平台安全。

## 3. 关键流程

### 3.1 收取（IMAP → Markdown）

1. `connectIMAP`（带重试）→ 打开 INBOX；
2. 以 `fetchedEmailIds[账户]` 中的 messageId 做增量去重，只拉取新邮件；
3. `mailparser.simpleParser` 解析；正文按 `htmlDisplayMode` 三选一处理：
   - `html-styled`：`cleanHtmlForMarkdown` 剥离 style/script/head/注释后，保留原始 HTML + 提取的 CSS 写入 `obmailcss`，渲染时用哈希作用域类隔离；
   - `markdown`：`html-to-markdown` 转换；
   - `formatted`：格式化 HTML 源码安全展示；
4. 附件经 `saveAttachments` 落盘（流/Buffer 双兼容、重名加序号），链接写入笔记 `## 附件`；
5. `saveEmailToFile` 写入收件箱并 `Notice` 提示；更新 `fetchedEmailIds`。

自动收取：`onload` 按 `syncInterval` 启动定时器，设置页修改后 `updateSyncTimer` 重置。

### 3.2 发送（SMTP + 签名）

写信视图 `collectForm` 统一走 `parseEmailList` + `isValidEmail` 校验（无效地址拒绝发送）→ `formatAddress` 生成 RFC 5322 地址 → `createSMTPClient`（nodemailer，支持代理 `proxy-agent`）→ 正文追加账户签名 → 附件从内存 Buffer 挂载 → 发送成功后写入「已发送/{周一日期}/」并关闭标签页。

### 3.3 回复 / 转发 / 草稿闭环

- **回复/回复全部**（`replyToEmail`/`replyAllEmail`）：读取当前活动邮件笔记 frontmatter，预填收件人（回复全部含原抄送、排除自己），正文引用原文，`openComposeView` 携带 `sourceFile` 建立关联；
- **转发 / 作为附件转发**（`forwardEmail`/`forwardEmailAsAttachment`）：前者带入正文与附件引用，后者把原邮件（含附件）打包为附件；
- **草稿**：`saveDraft` 写 `{账户}/草稿箱/`（`type: draft`）；从草稿打开时 `draftFile` 指向原文件，再次保存为**更新**而非新建；关闭脏标签页触发 `askComposeCloseChoice`（保存草稿 / 不保存 / 取消），插件卸载时 `isUnloading` 跳过询问；
- **已读跟踪**：`lastActiveFile` 对比，离开收件箱邮件笔记时自动将 `status` 未读 → 已读。

## 4. 安全设计：Keychain 集成

- 设置页「密码/授权码」使用 `SecretComponent`，账户仅存 `passwordSecretId`；
- `getPasswordFromKeychain`：优先 `app.secretStorage.getSecret(id)`；API 不存在（旧版 Obsidian）、密钥缺失或异常时，**降级回退** `@deprecated` 的 `password` 明文兼容字段，保证存量账户可用；两者皆无则抛出明确错误引导重新配置；
- 所有失败路径均输出结构化日志（错误类型/消息/堆栈）便于排查。

## 5. 与最初看板设计的偏差说明

仓库根目录 `reaadme.md` 保存了最初的需求规划：以 **Kanban 看板**（未读/阅知/待办/推进/待反馈/已回复/归档 七列，账户为泳道，卡片拖拽流转）作为邮件任务管理入口。最终实现改为 **Foxmail 三栏视图**，原因：

1. **操作效率**：日常收发场景下三栏（树/列表/阅读）的信息密度与切换速度优于看板拖拽；看板更适合任务流转而非邮件浏览；
2. **状态模型简化**：七列状态流转需要每封邮件持久化任务状态并维护拖拽交互，复杂度高且与 Obsidian 自身的任务/看板生态（如 Kanban 插件）重叠；当前以 `status`（未读/已读/垃圾邮件）+ 文件夹目录承载必要状态；
3. **保留的能力**：原需求中的核心能力均已落实或以 Obsidian 原生能力替代——双链关联（`sourceFile` + wiki 链接）、搜索过滤（视图内过滤 + Obsidian 全局搜索/frontmatter 查询）、联系人自动提取去重、附件解析落盘、多账户、定时收取、安全存储。

看板方案未删除任何设计资产（`reaadme.md` 原样保留），如未来需要，可作为独立视图模式叠加在现有笔记契约之上。

## 6. 样式体系

- 样式源文件 `styles/foxmail-email.css`，esbuild 构建时经 `copyCSS` 插件复制为插件目录 `styles.css`，由 **Obsidian 自动加载**（v1.4.0 起不再手动注入）；
- 类名前缀约定：视图 `foxmail-*`、写信 `obmail-compose-*`、设置页 `mail-account-*`；
- 邮件正文内联样式通过 `email-note` + `simpleHash` 作用域类包裹，避免污染全局。
