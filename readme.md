# Ob-Mail —— Obsidian 邮件客户端插件（Foxmail 风格）

在 Obsidian 中收发邮件的桌面端插件。核心理念：**每一封邮件都是一条 Markdown 笔记**——收取的邮件解析为带 frontmatter 的 Markdown 文件存入 Vault，天然融入 Obsidian 的双链、搜索与知识管理体系；同时提供 Foxmail 风格的三栏邮件视图与标签页式写信界面，兼顾传统邮件客户端的操作习惯。

- 插件 ID：`obsidian-mail`
- 当前版本：**1.4.0**（变更见 [RELEASE_NOTES.md](RELEASE_NOTES.md)）
- 界面视图：Foxmail 三栏视图（账户/文件夹树 + 邮件列表 + 阅读窗格）

## 功能清单

| 分类 | 功能 |
| --- | --- |
| 账户 | 多账户管理、IMAP/SMTP 服务器配置、SSL 与跳过证书验证、网络代理、连接测试按钮 |
| 安全 | 密码/授权码经 Obsidian **Keychain** 存储（`passwordSecretId`），兼容旧版明文回退 |
| 收取 | 手动收取、按周期自动收取（默认 5 分钟）、强制重新解析已下载邮件、增量去重 |
| 解析 | HTML 邮件解析为 Markdown（可选保留原始样式渲染 / 转 Markdown / 格式化源码三种显示模式），附件落盘并以链接写入笔记 |
| 发送 | 标签页式写信视图、多账户选择、正文支持 Markdown、邮件签名、附件（选择器 + **拖拽**）、发送后自动归档到「已发送」 |
| 收件人 | 联系人自动补全、**批量粘贴**（`姓名<邮箱>` 列表，逗号/分号/换行/制表符分隔，去重入联系人并反馈结果）、联系人选择弹窗 |
| 邮件操作 | 回复 / 回复全部 / 转发 / 作为附件转发 / 标记垃圾邮件 / 标记已读未读，回复与原邮件双向关联 |
| 草稿 | 保存草稿、从草稿恢复继续编辑、关闭标签页时三选一（保存草稿/不保存/取消） |
| 视图 | 三栏视图预览即标记已读、未读角标、按主题/发件人/收件人过滤、双击在编辑器打开原始笔记、邮件头信息可折叠、列表/邮件头右键菜单（回复/转发等） |
| 样式 | 作用域 CSS（`cssclasses: email-note` + 哈希作用域类），邮件样式不污染整个 Obsidian |

## 系统要求

- **仅桌面端**（`isDesktopOnly: true`，依赖 Node 网络库与文件系统）
- Obsidian **≥ 1.11.4**（Keychain `secretStorage` API 要求）
- 邮件服务器需开启 IMAP/SMTP 服务（常见邮箱需使用**授权码**而非登录密码）

## 安装

### 方式一：从发布包安装

1. 下载发布包（如 `release/obsidian-mail-v1.4.0.zip`，见 [RELEASE_NOTES.md](RELEASE_NOTES.md) 安装说明）；
2. 解压后将插件目录放入你的 Vault：`{Vault}/.obsidian/plugins/obsidian-mail/`，目录内应包含 `main.js`、`manifest.json`、`styles.css`；
3. 在 Obsidian「设置 → 第三方插件」中启用 **Ob-Mail**。

### 方式二：从源码构建

```powershell
cd obsidian-mail
npm install
npm run build      # 生产构建，产物输出到 ./test_note/.obsidian/plugins/obsidian-mail/
npm run dev        # 开发模式（esbuild watch）
```

构建产物会自动复制到本仓库内置的 `test_note` 测试 Vault，可直接用 Obsidian 打开 `test_note` 进行验证。

## 快速开始

1. 「设置 → Ob-Mail」中点击 **添加邮件账户**，填写邮箱、IMAP/SMTP 服务器与端口、用户名，在「密码/授权码」处从 Keychain 选择或新建密钥；
2. 点击 **测试 IMAP / 测试 SMTP** 验证配置；
3. 执行命令 **打开邮件客户端（Foxmail 风格）**（或命令面板搜索「收取邮件」）收取第一批邮件；
4. 工具栏点击 **写邮件** 开始发送：支持联系人补全、批量粘贴收件人、拖拽文件添加附件；
5. 收取的邮件以 Markdown 笔记形式存放在 `{存储路径}/{账户}/收件箱/YYYY-MM/` 下，可直接被 Obsidian 搜索、双链引用。

## 目录结构

```
obsidian-mail/
├── src/main.ts               # 插件全部源码（单文件，顶部有模块结构索引）
├── styles/foxmail-email.css  # 插件样式源文件（构建时复制为插件目录 styles.css）
├── styles/README-css-snippets.md  # 早期 CSS 片段文档（原根目录 readme，改名保留）
├── manifest.json             # Obsidian 插件清单
├── esbuild.config.js         # 构建脚本（含 CSS 复制插件）
├── version-bump.mjs          # 版本号递增脚本（仅递增 patch 位）
├── RELEASE_NOTES.md          # 发布说明与更新日志
├── docs/                     # 设计文档 / 使用手册 / 技术分析报告
├── test_note/                # 内置测试 Vault（含构建产物）
├── release/                  # 历史发布包与发布检查清单
└── .cowork-temp/             # 单元测试脚手架（test-parse.js 等）
```

> 仓库根目录（上一级）的 `reaadme.md` 是最初的需求规划与看板设计对话记录，保留作为设计演进的历史依据，详见 [docs/design.md](docs/design.md) 的偏差说明。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [docs/design.md](docs/design.md) | 设计文档：架构、数据结构、frontmatter 契约、存储布局、关键流程、安全设计 |
| [docs/USER_MANUAL.md](docs/USER_MANUAL.md) | 使用手册：账户配置、收发操作、拖拽附件、批量粘贴、常见问题 |
| [docs/ANALYSIS.md](docs/ANALYSIS.md) | 技术分析报告：优势、取舍、问题与技术债务、改进路线 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 版本发布说明与安装指南 |

## 命令一览

| 命令 | 说明 |
| --- | --- |
| 打开邮件客户端（Foxmail 风格） | 激活三栏邮件视图 |
| 发送邮件 | 打开写信标签页 |
| 从草稿发送邮件 | 选取草稿继续编辑 |
| 收取邮件 | 手动收取所有账户新邮件 |
| 重新收取邮件（重新解析已下载邮件） | 强制重新解析，用于修复解析问题 |
| 回复邮件 / 回复全部邮件 / 转发邮件 / 作为附件转发邮件 / 标记为垃圾邮件 | 针对当前活动邮件笔记的操作 |
