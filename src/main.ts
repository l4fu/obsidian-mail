import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, SecretComponent, ItemView, WorkspaceLeaf, MarkdownRenderer, setIcon, MarkdownView, Menu, normalizePath } from 'obsidian';

import * as path from 'path';
import * as net from 'net';
// 导入 imap 模块（修复构造函数问题）
import Imap from 'imap';
import * as mailparser from 'mailparser';
import * as nodemailer from 'nodemailer';
import { convert } from 'html-to-markdown';
import { ProxyAgent } from 'proxy-agent';

/**
 * ============================================================
 * Ob-Mail —— Obsidian 邮件客户端插件（Foxmail 风格）
 * ============================================================
 * 代码结构索引：
 *   1. 工具函数：formatHTMLSafely / formatHTMLIndentation
 *   2. 地址解析：ParsedAddress / parseEmailList / formatAddress / isValidEmail
 *   3. 数据类型：MailAccount / Contact / MailSettings / DEFAULT_SETTINGS
 *   4. Keychain：getPasswordFromKeychain
 *   5. 设置页：MailSettingTab
 *   6. 通用弹窗：ConfirmModal
 *   7. Foxmail 三栏邮件视图：MAIL_VIEW_TYPE / MailEntry / MailFoxmailView
 *   8. 写信标签页：COMPOSE_VIEW_TYPE / askComposeCloseChoice /
 *      ContactPickerModal / buildContactField / ObMailComposeView
 *   9. 主插件类：MailPlugin（收取/发送/草稿/联系人/同步/视图入口）
 *  10. 邮件操作：replyToEmail / forwardEmail / forwardEmailAsAttachment /
 *      markEmailAsSpam / replyAllEmail（均为函数声明，可在任意位置调用）
 * ============================================================
 */

/**
 * 简单字符串哈希（djb2），用于生成邮件唯一作用域类名
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 提取 HTML 中所有 <style> 块的 CSS 并移除它们
 */
function extractStyles(html: string): { css: string; html: string } {
  const cssParts: string[] = [];
  const cleaned = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => {
    cssParts.push(css);
    return '';
  });
  return { css: cssParts.join('\n'), html: cleaned };
}

/**
 * 给 CSS 选择器加作用域前缀，使其只在 .scope 内生效，避免污染 Obsidian 全局样式
 * 处理：选择器列表、body/html、@media 等 at 规则、keyframes 百分比
 */
function scopeCss(css: string, scope: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (m, selector: string, body: string) => {
    const sel = selector.trim();
    if (!sel) return m;
    // at 规则（@media/@supports/@font-face 等）与 keyframes 百分比不加前缀
    if (sel.startsWith('@')) return m;
    if (/^(from|to|\d+%?)$/i.test(sel)) return m;
    const scoped = sel.split(',').map((s: string) => {
      s = s.trim();
      if (!s) return s;
      if (s === 'body' || s === 'html' || s === ':root') return `.${scope}`;
      const bodyPrefix = s.match(/^(?:body|html)\s+(.*)$/i);
      if (bodyPrefix) return `.${scope} ${bodyPrefix[1]}`;
      return `.${scope} ${s}`;
    }).join(', ');
    return `${scoped} {${body}}`;
  });
}

/**
 * 将邮件 HTML 规范化为 Markdown 安全的原始 HTML 块：
 * - 去掉 doctype/html/head/body 外壳
 * - 每行去首尾空白、移除空行（空行会终结 Markdown HTML 块，缩进行会退化为代码块）
 */
function normalizeHtmlBlock(html: string): string {
  let out = html;
  out = out.replace(/<!DOCTYPE[^>]*>/gi, '');
  out = out.replace(/<\?xml[^>]*\?>/gi, '');
  out = out.replace(/<html[^>]*>/gi, '').replace(/<\/html>/gi, '');
  out = out.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  out = out.replace(/<body[^>]*>/gi, '').replace(/<\/body>/gi, '');
  out = out.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0).join('\n');
  return out;
}

/**
 * 清理邮件 HTML，解决 <style type="text/css"> 等块污染转换的问题：
 * 1. 移除 <style>/<script>/<head> 及注释（CSS 文本混入正文会导致转换失败/源码泄露）
 * 2. 去掉标签行首的缩进（Markdown 会把缩进的原始 HTML 行当作缩进代码块，导致表格显示为源码）
 * 保留表格等 HTML 结构，Obsidian 阅读视图可直接渲染
 */
function cleanHtmlForMarkdown(html: string): string {
  let out = html;
  // 移除 style / script / head 块（含内容）
  out = out.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  // 移除 HTML 注释
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // 去掉以 < 开头的行的前导空白，避免被 Markdown 解析为缩进代码块
  out = out.split('\n').map(line => line.replace(/^[\t ]+(?=<)/, '')).join('\n');
  return out;
}

/**
 * 安全的 HTML 格式化函数
 * 将 HTML 源码进行美化和语法高亮，便于阅读但不渲染
 * - 移除脚本和危险内容
 * - 格式化缩进
 * - 不下载远程资源
 */
function formatHTMLSafely(html: string): string {
  try {
    // 1. 创建 DOM 解析器
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // 2. 移除所有脚本标签
    const scripts = doc.querySelectorAll('script');
    scripts.forEach(script => script.remove());
    
    // 2.1 移除样式标签（CSS 源码不应展示）
    const styles = doc.querySelectorAll('style');
    styles.forEach(style => style.remove());
    
    // 3. 移除所有事件处理器（onclick 等）
    const allElements = doc.querySelectorAll('*');
    allElements.forEach(el => {
      // 移除所有 on* 属性
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
        }
        // 移除 javascript: 链接
        if (attr.name === 'href' || attr.name === 'src') {
          const value = attr.value.trim().toLowerCase();
          if (value.startsWith('javascript:')) {
            el.removeAttribute(attr.name);
          }
        }
      });
    });
    
    // 4. 获取清理后的 HTML
    let cleanHTML = doc.body.innerHTML;
    
    // 5. 格式化 HTML（添加缩进和换行）
    cleanHTML = formatHTMLIndentation(cleanHTML);
    
    // 6. 使用代码块包裹，便于在 Markdown 中查看
    return `\`\`\`html
${cleanHTML}
\`\`\``;
  } catch (error) {
    console.error('格式化 HTML 失败:', error);
    // 如果失败，返回原始 HTML 的简单格式化版本
    return `\`\`\`html
${html}
\`\`\``;
  }
}

/**
 * 格式化 HTML 缩进
 */
function formatHTMLIndentation(html: string): string {
  let formatted = '';
  let indentLevel = 0;
  const indentSize = 2;
  
  // 分割 HTML 标签
  const tokens = html.split(/(<[^>]+>)/g);
  
  for (let token of tokens) {
    if (!token.trim()) continue;
    
    // 检查是否是闭合标签
    if (token.match(/^<\//)) {
      indentLevel--;
    }
    
    // 添加当前 token（带缩进）
    const indent = ' '.repeat(Math.max(0, indentLevel * indentSize));
    formatted += '\n' + indent + token.trim();
    
    // 检查是否是自闭合标签或开始标签
    if (token.match(/^<(?!\/|!|--)/) && !token.match(/\/>$/)) {
      indentLevel++;
    }
  }
  
  return formatted.trim();
}


/**
 * 解析后的邮箱地址
 */
interface ParsedAddress {
  /** 显示名称（可为空） */
  name: string;
  /** 邮箱地址 */
  email: string;
}

/**
 * 健壮地解析收件人输入，兼容以下格式（Foxmail 风格）：
 * - a@b.com, c@d.com
 * - 姜<jiangy36@chinatelecom.cn>, 余帅<yujs2@chinatelecom.cn>
 * - "张三" <zhangsan@example.com>；李四<lisi@example.com>
 * 支持分隔符：英文逗号 , 中文逗号 ， 分号 ; 中文分号 ； 换行符 制表符（在尖括号/引号外才作为分隔符）
 * 兼容 Excel 两列复制：「姓名 TAB 邮箱」相邻两个条目自动配对为 姓名<邮箱>
 */
function parseEmailList(input: string): ParsedAddress[] {
  if (!input || !input.trim()) return [];

  // 1. 按顶层分隔符切分（忽略 <...> 与 "..." 内部的分隔符）
  const tokens: string[] = [];
  let current = '';
  let inAngle = false;
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inAngle) {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (ch === '<' && !inQuote) {
      inAngle = true;
      current += ch;
      continue;
    }
    if (ch === '>' && !inQuote) {
      inAngle = false;
      current += ch;
      continue;
    }
    if (!inAngle && !inQuote && (ch === ',' || ch === '，' || ch === ';' || ch === '；' || ch === '\n' || ch === '\r' || ch === '\t')) {
      tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) tokens.push(current);

  // 1.5 Excel 两列兼容：「姓名 + 邮箱」相邻两个条目配对为 姓名<邮箱>
  //     （从 Excel 复制两列粘贴时，每行是「姓名<TAB>邮箱」，切分后姓名与邮箱相邻）
  const pureEmailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const mergedTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (!token) continue;
    const next = i + 1 < tokens.length ? tokens[i + 1].trim() : '';
    if (!token.includes('@') && !token.includes('<') && next && pureEmailPattern.test(next)) {
      mergedTokens.push(`${token}<${next}>`);
      i++; // 消费掉已配对的邮箱条目
    } else {
      mergedTokens.push(token);
    }
  }

  // 2. 逐个解析 token 为 { name, email }
  const results: ParsedAddress[] = [];
  for (const raw of mergedTokens) {
    const token = raw.trim();
    if (!token) continue;

    // 形如 名称<email> 或 "名称" <email>
    const angleMatch = token.match(/^\s*(?:"([^"]*)"|([^<]*?))\s*<([^<>]+)>\s*$/);
    if (angleMatch) {
      const name = (angleMatch[1] !== undefined ? angleMatch[1] : angleMatch[2] || '').trim();
      const email = angleMatch[3].trim();
      if (email) {
        results.push({ name, email });
        continue;
      }
    }

    // 纯邮箱地址
    const emailOnly = token.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailOnly) {
      const email = emailOnly[0];
      let name = token.replace(email, '').replace(/[<>"\s]/g, '').trim();
      results.push({ name, email });
      continue;
    }

    // 无法识别的内容，保留原文作为 email（发送前会被校验拦截）
    results.push({ name: '', email: token });
  }
  return results;
}

/**
 * 将解析后的地址格式化为 RFC 5322 形式，供 nodemailer 使用
 */
function formatAddress(addr: ParsedAddress): string {
  if (!addr.name) return addr.email;
  // 名称包含特殊字符时加引号
  if (/[",<>@\\]/.test(addr.name)) {
    return `"${addr.name.replace(/"/g, '\\"')}" <${addr.email}>`;
  }
  return `${addr.name} <${addr.email}>`;
}

/**
 * 校验邮箱地址是否合法
 */
function isValidEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

/**
 * 邮件账户配置接口 
 */
interface MailAccount {
  /** 账户唯一标识 */
  id: string;
  /** 账户显示名称 配置项：账户名称 */
  name: string;
  /** 邮箱地址（发件人地址） 配置项：发件人地址 */
  email: string;
  
  // --- 服务器配置 ---
  /** IMAP 服务器主机地址 */
  imapHost: string;
  /** IMAP 服务器端口（默认 993） */
  imapPort: number;
  /** SMTP 服务器主机地址 */
  smtpHost: string;
  /** SMTP 服务器端口（默认 587/465） */
  smtpPort: number;
  
  // --- 认证与安全 ---
  /** 登录用户名 */
  username: string;
  /** 登录密码或应用授权码 配置项：密码/授权码 */
  passwordSecretId: string; // 存储 Keychain 中的密钥 ID，而不是明文密码
  /** @deprecated 保留字段以兼容旧数据，实际不再使用明文密码 */
  password?: string;
  /** 是否使用 SSL/TLS 加密 */
  secure: boolean;
  /** 是否跳过 TLS 证书验证（用于自签名证书或特定代理环境） */
  tls: boolean;
  
  /** 邮件签名 配置项：签名设置 */
  signature: string;
  
  // --- 代理设置 ---
  /** 是否针对此账户启用网络代理 */
  proxyEnabled: boolean;
  /** 代理服务器地址 */
  proxyHost: string;
  /** 代理服务器端口 */
  proxyPort: number;
  /** 代理协议类型 */
  proxyType: 'http' | 'https';
  /** 代理认证用户名 */
  proxyUsername: string;
  /** 代理认证密码 */
  proxyPassword: string;
}

/**
 * 联系人信息接口
 */
interface Contact {
  /** 唯一标识符 */
  id: string;
  /** 显示姓名 */
  name: string;
  /** 电子邮箱地址 */
  email: string;
}

/**
 * 插件全局设置接口
 * 对应 design.md 2.1.1 邮件账户管理
 */
interface MailSettings {
  /** 已配置的邮件账户列表 */
  accounts: MailAccount[];
  /** 邮件在 Vault 中的存储根目录 */
  obmailStoragePath: string;
  /** 附件存储的子目录名称（默认为 attachments） */
  obmailAttachmentDir: string;
  /** 联系人列表，用于发送邮件时的自动补全 */
  contacts: Contact[];
  /** 
   * 已获取的邮件 ID 映射表
   * 键为账户名或 ID，值为已下载的邮件 messageId 数组，用于增量同步去重
   */
  fetchedEmailIds: Record<string, string[]>;
  /** 邮件自动同步的时间间隔（分钟） */
  syncInterval: number;
  /** HTML 邮件正文的显示模式：'html-styled'（保留原始样式，作用域 CSS）/ 'markdown'（转换为 Markdown）/ 'formatted'（格式化 HTML 源码） */
  htmlDisplayMode: 'html-styled' | 'markdown' | 'formatted';
  /** 邮件存储模式：'monthly'（按年月存储：YYYY-MM/）/ 'daily'（按年月日存储：YYYY-MM/YYYY-MM-DD/） */
  storageMode: 'monthly' | 'daily';
  /** 超大邮件阈值（MB）：整封大小（RFC822.SIZE）超过此值的邮件默认不自动下载正文/附件，仅记录待手动下载，符合一般邮件服务器对大报文的限流约束 */
  largeEmailThresholdMB: number;
  /** 因超过阈值而被跳过自动下载的邮件（按账户记录元数据，供后续手动下载） */
  oversizedEmails: Record<string, Array<{ uid: number; messageId: string; subject: string; size: number }>>;
  /** 收取成功后是否在服务器上把该邮件标记为已读（\Seen）。开启后搜索只取未读，可大幅减少每次同步的服务端访问；关闭则每次都会扫描全部并靠 Message-ID 去重 */
  markAsReadAfterFetch: boolean;
}

// 默认设置 - 邮件账户管理
const DEFAULT_SETTINGS: MailSettings = {
  accounts: [], // 默认没有邮件账户
  obmailStoragePath: '3-mail', // 默认邮件存储目录 - 配置项：存储路径配置
  obmailAttachmentDir: 'attachments', // 默认附件目录 - 配置项：存储路径配置
  contacts: [], // 默认没有联系人
  fetchedEmailIds: {}, // 默认没有已获取的邮件 ID - 用于去重
  syncInterval: 5, // 默认邮件同步周期为 5 分钟 - 邮件收取功能：自动收取间隔
  htmlDisplayMode: 'html-styled', // 默认保留原始样式渲染（作用域 CSS，不污染 Obsidian）
  storageMode: 'daily', // 默认按年月日存储（YYYY-MM/YYYY-MM-DD/）
  largeEmailThresholdMB: 10, // 默认整封超过 10MB 视为超大邮件，不自动下载
  oversizedEmails: {}, // 默认无被跳过的超大邮件记录
  markAsReadAfterFetch: true // 默认收取后在服务器标记已读，使后续同步只取未读、减少服务端访问
}

// 辅助函数：从 Keychain 获取密码（支持向后兼容）
async function getPasswordFromKeychain(app: App, passwordSecretId: string, fallbackPassword?: string): Promise<string> {
  // 优先尝试从 Keychain 读取
  if (passwordSecretId) {
    try {
      // Obsidian 1.11.4+ 使用 app.secretStorage 访问 Keychain API
      const secretsApi = (app as any).secretStorage;
      if (!secretsApi) {
        console.warn('当前 Obsidian 版本不支持 Keychain 功能 (secretStorage 不存在)，将使用备用密码');
        if (fallbackPassword) {
          return fallbackPassword;
        }
        throw new Error('当前 Obsidian 版本不支持 Keychain 功能，请在账户设置中重新配置密码');
      }
      
      console.log('Keychain API 可用，尝试读取密码，密钥 ID:', passwordSecretId);
      
      // SecretStorage API 没有 isEnabled 方法，直接调用 getSecret
      // 如果 Keychain 未启用或密钥不存在，getSecret 会返回 null
      const password = await secretsApi.getSecret(passwordSecretId);
      
      if (!password) {
        console.warn('Keychain 中未找到密码 (ID:', passwordSecretId, ') 或 Keychain 未启用，将使用备用密码');
        if (fallbackPassword) {
          return fallbackPassword;
        }
        throw new Error('Keychain 中未找到密码，请重新配置');
      }
      
      console.log('✅ 成功从 Keychain 读取密码');
      return password;
    } catch (error: any) {
      console.error('Keychain 操作异常:', {
        errorType: error?.constructor?.name || 'Unknown',
        errorMessage: error?.message || 'Unknown error',
        stack: error?.stack
      });
      
      // 如果是备用密码可用，则使用备用密码
      if (fallbackPassword) {
        console.log('使用备用密码（Keychain 不可用）');
        return fallbackPassword;
      }
      
      console.error('从 Keychain 读取密码失败:', error);
      throw new Error(`读取密码失败：${error.message}`);
    }
  } else if (fallbackPassword) {
    // 没有配置 Keychain，但有备用密码
    console.log('未配置 Keychain (passwordSecretId 为空)，使用备用密码');
    return fallbackPassword;
  } else {
    throw new Error('未配置密码，请在账户设置中配置 Keychain 密码或检查账户配置');
  }
}

// 设置选项卡类
class MailSettingTab extends PluginSettingTab {
  plugin: MailPlugin;

  constructor(app: App, plugin: MailPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;

    // 清空容器
    containerEl.empty();

    // 默认存储设置部分
    new Setting(containerEl).setName('默认存储设置').setHeading();
    
    // 默认邮件存储路径
    new Setting(containerEl)
      .setName('默认邮件存储路径')
      .setDesc('设置邮件保存的默认路径')
      .addText(text => text
        .setPlaceholder('输入邮件存储路径')
        .setValue(this.plugin.settings.obmailStoragePath)
        .onChange(async (value) => {
          this.plugin.settings.obmailStoragePath = value;
          await this.plugin.saveSettings();
        }));
    
    // 默认附件目录
    new Setting(containerEl)
      .setName('默认附件目录')
      .setDesc('设置附件保存的默认子目录名称')
      .addText(text => text
        .setPlaceholder('输入附件保存的默认子目录名称')
        .setValue(this.plugin.settings.obmailAttachmentDir)
        .onChange(async (value) => {
          this.plugin.settings.obmailAttachmentDir = value;
          await this.plugin.saveSettings();
        }));



    // 邮件同步周期设置
    new Setting(containerEl)
      .setName('邮件同步周期')
      .setDesc('设置自动收取邮件的时间间隔（分钟）')
      .addText(text => text
        .setPlaceholder('输入同步周期（分钟）')
        .setValue(this.plugin.settings.syncInterval.toString())
        .onChange(async (value) => {
          const interval = parseInt(value) || 5;
          this.plugin.settings.syncInterval = interval;
          await this.plugin.saveSettings();
          // 更新自动同步定时器
          this.plugin.updateSyncTimer();
        }));

    // 超大邮件阈值设置
    new Setting(containerEl)
      .setName('超大邮件阈值（MB）')
      .setDesc('整封邮件（含附件）超过此大小时，不再整封下载，而是仅收取正文、跳过大附件（可在命令面板手动整封下载），避免触发邮件服务器对大报文的限流或断连。设为 0 表示不限制、一律整封下载。')
      .addText(text => text
        .setPlaceholder('默认 10')
        .setValue((this.plugin.settings.largeEmailThresholdMB ?? 10).toString())
        .onChange(async (value) => {
          const mb = Math.max(0, parseInt(value) || 0);
          this.plugin.settings.largeEmailThresholdMB = mb;
          await this.plugin.saveSettings();
        }));

    // 收取后标记已读
    new Setting(containerEl)
      .setName('收取后在服务器标记已读')
      .setDesc('开启后，成功收取的邮件会在服务器上标记为已读（\\Seen），后续同步只搜索未读邮件，可显著减少服务端访问次数与重复扫描；已收取的邮件也不会再出现在未读/收件箱视图中。关闭则每次全量扫描并靠 Message-ID 去重。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.markAsReadAfterFetch ?? true)
        .onChange(async (value) => {
          this.plugin.settings.markAsReadAfterFetch = value;
          await this.plugin.saveSettings();
        }));
    
    // HTML 邮件显示模式
    new Setting(containerEl)
      .setName('HTML 邮件显示模式')
      .setDesc('选择如何处理和显示 HTML 格式的邮件正文')
      .addDropdown(dropdown => dropdown
        .addOption('html-styled', '保留原始样式渲染（推荐）')
        .addOption('markdown', '转换为 Markdown')
        .addOption('formatted', '格式化 HTML 源码（安全查看）')
        .setValue(this.plugin.settings.htmlDisplayMode || 'html-styled')
        .onChange(async (value: 'html-styled' | 'markdown' | 'formatted') => {
          this.plugin.settings.htmlDisplayMode = value;
          await this.plugin.saveSettings();
          new Notice(`HTML 显示模式已更改为：${value === 'html-styled' ? '保留原始样式' : value === 'markdown' ? 'Markdown' : '格式化 HTML'}`);
        }));

    // 邮件存储模式
    new Setting(containerEl)
      .setName('邮件存储模式')
      .setDesc('选择邮件文件的文件夹组织方式')
      .addDropdown(dropdown => dropdown
        .addOption('monthly', '按年月存储（YYYY-MM/）')
        .addOption('daily', '按年月日存储（YYYY-MM/YYYY-MM-DD/）')
        .setValue(this.plugin.settings.storageMode || 'daily')
        .onChange(async (value: 'monthly' | 'daily') => {
          this.plugin.settings.storageMode = value;
          await this.plugin.saveSettings();
          new Notice(`邮件存储模式已更改为：${value === 'monthly' ? '按年月' : '按年月日'}`);
        }));

    // 邮件账户配置部分
    new Setting(containerEl).setName('邮件账户配置').setHeading();
    
    // 添加账户按钮
    new Setting(containerEl)
      .setName('添加邮件账户')
      .setDesc('添加新的邮件账户')
      .addButton(button => button
        .setButtonText('添加')
        .onClick(async () => {
          try {
            // 创建新账户 ID
            const newAccount: MailAccount = {
              id: `account-${Date.now()}`,
              name: `账户 ${this.plugin.settings.accounts.length + 1}`,
              email: '',
              imapHost: '',
              imapPort: 993,
              smtpHost: '',
              smtpPort: 587,
              username: '',
              passwordSecretId: '', // 新增：Keychain 密钥 ID
              secure: true,
              tls: true,
              signature: '',
              // 代理设置默认值
              proxyEnabled: false,
              proxyHost: '',
              proxyPort: 8080,
              proxyType: 'http',
              proxyUsername: '',
              proxyPassword: ''
            };
            
            this.plugin.settings.accounts.push(newAccount);
            await this.plugin.saveSettings();
            this.display(); // 重新渲染设置界面
          } catch (err) {
            console.error('添加账户失败:', err);
            new Notice('添加账户失败，请检查控制台');
          }
        }));
    
    // 显示现有账户（外观样式统一由 styles.css 的 .mail-account* 类提供）
    this.plugin.settings.accounts.forEach((account, index) => {
      const accountDiv = containerEl.createDiv('mail-account');

      // 创建可折叠头部
      const headerDiv = accountDiv.createDiv('mail-account-header');

      // 账户名称（用 span 而非 h3，避免直接创建标题元素；视觉字重由 .mail-account-name 提供）
      const accountName = headerDiv.createSpan({text: account.name, cls: 'mail-account-name'});

      // 折叠/展开按钮
      const toggleBtn = headerDiv.createEl('button', {text: '▶', cls: 'mail-account-toggle'});

      // 创建内容区域（默认折叠，is-expanded 类控制展开）
      const contentDiv = accountDiv.createDiv('mail-account-content');
      
      // 基本信息
      new Setting(contentDiv)
        .setName('账户名称')
        .addText(text => text
          .setValue(account.name)
          .onChange(async (value) => {
            account.name = value;
            await this.plugin.saveSettings();
            accountName.textContent = value;
          }));
      
      new Setting(contentDiv)
        .setName('邮箱地址')
        .addText(text => text
          .setValue(account.email)
          .onChange(async (value) => {
            account.email = value;
            await this.plugin.saveSettings();
          }));
      
      // IMAP设置
      new Setting(contentDiv).setName('IMAP设置').setHeading();
      
      new Setting(contentDiv)
        .setName('IMAP服务器')
        .addText(text => text
          .setValue(account.imapHost)
          .onChange(async (value) => {
            account.imapHost = value;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('IMAP端口')
        .addText(text => text
          .setValue(account.imapPort.toString())
          .onChange(async (value) => {
            account.imapPort = parseInt(value) || 993;
            await this.plugin.saveSettings();
          }));
      
      // SMTP设置
      new Setting(contentDiv).setName('SMTP设置').setHeading();
      
      new Setting(contentDiv)
        .setName('SMTP服务器')
        .addText(text => text
          .setValue(account.smtpHost)
          .onChange(async (value) => {
            account.smtpHost = value;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('SMTP端口')
        .addText(text => text
          .setValue(account.smtpPort.toString())
          .onChange(async (value) => {
            account.smtpPort = parseInt(value) || 587;
            await this.plugin.saveSettings();
          }));
      
      // 账户认证信息
      new Setting(contentDiv).setName('账户认证').setHeading();
      
      new Setting(contentDiv)
        .setName('用户名')
        .addText(text => text
          .setValue(account.username)
          .onChange(async (value) => {
            account.username = value;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('密码/授权码')
        .setDesc('从 Obsidian Keychain 选择或添加密钥，安全存储不暴露明文')
        .addComponent((container) => {
          const secretComp = new SecretComponent(this.app, container);
          secretComp
            .setValue(account.passwordSecretId || '')
            .onChange(async (secretId) => {
              account.passwordSecretId = secretId;
              await this.plugin.saveSettings();
              new Notice('密码已保存到 Keychain');
            });
          return secretComp;
        });
      
      // 安全设置
      new Setting(contentDiv).setName('安全设置').setHeading();
      
      new Setting(contentDiv)
        .setName('使用SSL/TLS')
        .addToggle(toggle => toggle
          .setValue(account.secure)
          .onChange(async (value) => {
            account.secure = value;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('跳过证书验证')
        .addToggle(toggle => toggle
          .setValue(account.tls)
          .onChange(async (value) => {
            account.tls = value;
            await this.plugin.saveSettings();
          }));
      
      // 签名设置
      new Setting(contentDiv).setName('签名设置').setHeading();
      
      new Setting(contentDiv)
        .setName('邮件签名')
        .setDesc('在发送邮件时自动添加的签名')
        .addTextArea(textArea => {
          textArea.inputEl.rows = 4;

          return textArea
            .setValue(account.signature)
            .setPlaceholder('输入邮件签名...')
            .onChange(async (value) => {
              account.signature = value;
              await this.plugin.saveSettings();
            });
        });
      
      // 代理设置
      new Setting(contentDiv).setName('代理设置').setHeading();
      
      // 为旧账户添加代理字段的默认值
      if (account.proxyEnabled === undefined) account.proxyEnabled = false;
      if (account.proxyHost === undefined) account.proxyHost = '';
      if (account.proxyPort === undefined) account.proxyPort = 8080;
      if (account.proxyType === undefined) account.proxyType = 'http';
      if (account.proxyUsername === undefined) account.proxyUsername = '';
      if (account.proxyPassword === undefined) account.proxyPassword = '';
      
      new Setting(contentDiv)
        .setName('启用代理')
        .setDesc('通过代理服务器访问邮件服务')
        .addToggle(toggle => toggle
          .setValue(account.proxyEnabled)
          .onChange(async (value) => {
            account.proxyEnabled = value;
            await this.plugin.saveSettings();
            
            // 直接更新所有代理相关输入框的禁用状态，而不是重新渲染整个界面
            const accountDiv = contentDiv.parentElement;
            if (accountDiv) {
              // 查找所有代理相关的输入框
              const proxyInputs = accountDiv.querySelectorAll('.setting-item-control input, .setting-item-control select');
              const proxySettings = ['代理服务器', '代理端口', '代理类型', '代理用户名', '代理密码'];
              
              // 遍历所有设置项
              proxyInputs.forEach(el => {
                const input = el as HTMLInputElement | HTMLSelectElement;
                const settingItem = input.closest('.setting-item');
                if (settingItem) {
                  const settingName = settingItem.querySelector('.setting-item-name')?.textContent;
                  if (settingName && proxySettings.includes(settingName)) {
                    input.disabled = !value;
                  }
                }
              });
            }
          }));
      
      new Setting(contentDiv)
        .setName('代理服务器')
        .addText(text => text
          .setValue(account.proxyHost)
          .setDisabled(!account.proxyEnabled)
          .onChange(async (value) => {
            account.proxyHost = value;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('代理端口')
        .addText(text => text
          .setValue((account.proxyPort || 8080).toString())
          .setDisabled(!account.proxyEnabled)
          .onChange(async (value) => {
            account.proxyPort = parseInt(value) || 8080;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('代理类型')
        .addDropdown(dropdown => dropdown
          .addOption('http', 'HTTP')
          .addOption('https', 'HTTPS')
          .setValue(account.proxyType)
          .setDisabled(!account.proxyEnabled)
          .onChange(async (value) => {
            account.proxyType = value as 'http' | 'https';
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('代理用户名')
        .addText(text => text
          .setValue(account.proxyUsername)
          .setDisabled(!account.proxyEnabled)
          .onChange(async (value) => {
            account.proxyUsername = value;
            await this.plugin.saveSettings();
          }));
      
      new Setting(contentDiv)
        .setName('代理密码')
        .addText(text => text
          .setValue(account.proxyPassword)
          .setDisabled(!account.proxyEnabled)
          .onChange(async (value) => {
            account.proxyPassword = value;
            await this.plugin.saveSettings();
          }));
      
      // 测试连接按钮
      new Setting(contentDiv)
        .setName('测试连接')
        .setDesc('测试IMAP和SMTP连接配置是否正确')
        .addButton(button => button
          .setButtonText('测试IMAP')
          .onClick(async () => {
            try {
              await this.plugin.testIMAPConnection(account);
              new Notice('IMAP连接测试成功');
            } catch (error) {
              console.error('IMAP连接测试失败:', error);
              new Notice(`IMAP连接测试失败: ${error instanceof Error ? error.message : '未知错误'}`);
            }
          }))
        .addButton(button => button
          .setButtonText('测试SMTP')
          .onClick(async () => {
            try {
              await this.plugin.testSMTPConnection(account);
              new Notice('SMTP连接测试成功');
            } catch (error) {
              console.error('SMTP连接测试失败:', error);
              new Notice(`SMTP连接测试失败: ${error instanceof Error ? error.message : '未知错误'}`);
            }
          }));
      
      // 删除账户按钮
      new Setting(contentDiv)
        .addButton(button => button
          .setButtonText('删除账户')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.accounts.splice(index, 1);
            await this.plugin.saveSettings();
            this.display(); // 重新渲染设置界面
          }));
      
      // 折叠/展开功能（is-expanded 类切换，样式见 styles.css）
      let isExpanded = false;
      headerDiv.addEventListener('click', () => {
        isExpanded = !isExpanded;
        toggleBtn.textContent = isExpanded ? '▼' : '▶';
        contentDiv.toggleClass('is-expanded', isExpanded);
      });
    });
  }
}

// 确认模态框类 - 用于询问是否下载超过15天的邮件
class ConfirmModal extends Modal {
  onConfirm: () => void;
  onCancel: () => void;
  message: string;

  constructor(app: App, message: string, onConfirm: () => void, onCancel: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: '确认下载' });
    contentEl.createEl('p', { text: this.message });

    const buttonContainer = contentEl.createDiv('obmail-modal-btn-row');

    // 取消按钮
    const cancelBtn = buttonContainer.createEl('button', {
      text: '取消',
      cls: 'mod-cta obmail-modal-btn-cancel'
    });
    cancelBtn.addEventListener('click', () => {
      this.onCancel();
      this.close();
    });

    // 确认按钮
    const confirmBtn = buttonContainer.createEl('button', {
      text: '确认',
      cls: 'mod-cta obmail-modal-btn-confirm'
    });
    confirmBtn.addEventListener('click', () => {
      this.onConfirm();
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    
    // 清理联系人选择模态框
    const contactModal = document.querySelector('.contact-select-modal');
    if (contactModal) {
      contactModal.remove();
    }
  }
}
 
// ==================== Foxmail 风格邮件视图 ====================

export const MAIL_VIEW_TYPE = 'obsidian-mail-foxmail-view';

/** 视图内部使用的邮件条目 */
interface MailEntry {
  file: TFile;
  /** inbox=收件箱 sent=已发送 draft=草稿箱 spam=垃圾邮件 */
  folder: 'inbox' | 'sent' | 'draft' | 'spam';
  account: string;
  fm: Record<string, any>;
  unread: boolean;
  hasAttachment: boolean;
  date: Date;
}

/**
 * Foxmail 风格三栏邮件视图：
 * 左栏：账户/文件夹树（收件箱/已发送/草稿箱 + 未读计数）
 * 中栏：邮件列表（未读加粗、附件回形针、日期）
 * 右栏：阅读窗格（Foxmail 邮件头 + 渲染正文 + 回复/转发操作）
 */
class MailFoxmailView extends ItemView {
  plugin: MailPlugin;

  private entries: MailEntry[] = [];
  private selectedFolder: { account: string; folder: string } | null = null;
  private selectedEntry: MailEntry | null = null;
  private searchQuery = '';
  private refreshTimer: number | null = null;
  /** 阅读窗格邮件头信息是否折叠（会话内保持） */
  private metaCollapsed = false;
  /** 列表多选：选中的邮件笔记路径（Ctrl+点击切换） */
  private multiSelected: Set<string> = new Set();
  /** 顶部账号/文件夹区域是否折叠 */
  private foldersCollapsed = false;
  /** 当前选中的账号（下拉选择器） */
  private selectedAccount = '';

  private foldersEl!: HTMLElement;
  private listEl!: HTMLElement;
  private readerEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private searchInputEl!: HTMLInputElement;
  private accountSelectEl!: HTMLSelectElement;
  private foldersContainerEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: MailPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MAIL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '邮件客户端';
  }

  getIcon(): string {
    return 'mail';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('foxmail-view');

    // 整体布局：左右两列
    // 左列：A 区域（账号下拉 + 文件夹标签）+ 邮件列表（同宽）
    // 右列：工具栏（收件/写邮件/回复等）+ 邮件正文
    const layout = container.createDiv('foxmail-layout');

    // 左列
    const leftColumn = layout.createDiv('foxmail-left-column');

    // A 区域：账号下拉 + 文件夹标签
    const foldersHeader = leftColumn.createDiv('foxmail-folders-header');
    
    // 第一行：折叠按钮 + 账号下拉
    const topRow = foldersHeader.createDiv('foxmail-folders-top-row');
    const collapseBtn = topRow.createDiv('foxmail-folders-collapse-btn');
    collapseBtn.setAttr('title', '折叠/展开文件夹');
    setIcon(collapseBtn, 'chevron-up');
    collapseBtn.addEventListener('click', () => {
      this.foldersCollapsed = !this.foldersCollapsed;
      this.foldersContainerEl.classList.toggle('is-collapsed', this.foldersCollapsed);
      setIcon(collapseBtn, this.foldersCollapsed ? 'chevron-down' : 'chevron-up');
    });

    // 账号下拉选择器
    this.accountSelectEl = topRow.createEl('select', { cls: 'foxmail-account-select' });
    this.accountSelectEl.addEventListener('change', () => {
      this.selectedAccount = this.accountSelectEl.value;
      this.selectedFolder = { account: this.selectedAccount, folder: 'inbox' };
      this.selectedEntry = null;
      this.multiSelected.clear();
      this.renderFolders();
      this.renderList();
      this.renderReader();
    });

    // 第二行：文件夹标签（可折叠）
    this.foldersContainerEl = foldersHeader.createDiv('foxmail-folders-container');
    this.foldersEl = this.foldersContainerEl.createDiv('foxmail-folders');

    // 邮件列表（与 A 同宽）
    this.listEl = leftColumn.createDiv('foxmail-list');

    // 右列
    const rightColumn = layout.createDiv('foxmail-right-column');

    // 工具栏（Foxmail 主工具栏）
    const toolbar = rightColumn.createDiv('foxmail-toolbar');
    this.addToolbarButton(toolbar, 'download-cloud', '收取', '收取邮件', () => this.plugin.receiveEmail());
    this.addToolbarButton(toolbar, 'pen-line', '写邮件', '写新邮件', () => this.plugin.openComposeView());
    this.addToolbarButton(toolbar, 'reply', '回复', '回复当前邮件', () => this.doReply());
    this.addToolbarButton(toolbar, 'reply-all', '全部回复', '回复全部', () => this.doReplyAll());
    this.addToolbarButton(toolbar, 'forward', '转发', '转发当前邮件', () => this.doForward());
    this.addToolbarButton(toolbar, 'mail-check', '标记', '切换已读/未读', () => this.doToggleRead());
    this.addToolbarButton(toolbar, 'trash', '删除', '删除当前邮件', () => this.doDelete());

    // 搜索框
    const searchWrap = toolbar.createDiv('foxmail-search');
    this.searchInputEl = searchWrap.createEl('input', { type: 'text', placeholder: '搜索邮件…', cls: 'foxmail-search-input' });
    this.searchInputEl.addEventListener('input', () => {
      this.searchQuery = this.searchInputEl.value.trim().toLowerCase();
      this.renderList();
    });

    // 邮件正文（阅读窗格）
    this.readerEl = rightColumn.createDiv('foxmail-reader');

    // 底部状态栏
    this.statusEl = container.createDiv('foxmail-statusbar');

    // 监听 Vault 变化，自动刷新（防抖）
    this.registerEvent(this.app.vault.on('create', (f) => this.scheduleRefresh(f)));
    this.registerEvent(this.app.vault.on('modify', (f) => this.scheduleRefresh(f)));
    this.registerEvent(this.app.vault.on('delete', (f) => this.scheduleRefresh(f)));
    this.registerEvent(this.app.vault.on('rename', (f) => this.scheduleRefresh(f)));

    await this.refresh();
  }

  async onClose() {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private addToolbarButton(parent: HTMLElement, icon: string, label: string, title: string, onClick: () => void) {
    const btn = parent.createDiv('foxmail-toolbar-btn');
    btn.setAttr('title', title);
    const iconEl = btn.createDiv('foxmail-toolbar-icon');
    setIcon(iconEl, icon);
    btn.createSpan({ text: label, cls: 'foxmail-toolbar-label' });
    btn.addEventListener('click', onClick);
    return btn;
  }

  private scheduleRefresh(f: any) {
    // 只关心存储目录内的变化
    if (f && f.path && !String(f.path).startsWith(this.plugin.settings.obmailStoragePath)) {
      return;
    }
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 800);
  }

  /** 扫描 Vault 中的邮件笔记 */
  async refresh() {
    const basePath = this.plugin.settings.obmailStoragePath;
    const entries: MailEntry[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(basePath + '/')) continue;
      // 跳过附件目录中的 md 文件（非邮件）
      const attDir = this.plugin.settings.obmailAttachmentDir;
      if (attDir && file.path.includes(`/${attDir}/`)) continue;
      const rel = file.path.substring(basePath.length + 1);
      const parts = rel.split('/');
      const account = parts[0] || '默认账户';

      let folder: MailEntry['folder'] | null = null;
      if (file.path.includes('/收件箱/')) folder = 'inbox';
      else if (file.path.includes('/已发送/')) folder = 'sent';
      else if (file.path.includes('/草稿箱/')) folder = 'draft';
      else if (file.path.includes('/垃圾邮件/')) folder = 'spam';
      if (!folder) continue;

      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
      const type = fm.type || '';
      // 只收录邮件类笔记（收件邮件/已发送/草稿）
      if (type !== '邮件笔记' && type !== '发出邮件' && type !== 'draft') continue;

      // 邮件时间 = 收发时刻（写入时固化），与阅读/标记已读等文件修改无关
      const mailDate = this.extractMailDate(fm, file);

      // 附件检测：frontmatter 的 atta 字段或正文的附件链接
      const content = await this.app.vault.cachedRead(file);
      const hasAttachment = !!fm.atta || /## 附件/.test(content);

      entries.push({
        file,
        folder,
        account,
        fm,
        unread: fm.status === '未读',
        hasAttachment,
        date: mailDate
      });
    }

    // 按邮件收发时刻由新到旧排序（不受阅读/标记已读等文件修改影响）
    entries.sort((a, b) => b.date.getTime() - a.date.getTime());
    this.entries = entries;

    // 默认选中第一个账户的收件箱
    if (!this.selectedFolder) {
      const first = entries[0];
      if (first) {
        this.selectedFolder = { account: first.account, folder: 'inbox' };
      } else if (this.plugin.settings.accounts.length > 0) {
        this.selectedFolder = { account: this.plugin.settings.accounts[0].name, folder: 'inbox' };
      } else {
        this.selectedFolder = { account: '', folder: 'inbox' };
      }
    }

    this.renderFolders();
    this.renderList();
    this.renderReader();
  }

  /** 从文件名中提取时间戳（收件邮件文件名形如 主题2026-08-22-15-04-05-000000.md） */
  private extractDateFromFilename(name: string): Date | null {
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
      if (!isNaN(d.getTime())) return d;
    }
    const m2 = name.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m2) {
      const d = new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  }

  /** 提取邮件的收发时刻（用于列表排序）：frontmatter created → 文件名时间戳 → 文件创建时间。
   *  不使用 mtime：标记已读/编辑会更新 mtime，导致列表变成「阅读时刻」排序 */
  private extractMailDate(fm: Record<string, any>, file: TFile): Date {
    const created = fm.created;
    if (created) {
      if (created instanceof Date) {
        if (!isNaN(created.getTime())) return created;
      } else {
        const s = String(created);
        // 优先按原始格式解析（YYYY-MM-DD HH:mm:ss）
        let d = new Date(s);
        if (isNaN(d.getTime())) d = new Date(s.replace(/-/g, '/'));
        if (!isNaN(d.getTime())) return d;
      }
    }
    const fromName = this.extractDateFromFilename(file.basename);
    if (fromName) return fromName;
    // 兜底用文件创建时间（邮件落盘时刻 ≈ 收取时刻），而非修改时间
    return file.stat.ctime ? new Date(file.stat.ctime) : new Date(file.stat.mtime);
  }

  /** 顶部 A 区域：账号下拉 + 文件夹标签 */
  private renderFolders() {
    this.foldersEl.empty();

    // 汇总：账户 -> 文件夹 -> {total, unread}
    const tree: Record<string, Record<string, { total: number; unread: number }>> = {};
    for (const e of this.entries) {
      if (!tree[e.account]) tree[e.account] = {};
      if (!tree[e.account][e.folder]) tree[e.account][e.folder] = { total: 0, unread: 0 };
      tree[e.account][e.folder].total++;
      if (e.unread) tree[e.account][e.folder].unread++;
    }

    // 确保已配置账户也显示（即使没有邮件）
    for (const acc of this.plugin.settings.accounts) {
      if (!tree[acc.name]) tree[acc.name] = {};
    }

    const folderDefs: Array<{ key: string; label: string; icon: string }> = [
      { key: 'inbox', label: '收件箱', icon: '📥' },
      { key: 'sent', label: '已发送', icon: '📤' },
      { key: 'draft', label: '草稿箱', icon: '📝' },
      { key: 'spam', label: '垃圾邮件', icon: '🚫' }
    ];

    const accountNames = Object.keys(tree);

    // 更新账号下拉选择器
    this.accountSelectEl.empty();
    if (accountNames.length === 0) {
      this.accountSelectEl.createEl('option', { text: '暂无账户', value: '' });
    } else {
      for (const accName of accountNames) {
        const option = this.accountSelectEl.createEl('option', { text: accName || '默认账户', value: accName });
        if (accName === this.selectedAccount) {
          option.selected = true;
        }
      }
      // 若当前选中账号不在列表中，默认选第一个
      if (!this.selectedAccount || !accountNames.includes(this.selectedAccount)) {
        this.selectedAccount = accountNames[0];
        this.accountSelectEl.value = this.selectedAccount;
      }
    }

    // 渲染当前选中账号的文件夹标签（水平排列）
    const currentAccount = this.selectedAccount || accountNames[0] || '';
    const accountTree = tree[currentAccount] || {};

    for (const def of folderDefs) {
      const stat = accountTree[def.key] || { total: 0, unread: 0 };
      const isSelected = this.selectedFolder && this.selectedFolder.account === currentAccount && this.selectedFolder.folder === def.key;
      const row = this.foldersEl.createDiv({ cls: `foxmail-folder-tag${isSelected ? ' is-selected' : ''}` });
      row.createSpan({ text: `${def.icon} ${def.label}`, cls: 'foxmail-folder-tag-name' });
      if (stat.unread > 0) {
        row.createSpan({ text: String(stat.unread), cls: 'foxmail-unread-badge' });
      } else if (stat.total > 0) {
        row.createSpan({ text: String(stat.total), cls: 'foxmail-total-badge' });
      }
      row.addEventListener('click', () => {
        this.selectedFolder = { account: currentAccount, folder: def.key };
        this.selectedEntry = null;
        this.multiSelected.clear();
        this.renderFolders();
        this.renderList();
        this.renderReader();
      });

      // 文件夹右键菜单（全部标记已读）
      row.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        this.openFolderMenu(e, currentAccount, def.key, def.label);
      });
    }

    if (accountNames.length === 0) {
      this.foldersEl.createDiv({ text: '暂无邮件账户，请先在设置中添加', cls: 'foxmail-empty-hint' });
    }
  }

  /** 中栏：邮件列表 */
  private renderList() {
    this.listEl.empty();

    let items = this.entries.filter(e => {
      if (!this.selectedFolder) return false;
      return e.account === this.selectedFolder.account && e.folder === this.selectedFolder.folder;
    });

    if (this.searchQuery) {
      items = items.filter(e => {
        const hay = `${e.fm.subject || ''} ${e.fm.from || ''} ${e.fm.to || ''}`.toLowerCase();
        return hay.includes(this.searchQuery);
      });
    }

    // 多选批量操作条（Ctrl+点击选中后出现）
    if (this.multiSelected.size > 0) {
      const bar = this.listEl.createDiv('foxmail-bulk-bar');
      bar.createSpan({ text: `已选 ${this.multiSelected.size} 封（Ctrl+点击可继续选择）`, cls: 'foxmail-bulk-count' });
      const mkBulkBtn = (text: string, cb: () => void) => {
        const b = bar.createEl('button', { text, cls: 'foxmail-bulk-btn' });
        b.addEventListener('click', cb);
      };
      mkBulkBtn('标记已读', () => this.bulkSetRead(true));
      mkBulkBtn('标记未读', () => this.bulkSetRead(false));
      mkBulkBtn('取消选择', () => { this.multiSelected.clear(); this.renderList(); });
    }

    if (items.length === 0) {
      this.listEl.createDiv({ text: this.searchQuery ? '没有匹配的邮件' : '没有邮件', cls: 'foxmail-empty-hint' });
    }

    for (const entry of items) {
      const isMulti = this.multiSelected.has(entry.file.path);
      const row = this.listEl.createDiv({
        cls: `foxmail-mail-row${entry.unread ? ' is-unread' : ''}${this.selectedEntry?.file.path === entry.file.path ? ' is-selected' : ''}${isMulti ? ' is-multi-selected' : ''}`
      });

      const senderRaw = String(entry.fm.from || entry.fm.to || '');
      const sender = this.displaySenderName(senderRaw, entry.folder);
      const subject = String(entry.fm.subject || entry.file.basename || '无主题');

      const topLine = row.createDiv('foxmail-row-top');
      topLine.createSpan({ text: sender, cls: 'foxmail-row-sender' });
      topLine.createSpan({ text: this.formatListDate(entry.date), cls: 'foxmail-row-date' });

      const bottomLine = row.createDiv('foxmail-row-bottom');
      if (entry.hasAttachment) {
        bottomLine.createSpan({ text: '📎', cls: 'foxmail-row-clip' });
      }
      bottomLine.createSpan({ text: subject, cls: 'foxmail-row-subject' });

      row.addEventListener('click', (e: MouseEvent) => {
        // Ctrl/Cmd+点击：切换多选（不触发预览）
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.toggleMultiSelect(entry.file.path);
          return;
        }
        this.selectedEntry = entry;
        this.renderList();
        this.renderReader();
        // Foxmail 逻辑：预览即标记已读（多选进行中时不自动标读，避免干扰批量操作）
        if (entry.unread && entry.folder === 'inbox' && this.multiSelected.size === 0) {
          this.markEntryRead(entry);
        }
      });

      row.addEventListener('dblclick', () => {
        this.openFileInLeaf(entry.file);
      });

      // 右键上下文菜单（回复/转发等）
      row.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        this.openEntryMenu(e, entry);
      });
    }

    // 状态栏
    const unread = items.filter(i => i.unread).length;
    this.statusEl.setText(`共 ${items.length} 封邮件，${unread} 封未读${this.searchQuery ? '（已过滤）' : ''}`);
  }

  /** 从 from/to 字段提取显示名（Foxmail 列表只显示姓名） */
  private displaySenderName(raw: string, folder: string): string {
    if (!raw) return folder === 'sent' ? '我' : '未知';
    const parsed = parseEmailList(raw);
    const first = parsed[0];
    if (first && first.name) return first.name + (parsed.length > 1 ? ` 等${parsed.length}人` : '');
    if (first) return first.email;
    return raw;
  }

  /** Foxmail 日期格式：今天显示时间，今年显示 MM-DD，更早显示 YYYY-MM-DD */
  private formatListDate(d: Date): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (d.getFullYear() === now.getFullYear()) {
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 右栏：阅读窗格 */
  private renderReader() {
    this.readerEl.empty();
    const entry = this.selectedEntry;

    if (!entry) {
      this.readerEl.createDiv({ text: '选择一封邮件开始阅读', cls: 'foxmail-empty-hint foxmail-reader-empty' });
      return;
    }

    // 邮件头（Foxmail 风格），发件人/收件人等信息可点击折叠
    const header = this.readerEl.createDiv('foxmail-reader-header');
    if (this.metaCollapsed) header.addClass('is-collapsed');

    const subjectLine = header.createDiv('foxmail-reader-subject-line');
    subjectLine.createDiv({ text: String(entry.fm.subject || entry.file.basename || '无主题'), cls: 'foxmail-reader-subject' });
    const toggleBtn = subjectLine.createSpan({ cls: 'foxmail-reader-meta-toggle', attr: { title: this.metaCollapsed ? '展开邮件头信息' : '折叠邮件头信息' } });
    setIcon(toggleBtn, this.metaCollapsed ? 'chevron-down' : 'chevron-up');

    const metaGrid = header.createDiv('foxmail-reader-meta');
    const addMeta = (label: string, value: string) => {
      if (!value) return;
      const line = metaGrid.createDiv('foxmail-reader-meta-line');
      line.createSpan({ text: `${label}: `, cls: 'foxmail-meta-label' });
      line.createSpan({ text: value, cls: 'foxmail-meta-value' });
    };
    if (entry.folder !== 'sent') addMeta('发件人', String(entry.fm.from || ''));
    addMeta('收件人', String(entry.fm.to || ''));
    if (entry.fm.cc) addMeta('抄送', String(entry.fm.cc));
    addMeta('时间', String(entry.fm.created || ''));
    if (entry.fm.account) addMeta('账户', String(entry.fm.account));

    // 折叠态摘要行（发件人 + 时间）
    const summaryLine = header.createDiv('foxmail-reader-summary');
    const summarySender = this.displaySenderName(
      String(entry.folder === 'sent' ? (entry.fm.to || '') : (entry.fm.from || '')),
      entry.folder
    );
    summaryLine.setText(`${summarySender} · ${String(entry.fm.created || '')}`);

    // 点击主题行或摘要行切换折叠（操作按钮与展开入口除外）
    const toggleMeta = () => {
      this.metaCollapsed = !this.metaCollapsed;
      header.toggleClass('is-collapsed', this.metaCollapsed);
      setIcon(toggleBtn, this.metaCollapsed ? 'chevron-down' : 'chevron-up');
      toggleBtn.setAttr('title', this.metaCollapsed ? '展开邮件头信息' : '折叠邮件头信息');
    };
    subjectLine.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.foxmail-reader-actions')) return;
      toggleMeta();
    });
    summaryLine.addEventListener('click', toggleMeta);
    toggleBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      toggleMeta();
    });

    // 操作按钮（收起时仍可直接操作）
    const actions = header.createDiv('foxmail-reader-actions');
    const mkBtn = (text: string, cb: () => void) => {
      const b = actions.createEl('button', { text, cls: 'foxmail-action-btn' });
      b.addEventListener('click', cb);
      return b;
    };
    if (entry.folder === 'inbox') {
      mkBtn('回复', () => this.doReply());
      mkBtn('回复全部', () => this.doReplyAll());
    }
    mkBtn('转发', () => this.doForward());
    mkBtn('作为附件转发', () => this.doForwardAsAttachment());
    if (entry.folder === 'inbox') {
      mkBtn('标记垃圾邮件', () => this.doMarkSpam());
    }
    mkBtn(entry.unread ? '标记未读' : '标记已读', () => this.doToggleRead());
    mkBtn('打开笔记', () => this.openFileInLeaf(entry.file));

    // 阅读窗格邮件头右键菜单（与列表菜单一致）
    header.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.openEntryMenu(e, entry);
    });

    // 正文渲染（委托点击：附件等文件链接用 Obsidian 默认方式打开）
    const contentEl = this.readerEl.createDiv('foxmail-reader-content markdown-preview-view');
    contentEl.addEventListener('click', (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (!target) return;
      const href = target.getAttribute('href') || '';
      if (!href || /^(https?:|mailto:|obsidian:)/i.test(href)) return; // 外链交给浏览器/系统
      const resolved = this.resolveAttachmentPath(entry.file, href);
      if (!resolved) {
        new Notice(`附件不存在：${href}`);
        return;
      }
      e.preventDefault();
      this.openAttachment(resolved);
    });
    (async () => {
      try {
        const raw = await this.app.vault.cachedRead(entry.file);
        // 去掉 frontmatter 后渲染
        const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
        
        // 检测是否为 HTML 内容：查找 <!DOCTYPE 或 <html 标签
        const htmlStartMatch = body.match(/<!DOCTYPE\s+html|<html[\s>]/i);
        const isHtmlContent = !!htmlStartMatch;
        
        if (isHtmlContent && htmlStartMatch.index !== undefined) {
          // HTML 内容：使用 DOMParser 解析并提取 body 内容
          let htmlContent = body.substring(htmlStartMatch.index);
          
          // 使用 DOMParser 解析 HTML（比正则更可靠，能处理格式不正确的 HTML）
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlContent, 'text/html');
          
          // 修复格式不正确的 HTML：将隐藏元素的内容提取出来
          // 有些邮件的 <span style="display:none"> 未闭合，导致后续内容被隐藏
          const hiddenElements = doc.body.querySelectorAll('[style*="display: none"], [style*="display:none"]');
          hiddenElements.forEach((el) => {
            // 将隐藏元素的子节点移到其父节点中（在该元素之后）
            const parent = el.parentNode;
            if (parent) {
              while (el.firstChild) {
                parent.insertBefore(el.firstChild, el.nextSibling);
              }
              parent.removeChild(el);
            }
          });
          
          // 修复未闭合 div 导致的内容截断问题
          // 有些邮件的 header div 没有闭合，导致后续内容被 max-height 和 overflow:hidden 截断
          const constrainedElements = doc.body.querySelectorAll('[style*="max-height"], [style*="overflow: hidden"], [style*="overflow:hidden"]');
          constrainedElements.forEach(el => {
            const style = el.getAttribute('style') || '';
            // 移除 max-height 限制
            const newStyle = style
              .replace(/max-height\s*:\s*[^;]+;?/gi, '')
              .replace(/overflow\s*:\s*hidden;?/gi, 'overflow: visible;');
            el.setAttribute('style', newStyle);
          });
          
          // 提取 body 的 style 属性（如果有的话）
          const bodyStyle = doc.body.getAttribute('style') || '';
          
          // 提取 body 的 innerHTML
          const bodyContent = doc.body.innerHTML;
          
          // 安全清理：移除 script 标签和内联事件处理器
          const sanitized = bodyContent
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
            .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
          
          // 创建包装器，应用 body 的样式
          const wrapper = contentEl.createDiv('obmail-html-wrapper');
          if (bodyStyle) {
            wrapper.setAttr('style', bodyStyle);
          }
          wrapper.innerHTML = sanitized;
          
          // 注入重置样式，确保邮件内容在 Obsidian 中正常显示
          const resetStyle = wrapper.createEl('style');
          resetStyle.textContent = `
            .obmail-html-wrapper {
              padding: 16px;
              overflow: auto;
              min-height: 400px;
              height: auto;
              width: 100%;
              box-sizing: border-box;
            }
            .obmail-html-wrapper::after {
              content: "";
              display: table;
              clear: both;
            }
            .obmail-html-wrapper * {
              max-width: 100%;
              box-sizing: border-box;
            }
            .obmail-html-wrapper table {
              border-collapse: collapse;
              width: 100%;
            }
            .obmail-html-wrapper img {
              max-width: 100%;
              height: auto;
            }
            .obmail-html-wrapper div {
              max-width: 100%;
            }
          `;
          
          // 注入作用域 CSS（从 frontmatter 读取）
          const fm = (this.app.metadataCache.getFileCache(entry.file)?.frontmatter || {}) as Record<string, any>;
          if (fm.obmailscope && fm.obmailcss) {
            const scopedCss = String(fm.obmailcss);
            // 创建 style 元素注入作用域 CSS
            const styleEl = contentEl.createEl('style');
            styleEl.textContent = scopedCss;
            contentEl.insertBefore(styleEl, contentEl.firstChild);
          }
        } else {
          // Markdown 内容：使用 MarkdownRenderer 渲染
          await MarkdownRenderer.render(this.app, body, contentEl, entry.file.path, this);
        }
      } catch (err) {
        console.error('渲染邮件正文失败:', err);
        contentEl.setText('渲染失败');
      }
    })();
  }

  /** 在标签页中打开文件 */
  private async openFileInLeaf(file: TFile) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  /** 解析正文中的附件链接为 Vault 路径（收件箱链接以账户目录为基准，已发送以存储根为基准） */
  private resolveAttachmentPath(noteFile: TFile, href: string): TFile | null {
    const p = safeDecodeURIComponent(href.split('#')[0]).replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!p) return null;
    const basePath = this.plugin.settings.obmailStoragePath;
    const candidates: string[] = [];
    // 1. 相对邮件笔记所在目录（草稿等场景）
    const parentDir = noteFile.parent?.path || '';
    if (parentDir) candidates.push(`${parentDir}/${p}`);
    // 2. 相对账户目录（收件箱链接形如 收件箱/attachments/YYYY-MM-DD/xxx）
    const accMatch = noteFile.path.match(/^(.*?)\/(?:收件箱|已发送|草稿箱|垃圾邮件)\//);
    if (accMatch && accMatch[1]) candidates.push(`${accMatch[1]}/${p}`);
    // 3. 相对存储根（已发送链接形如 账户/已发送/attachments/…）
    if (basePath) candidates.push(`${basePath}/${p}`);
    // 4. 相对 Vault 根
    candidates.push(p);
    for (const c of candidates) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(c));
      if (f && f instanceof TFile) return f;
    }
    // 5. 兜底：按 Obsidian 链接规则解析（含按文件名最短路径匹配）
    return this.app.metadataCache.getFirstLinkpathDest(p, noteFile.path);
  }

  /** 以 Obsidian 默认方式打开附件（新标签页打开，不支持预览的类型由 Obsidian 提供外部打开入口） */
  private async openAttachment(file: TFile) {
    try {
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(file);
    } catch (err) {
      console.error('打开附件失败:', file.path, err);
      new Notice(`打开附件失败：${file.path}`);
    }
  }

  /** 标记已读（修改 frontmatter status） */
  private async markEntryRead(entry: MailEntry) {
    try {
      await (this.app as any).fileManager.processFrontMatter(entry.file, (fm: any) => {
        fm.status = '已读';
      });
      entry.unread = false;
      // 延迟刷新未读角标（processFrontMatter 会触发 vault modify 事件）
      this.renderFolders();
      this.renderList();
    } catch (err) {
      console.error('标记已读失败:', err);
    }
  }

  // ---------- 工具栏/阅读窗格动作 ----------

  /** 切换单封邮件的多选状态 */
  private toggleMultiSelect(path: string) {
    if (this.multiSelected.has(path)) this.multiSelected.delete(path);
    else this.multiSelected.add(path);
    this.renderList();
  }

  /** 批量标记已读/未读（作用于当前多选的邮件） */
  private async bulkSetRead(markRead: boolean) {
    const targets = this.entries.filter(e => this.multiSelected.has(e.file.path) && e.unread === markRead);
    if (targets.length === 0) {
      new Notice(`选中的邮件均已${markRead ? '已读' : '未读'}`);
      return;
    }
    try {
      for (const entry of targets) {
        await (this.app as any).fileManager.processFrontMatter(entry.file, (fm: any) => {
          fm.status = markRead ? '已读' : '未读';
        });
        entry.unread = !markRead;
      }
      new Notice(`已将 ${targets.length} 封邮件标记为${markRead ? '已读' : '未读'}`);
    } catch (err) {
      console.error('批量标记失败:', err);
      new Notice(`批量标记失败: ${(err as Error).message}`);
    }
    this.multiSelected.clear();
    this.renderFolders();
    this.renderList();
    this.renderReader();
  }

  /** 文件夹右键菜单：全部标记已读 */
  private openFolderMenu(e: MouseEvent, accountName: string, folderKey: string, folderLabel: string) {
    const menu = new Menu();
    menu.addItem(item => item.setTitle('全部标记已读').setIcon('check-check').onClick(() => {
      (async () => {
        const targets = this.entries.filter(en => en.account === accountName && en.folder === folderKey && en.unread);
        if (targets.length === 0) {
          new Notice(`「${folderLabel}」没有未读邮件`);
          return;
        }
        try {
          for (const entry of targets) {
            await (this.app as any).fileManager.processFrontMatter(entry.file, (fm: any) => {
              fm.status = '已读';
            });
            entry.unread = false;
          }
          new Notice(`已将「${folderLabel}」的 ${targets.length} 封邮件标记为已读`);
        } catch (err) {
          console.error('全部标记已读失败:', err);
        }
        this.renderFolders();
        this.renderList();
        this.renderReader();
      })();
    }));
    menu.showAtMouseEvent(e);
  }

  /** 邮件右键上下文菜单（列表行与阅读窗格共用），动作直接作用于指定条目 */
  private openEntryMenu(e: MouseEvent, entry: MailEntry) {
    const menu = new Menu();
    if (entry.folder === 'inbox') {
      menu.addItem(item => item.setTitle('回复').setIcon('reply').onClick(() => replyToEmail(this.plugin, entry.file)));
      menu.addItem(item => item.setTitle('回复全部').setIcon('reply-all').onClick(() => replyAllEmail(this.plugin, entry.file)));
    }
    menu.addItem(item => item.setTitle('转发').setIcon('forward').onClick(() => forwardEmail(this.plugin, entry.file)));
    menu.addItem(item => item.setTitle('作为附件转发').setIcon('paperclip').onClick(() => forwardEmailAsAttachment(this.plugin, entry.file)));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(entry.unread ? '标记已读' : '标记未读').setIcon('mail-check').onClick(() => {
      this.selectedEntry = entry;
      this.doToggleRead();
    }));
    if (entry.folder === 'inbox') {
      menu.addItem(item => item.setTitle('标记垃圾邮件').setIcon('shield-alert').onClick(() => {
        this.selectedEntry = entry;
        this.doMarkSpam();
      }));
    }
    menu.addItem(item => item.setTitle('删除邮件').setIcon('trash').onClick(() => {
      this.selectedEntry = entry;
      this.doDelete();
    }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('打开笔记').setIcon('file-text').onClick(() => this.openFileInLeaf(entry.file)));
    menu.showAtMouseEvent(e);
  }

  private requireSelection(): MailEntry | null {
    if (!this.selectedEntry) {
      new Notice('请先在列表中选择一封邮件');
      return null;
    }
    return this.selectedEntry;
  }

  private doReply() {
    const entry = this.requireSelection();
    if (entry) replyToEmail(this.plugin, entry.file);
  }

  private doReplyAll() {
    const entry = this.requireSelection();
    if (entry) replyAllEmail(this.plugin, entry.file);
  }

  private doForward() {
    const entry = this.requireSelection();
    if (entry) forwardEmail(this.plugin, entry.file);
  }

  private doForwardAsAttachment() {
    const entry = this.requireSelection();
    if (entry) forwardEmailAsAttachment(this.plugin, entry.file);
  }

  private doMarkSpam() {
    const entry = this.requireSelection();
    if (!entry) return;
    new ConfirmModal(
      this.app,
      `将邮件「${entry.fm.subject || entry.file.name}」标记为垃圾邮件？\n邮件将移动到账户的「垃圾邮件」文件夹。`,
      async () => {
        await markEmailAsSpam(this.plugin, entry.file);
        this.selectedEntry = null;
        await this.refresh();
      },
      () => {}
    ).open();
  }

  private doToggleRead() {
    const entry = this.requireSelection();
    if (!entry) return;
    (async () => {
      try {
        const newStatus = entry.unread ? '已读' : '未读';
        await (this.app as any).fileManager.processFrontMatter(entry.file, (fm: any) => {
          fm.status = newStatus;
        });
        entry.unread = !entry.unread;
        this.renderFolders();
        this.renderList();
        this.renderReader();
        new Notice(`已标记为${newStatus}`);
      } catch (err) {
        console.error('标记状态失败:', err);
      }
    })();
  }

  private doDelete() {
    const entry = this.requireSelection();
    if (!entry) return;
    new ConfirmModal(
      this.app,
      `确定要删除邮件「${entry.fm.subject || entry.file.name}」吗？\n邮件将移入系统回收站。`,
      async () => {
        try {
          // 使用 FileManager.trashFile 尊重用户的删除偏好设置（系统回收站/vault 回收站）
          await this.app.fileManager.trashFile(entry.file);
          this.selectedEntry = null;
          new Notice('邮件已删除');
          await this.refresh();
        } catch (err) {
          console.error('删除邮件失败:', err);
          new Notice(`删除失败: ${(err as Error).message}`);
        }
      },
      () => {}
    ).open();
  }
}

// ==================== Foxmail 风格写信视图（标签页） ====================

export const COMPOSE_VIEW_TYPE = 'obsidian-mail-compose-view';

/** 关闭未保存写信页时的三选一确认 */
function askComposeCloseChoice(app: App): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (choice: 'save' | 'discard' | 'cancel') => {
      if (!settled) {
        settled = true;
        resolve(choice);
      }
    };

    const modal = new Modal(app);
    modal.titleEl.setText('邮件尚未发送');

    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.createEl('p', { text: '邮件内容已修改但尚未发送。关闭前是否保存为草稿？' });
      const btnRow = contentEl.createDiv('obmail-modal-btn-row');

      const cancelBtn = btnRow.createEl('button', { text: '取消' });
      cancelBtn.addEventListener('click', () => { done('cancel'); modal.close(); });

      const discardBtn = btnRow.createEl('button', { text: '不保存', cls: 'mod-warning' });
      discardBtn.addEventListener('click', () => { done('discard'); modal.close(); });

      const saveBtn = btnRow.createEl('button', { text: '保存草稿', cls: 'mod-cta' });
      saveBtn.addEventListener('click', () => { done('save'); modal.close(); });
    };

    modal.onClose = () => {
      modal.contentEl.empty();
      done('cancel'); // 点遮罩/ESC 关闭弹窗 = 取消关闭写信页
    };

    modal.open();
  });
}

/** 联系人选择弹窗（带搜索过滤） */
class ContactPickerModal extends Modal {
  contacts: Contact[];
  onPick: (contact: Contact) => void;

  constructor(app: App, contacts: Contact[], onPick: (contact: Contact) => void) {
    super(app);
    this.contacts = contacts;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('obmail-contact-picker');
    contentEl.createEl('h3', { text: '选择联系人' });

    const filterInput = contentEl.createEl('input', { type: 'text', placeholder: '搜索姓名或邮箱…', cls: 'obmail-contact-filter' });
    const listEl = contentEl.createDiv('obmail-contact-list');

    const render = (filter: string) => {
      listEl.empty();
      const term = filter.trim().toLowerCase();
      const items = this.contacts
        .filter(c => c && (c.name || c.email))
        .filter(c => !term || (c.name || '').toLowerCase().includes(term) || (c.email || '').toLowerCase().includes(term))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      if (items.length === 0) {
        listEl.createEl('p', { text: '暂无联系人', cls: 'obmail-empty-hint' });
        return;
      }

      for (const contact of items) {
        const row = listEl.createDiv('obmail-contact-item');
        row.createEl('strong', { text: contact.name || '未知联系人' });
        row.createSpan({ text: ` <${contact.email || '无邮箱'}>`, cls: 'obmail-contact-email' });
        row.addEventListener('click', () => {
          this.onPick(contact);
          this.close();
        });
      }
    };

    filterInput.addEventListener('input', () => render(filterInput.value));
    render('');
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 构建带联系人自动补全的收件人行（Foxmail 写信窗口字段风格）
 * 支持粘贴识别：粘贴 姓名<邮箱> 列表（逗号/分号/换行分隔）时自动规范化并存入联系人
 * 返回输入框元素
 */
function buildContactField(plugin: MailPlugin, parent: HTMLElement, label: string, placeholder: string, getAccount?: () => MailAccount | null): HTMLInputElement {
  const row = parent.createDiv('obmail-compose-row');
  row.createSpan({ text: label, cls: 'obmail-compose-label' });

  const wrap = row.createDiv('obmail-compose-inputwrap');
  const input = wrap.createEl('input', { type: 'text', placeholder, cls: 'obmail-compose-input' });

  const pickBtn = row.createEl('button', { text: '联系人', cls: 'obmail-contact-btn' });

  const drop = wrap.createDiv('obmail-autocomplete');
  let filtered: Contact[] = [];
  let selected = -1;

  const insertContact = (contact: Contact) => {
    const value = input.value;
    const idx = Math.max(value.lastIndexOf(','), value.lastIndexOf('，'));
    const prefix = idx !== -1 ? value.substring(0, idx + 1) + ' ' : '';
    const inserted = contact.name ? `${contact.name} <${contact.email}>` : contact.email;
    input.value = prefix + inserted + ', ';
    drop.addClass('is-hidden');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const updateOptions = () => {
    const value = input.value;
    const segIdx = Math.max(value.lastIndexOf(','), value.lastIndexOf('，'));
    const term = (segIdx !== -1 ? value.substring(segIdx + 1) : value).trim().toLowerCase();
    if (!term) {
      drop.addClass('is-hidden');
      return;
    }
    filtered = plugin.settings.contacts.filter(c => {
      if (!c || (!c.name && !c.email)) return false;
      return (c.name || '').toLowerCase().includes(term) || (c.email || '').toLowerCase().includes(term);
    }).slice(0, 8);

    if (filtered.length === 0) {
      drop.addClass('is-hidden');
      return;
    }

    drop.empty();
    selected = -1;
    filtered.forEach((contact, i) => {
      const opt = drop.createDiv('obmail-autocomplete-item');
      opt.createEl('strong', { text: contact.name || '未知联系人' });
      opt.createSpan({ text: ` <${contact.email}>`, cls: 'obmail-contact-email' });
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertContact(contact);
      });
      opt.addEventListener('mouseenter', () => {
        selected = i;
        drop.querySelectorAll('.is-selected').forEach(el => el.removeClass('is-selected'));
        opt.addClass('is-selected');
      });
    });
    drop.removeClass('is-hidden');
  };

  input.addEventListener('input', updateOptions);
  input.addEventListener('focus', updateOptions);
  input.addEventListener('blur', () => {
    window.setTimeout(() => { drop.addClass('is-hidden'); }, 150);
  });

  // 粘贴识别：支持 姓名<邮箱> 列表，逗号/分号/换行/制表符分隔，自动去重、规范化并存入联系人
  input.addEventListener('paste', (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') || '';
    const allParsed = parseEmailList(text);
    const pasted = allParsed.filter(a => isValidEmail(a.email));
    if (pasted.length === 0) return; // 非邮箱内容走默认粘贴

    e.preventDefault();
    const invalidCount = allParsed.length - pasted.length;
    const existing = parseEmailList(input.value).filter(a => isValidEmail(a.email));
    const seen = new Set(existing.map(a => a.email.toLowerCase()));
    const merged = [...existing];
    const newAddrs: ParsedAddress[] = [];
    for (const addr of pasted) {
      const key = addr.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(addr);
      newAddrs.push(addr);
    }

    input.value = merged.map(formatAddress).join(', ') + (merged.length > 0 ? ' ' : '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    drop.addClass('is-hidden');

    // 批量粘贴结果反馈（新增/去重/无效条目数）
    const dupCount = pasted.length - newAddrs.length;
    const hints: string[] = [];
    if (newAddrs.length > 0) hints.push(`已添加 ${newAddrs.length} 个收件人`);
    if (dupCount > 0) hints.push(`去重 ${dupCount} 个`);
    if (invalidCount > 0) hints.push(`忽略 ${invalidCount} 个无效条目`);
    if (hints.length > 0) new Notice(hints.join('，'));

    // 新地址存入联系人列表
    if (newAddrs.length > 0) {
      const account = getAccount ? getAccount() || undefined : undefined;
      plugin.saveContactsFromAddresses(newAddrs, account).then((count) => {
        if (count > 0) {
          new Notice(`已新增 ${count} 个联系人`);
        }
      }).catch(err => console.error('保存联系人失败:', err));
    }
  });
  input.addEventListener('keydown', (e) => {
    if (drop.hasClass('is-hidden')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === 'Enter') {
      if (selected >= 0 && selected < filtered.length) {
        e.preventDefault();
        insertContact(filtered[selected]);
      }
      return;
    } else if (e.key === 'Escape') {
      drop.addClass('is-hidden');
      return;
    } else {
      return;
    }
    drop.querySelectorAll('.is-selected').forEach(el => el.removeClass('is-selected'));
    const opts = drop.querySelectorAll('.obmail-autocomplete-item');
    if (opts[selected]) {
      opts[selected].addClass('is-selected');
      (opts[selected] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  });

  pickBtn.addEventListener('click', () => {
    new ContactPickerModal(plugin.app, plugin.settings.contacts, insertContact).open();
  });

  return input;
}

/** 邮件发送进度弹窗：发送期间展示状态，禁止 ESC 关闭 */
class SendProgressModal extends Modal {
  private statusEl!: HTMLElement;

  onOpen() {
    // 发送进行中禁止 ESC 关闭（消费 Escape 按键，避免误操作中断发送进度显示；Modal 无 closable 属性）
    this.scope.register(null, 'Escape', () => false);
    this.titleEl.setText('发送邮件');
    const box = this.contentEl.createDiv('obmail-send-progress');
    const spinnerEl = box.createDiv('obmail-send-spinner');
    setIcon(spinnerEl, 'loader');
    this.statusEl = box.createDiv({ text: '正在准备发送…', cls: 'obmail-send-status' });
  }

  /** 更新进度文案 */
  setStatus(text: string) {
    if (this.statusEl) this.statusEl.setText(text);
  }
}

/**
 * Foxmail 风格写信视图：在 Obsidian 标签页中编辑并发送邮件
 */
class ObMailComposeView extends ItemView {
  plugin: MailPlugin;

  private accountSelect!: HTMLSelectElement;
  private toInput!: HTMLInputElement;
  private ccInput!: HTMLInputElement;
  private bccInput!: HTMLInputElement;
  private subjectInput!: HTMLInputElement;
  private bodyArea!: HTMLTextAreaElement;
  private attachListEl!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;

  /** 发送进行中标志：防止重复点击发送按钮导致一封邮件发出多次 */
  private sending = false;

  /** 当前附件（初始 + 用户添加） */
  private attachments: Array<{ filename: string; content: Buffer }> = [];
  /** 来源邮件（回复/转发的原邮件） */
  sourceFile: TFile | null = null;
  /** 关联的草稿文件（从草稿打开时），保存时更新而非新建 */
  draftFile: TFile | null = null;
  /** 用户是否修改过内容（决定关闭时是否询问） */
  private dirty = false;

  constructor(leaf: WorkspaceLeaf, plugin: MailPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return COMPOSE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '写邮件';
  }

  getIcon(): string {
    return 'send';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('obmail-compose');

    // 顶部操作栏
    const toolbar = container.createDiv('obmail-compose-toolbar');

    const sendBtn = toolbar.createEl('button', { text: '发送', cls: 'obmail-compose-send' });
    this.sendBtn = sendBtn;
    sendBtn.addEventListener('click', () => this.doSend());

    const draftBtn = toolbar.createEl('button', { text: '保存草稿', cls: 'obmail-compose-draft' });
    draftBtn.addEventListener('click', async () => {
      try {
        await this.saveCurrentDraft();
        new Notice('草稿已保存');
      } catch (err) {
        console.error('保存草稿失败:', err);
        new Notice(`保存草稿失败: ${(err as Error).message}`);
      }
    });

    const attachBtn = toolbar.createEl('button', { text: '📎 添加附件', cls: 'obmail-compose-attach' });
    this.fileInput = toolbar.createEl('input', { type: 'file', cls: 'obmail-file-input' });
    this.fileInput.multiple = true;
    attachBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => this.addFilesFromPicker());

    // 账户选择（右侧）
    const accountWrap = toolbar.createDiv('obmail-compose-account');
    accountWrap.createSpan({ text: '发件账户: ', cls: 'obmail-compose-label' });
    this.accountSelect = accountWrap.createEl('select', { cls: 'obmail-account-select' });
    for (const account of this.plugin.settings.accounts) {
      this.accountSelect.createEl('option', { value: account.id, text: `${account.name} <${account.email}>` });
    }
    this.accountSelect.addEventListener('change', () => this.markDirty());

    // 收件人字段区
    const fields = container.createDiv('obmail-compose-fields');
    const getSelectedAccount = () => this.plugin.settings.accounts.find(a => a.id === this.accountSelect.value) || null;
    this.toInput = buildContactField(this.plugin, fields, '收件人', '输入或粘贴收件人，支持 姓名<邮箱> 列表（逗号/分号/换行分隔）', getSelectedAccount);
    this.ccInput = buildContactField(this.plugin, fields, '抄送', '输入或粘贴抄送人', getSelectedAccount);
    this.bccInput = buildContactField(this.plugin, fields, '密送', '输入或粘贴密送人', getSelectedAccount);

    // 主题
    const subjectRow = fields.createDiv('obmail-compose-row');
    subjectRow.createSpan({ text: '主题', cls: 'obmail-compose-label' });
    const subjectWrap = subjectRow.createDiv('obmail-compose-inputwrap');
    this.subjectInput = subjectWrap.createEl('input', { type: 'text', placeholder: '输入邮件主题', cls: 'obmail-compose-input' });

    // 正文
    this.bodyArea = container.createEl('textarea', { cls: 'obmail-compose-body', attr: { placeholder: '输入邮件正文（支持 Markdown 格式）' } });

    // 附件列表（空态常驻显示拖拽/添加提示，同时也是拖放目标）
    this.attachListEl = container.createDiv('obmail-compose-attachments');
    this.renderAttachments();

    // 拖拽添加附件（支持从系统文件管理器 / Obsidian 文件列表拖入）
    this.setupDragAndDrop(container);

    // 监听修改
    for (const el of [this.toInput, this.ccInput, this.bccInput, this.subjectInput]) {
      el.addEventListener('input', () => { this.markDirty(); this.updateTitle(); });
    }
    this.bodyArea.addEventListener('input', () => this.markDirty());

    this.updateTitle();
  }

  /** 初始化写信内容（由 openComposeView 调用） */
  initCompose(
    data: { accountId?: string; to?: string; cc?: string; bcc?: string; subject?: string; content?: string },
    attachments: Array<{ filename: string; content: Buffer }> = [],
    sourceFile: TFile | null = null,
    draftFile: TFile | null = null
  ) {
    // 账户选择
    const accountId = data.accountId || (this.plugin.settings.accounts[0]?.id ?? '');
    this.accountSelect.value = accountId;

    this.toInput.value = data.to || '';
    this.ccInput.value = data.cc || '';
    this.bccInput.value = data.bcc || '';
    this.subjectInput.value = data.subject || '';
    this.bodyArea.value = data.content || '';

    this.attachments = [...attachments];
    this.sourceFile = sourceFile;
    this.draftFile = draftFile;
    this.dirty = false; // 初始内容不算用户修改

    this.renderAttachments();
    this.updateTitle();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  private markDirty() {
    this.dirty = true;
  }

  private updateTitle() {
    const subject = this.subjectInput?.value?.trim();
    const titleEl = this.containerEl.querySelector('.view-header-title');
    if (titleEl) {
      titleEl.setText(subject ? `写邮件: ${subject}` : '写邮件');
    }
  }

  /** 从文件选择器添加附件（立即读入内存） */
  private async addFilesFromPicker() {
    const files = this.fileInput.files;
    if (!files || files.length === 0) return;
    for (let i = 0; i < files.length; i++) {
      try {
        await this.addFileAsAttachment(files[i]);
      } catch (err) {
        console.error('添加附件失败:', files[i].name, err);
      }
    }
    this.fileInput.value = '';
    this.markDirty();
    this.renderAttachments();
  }

  /** 读取单个 File 并加入附件列表（文件选择器与拖拽共用） */
  private async addFileAsAttachment(file: File): Promise<void> {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(Buffer.from(e.target?.result as ArrayBuffer));
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
    this.attachments.push({ filename: file.name, content: buffer });
  }

  /** 绑定拖拽添加附件事件：拖入时高亮整个写信页，放下时读取文件加入附件 */
  private setupDragAndDrop(container: HTMLElement) {
    let dragDepth = 0;
    container.addEventListener('dragenter', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      dragDepth++;
      container.addClass('obmail-compose-dragover');
    });
    container.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    container.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) container.removeClass('obmail-compose-dragover');
    });
    container.addEventListener('drop', async (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      dragDepth = 0;
      container.removeClass('obmail-compose-dragover');
      await this.handleDropFiles(e.dataTransfer);
    });
  }

  /** 处理拖放内容：优先系统文件，其次尝试按路径解析 Vault 内文件 */
  private async handleDropFiles(dt: DataTransfer) {
    const before = this.attachments.length;
    const failures: string[] = [];

    if (dt.files && dt.files.length > 0) {
      // 从操作系统文件管理器拖入
      for (let i = 0; i < dt.files.length; i++) {
        try {
          await this.addFileAsAttachment(dt.files[i]);
        } catch (err) {
          console.error('拖拽添加附件失败:', dt.files[i].name, err);
          failures.push(dt.files[i].name);
        }
      }
    } else {
      // 从 Obsidian 文件列表拖入时 files 为空，尝试把拖拽文本当作 Vault 路径解析
      const rawText = dt.getData('text/plain') || dt.getData('text');
      for (const line of rawText.split('\n')) {
        // 兼容 wiki 链接形式 [[路径]]
        const candidate = line.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
        if (!candidate) continue;
        const file = this.plugin.app.vault.getAbstractFileByPath(candidate);
        if (file && file instanceof TFile) {
          try {
            const buf = await this.plugin.app.vault.readBinary(file);
            this.attachments.push({ filename: file.name, content: Buffer.from(buf) });
          } catch (err) {
            console.error('拖拽读取 Vault 文件失败:', file.path, err);
            failures.push(file.name);
          }
        }
      }
    }

    const added = this.attachments.length - before;
    if (added > 0) {
      this.markDirty();
      this.renderAttachments();
      new Notice(`已添加 ${added} 个附件${failures.length > 0 ? `，${failures.length} 个失败` : ''}`);
    } else if (failures.length > 0) {
      new Notice(`附件添加失败：${failures.join('、')}`);
    }
  }

  private renderAttachments() {
    if (!this.attachListEl) return;
    this.attachListEl.empty();
    if (this.attachments.length === 0) {
      // 空态：常驻显示拖拽/添加提示，引导用户使用拖放或选择器（布局由 .obmail-attach-list 类提供）
      this.attachListEl.createSpan({ text: '拖拽文件到此处，或点击「📎 添加附件」选择附件', cls: 'obmail-attach-empty-hint' });
      return;
    }
    this.attachments.forEach((att, index) => {
      const item = this.attachListEl.createDiv('obmail-attach-item');
      item.createSpan({ text: `📎 ${att.filename}`, cls: 'obmail-attach-name' });
      item.createSpan({ text: `(${(att.content.length / 1024).toFixed(1)} KB)`, cls: 'obmail-attach-size' });
      const removeBtn = item.createEl('button', { text: '✕', cls: 'obmail-attach-remove' });
      removeBtn.addEventListener('click', () => {
        this.attachments.splice(index, 1);
        this.markDirty();
        this.renderAttachments();
      });
    });
  }

  /** 收集当前表单（解析地址 + 校验） */
  private collectForm(): { account: MailAccount | null; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } | null {
    const selectedAccount = this.plugin.settings.accounts.find(a => a.id === this.accountSelect.value) || null;
    const toParsed = parseEmailList(this.toInput.value);
    const ccParsed = parseEmailList(this.ccInput.value);
    const bccParsed = parseEmailList(this.bccInput.value);

    const invalid = [...toParsed, ...ccParsed, ...bccParsed].filter(a => !isValidEmail(a.email));
    if (invalid.length > 0) {
      new Notice(`邮箱地址格式无效：${invalid.map(a => a.email).join('、')}`);
      return null;
    }

    return {
      account: selectedAccount,
      to: toParsed.map(formatAddress),
      cc: ccParsed.map(formatAddress),
      bcc: bccParsed.map(formatAddress),
      subject: this.subjectInput.value.trim(),
      body: this.bodyArea.value
    };
  }

  /** 发送（带防重复点击与进度弹窗） */
  private async doSend() {
    // 防重复发送：同一封邮件发送期间拒绝再次触发（鼠标双击/抖动）
    if (this.sending) {
      new Notice('邮件正在发送中，请勿重复点击');
      return;
    }
    const form = this.collectForm();
    if (!form) return;
    if (!form.account) {
      new Notice('请先在设置中添加邮件账户');
      return;
    }
    if (form.to.length === 0) {
      new Notice('请输入至少一个收件人');
      return;
    }
    if (!form.subject) {
      new Notice('请输入邮件主题');
      return;
    }
    if (!form.body.trim()) {
      new Notice('请输入邮件正文');
      return;
    }

    // 同步置位发送锁并禁用按钮（以上校验均为同步代码，不存在并发窗口）
    this.sending = true;
    if (this.sendBtn) this.sendBtn.disabled = true;

    const progress = new SendProgressModal(this.app);
    progress.open();
    progress.setStatus('正在连接邮件服务器…');
    // 简单分阶段提示，让长发送过程有进度反馈
    const stageTimer = window.setTimeout(() => {
      progress.setStatus(this.attachments.length > 0 ? '正在上传附件并发送邮件…' : '正在发送邮件，请稍候…');
    }, 1200);

    try {
      await this.plugin.sendEmail(form.account, form.to, form.subject, form.body, this.attachments, form.cc, form.bcc, this.sourceFile || undefined);
      window.clearTimeout(stageTimer);
      this.dirty = false;
      progress.close();
      // 发送成功后关闭标签页（成功 Notice 由 sendEmail 内部提示）
      await this.leaf.detach();
    } catch (err) {
      window.clearTimeout(stageTimer);
      console.error('发送邮件失败:', err);
      // 失败 Notice 由 sendEmail 内部提示，这里只展示可重试状态后关闭弹窗
      progress.setStatus('发送失败，可修改后重新发送');
      window.setTimeout(() => progress.close(), 1500);
      // 恢复发送能力，允许用户修改后重试
      this.sending = false;
      if (this.sendBtn) this.sendBtn.disabled = false;
    }
  }

  /** 保存草稿（若从草稿打开则更新原文件） */
  async saveCurrentDraft() {
    const form = this.collectForm();
    if (!form) throw new Error('地址格式无效');
    await this.plugin.saveDraft(form.account, form.to, form.subject, form.body, this.attachments, form.cc, form.bcc, this.sourceFile || undefined, this.draftFile || undefined);
    this.dirty = false;
  }

  async onClose() {
    // 无需清理
  }
}

// 主插件类
export default class MailPlugin extends Plugin {
  settings: MailSettings;
  private syncTimer: number | null = null; // 邮件同步定时器
  private lastActiveFile: TFile | null = null; // 记录上一个活动的文件，用于关闭时标记已读
  isUnloading = false; // 插件卸载中（跳过关闭询问）
  
  /**
   * 检查当前打开的笔记是否为邮件笔记，并应用样式标识
   */
  async checkAndApplyEmailNoteClass() {
    try {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile || activeFile.extension !== 'md') {
        return;
      }
      
      // 读取文件的缓存元数据
      const fileCache = this.app.metadataCache.getFileCache(activeFile);
      if (!fileCache || !fileCache.frontmatter) {
        return;
      }
      
      const cssClasses = fileCache.frontmatter.cssclasses;
      if (!cssClasses) {
        return;
      }
      
      // 检查是否包含 email-note
      let hasEmailNote = false;
      if (Array.isArray(cssClasses)) {
        hasEmailNote = cssClasses.includes('email-note');
      } else if (typeof cssClasses === 'string') {
        hasEmailNote = cssClasses.includes('email-note');
      }
      
      // 获取当前活动的视图容器（复用顶部导入的 MarkdownView，避免重复 require）
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      
      if (activeView) {
        const containerEl = activeView.containerEl;
        
        if (hasEmailNote) {
          // 添加属性标识符
          containerEl.setAttribute('data-property-cssclasses', 'email-note');
          console.log('📧 已为邮件笔记添加样式标识:', activeFile.path);
        } else {
          // 移除属性标识符
          containerEl.removeAttribute('data-property-cssclasses');
          console.log('❌ 已移除样式标识（非邮件笔记）:', activeFile.path);
        }
      }
    } catch (err) {
      console.error('❌ 检查邮件笔记标识失败:', err);
    }
  }
  
  async onload() {
    await this.loadSettings();
    
    // 插件目录下的 styles.css 由 Obsidian 在插件启用时自动加载，无需手动注入
    
    // 监听文件打开，自动为有 cssclasses: email-note 的笔记添加 email-note 类
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file && file.extension === 'md') {
        // 延迟执行，等待 Obsidian 渲染完成（window.setTimeout 兼容弹出窗口）
        window.setTimeout(() => {
          this.checkAndApplyEmailNoteClass();
        }, 100);
      }
    }));
    
    // 添加设置选项卡
    this.addSettingTab(new MailSettingTab(this.app, this));
    
    // 注册 Foxmail 风格邮件客户端视图
    this.registerView(MAIL_VIEW_TYPE, (leaf) => new MailFoxmailView(leaf, this));
    
    // 注册 Foxmail 风格写信视图（标签页）
    this.registerView(COMPOSE_VIEW_TYPE, (leaf) => new ObMailComposeView(leaf, this));
    
    this.addCommand({
      id: 'open-mail-view',
      name: '打开邮件客户端（Foxmail 风格）',
      callback: () => {
        this.activateMailView();
      }
    });
    
    // 邮件客户端入口按钮
    this.addRibbonIcon('mail', '打开邮件客户端', () => {
      this.activateMailView();
    });
    
    // 添加命令
    this.addCommand({
      id: 'send-email',
      name: '发送邮件',
      callback: () => {
        this.openComposeView();
      }
    });

    // 添加从草稿发送邮件的命令
    this.addCommand({
      id: 'send-from-draft',
      name: '从草稿发送邮件',
      callback: () => {
        this.sendFromDraft();
      }
    });
    
    this.addCommand({
      id: 'reply-to-email',
      name: '回复邮件',
      callback: () => {
        replyToEmail(this);
      }
    });
    
    this.addCommand({
      id: 'reply-all-email',
      name: '回复全部邮件',
      callback: () => {
        replyAllEmail(this);
      }
    });
    
    this.addCommand({
      id: 'forward-email',
      name: '转发邮件',
      callback: () => {
        forwardEmail(this);
      }
    });
    
    this.addCommand({
      id: 'forward-email-as-attachment',
      name: '作为附件转发邮件',
      callback: () => {
        forwardEmailAsAttachment(this);
      }
    });
    
    this.addCommand({
      id: 'mark-email-as-spam',
      name: '标记为垃圾邮件',
      callback: () => {
        markEmailAsSpam(this);
      }
    });
    
    // 邮件笔记作用域 CSS 注入：渲染时将 frontmatter 中的 obmailcss 以 Constructable Stylesheet 注入
    // （选择器已带唯一作用域前缀，不污染 Obsidian；不使用 <style> 元素，符合插件审查规范）
    const obmailSheets = new Map<string, CSSStyleSheet>();
    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        const fm = (ctx.frontmatter || {}) as Record<string, any>;
        if (!fm || (fm.type !== '邮件笔记' && fm.type !== '发出邮件')) return;
        if (!fm.obmailcss || !fm.obmailscope) return;
        const id = 'obmail-dyn-' + simpleHash(ctx.sourcePath);
        const cssText = String(fm.obmailcss);
        const doc = el.ownerDocument ?? document;
        let sheet = obmailSheets.get(id);
        if (sheet) {
          // 同一篇笔记重新收取后 CSS 可能变化，幂等替换
          if ((sheet as CSSStyleSheet & { __obmailCss?: string }).__obmailCss === cssText) return;
          sheet.replaceSync(cssText);
          (sheet as CSSStyleSheet & { __obmailCss?: string }).__obmailCss = cssText;
          return;
        }
        sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        (sheet as CSSStyleSheet & { __obmailCss?: string }).__obmailCss = cssText;
        obmailSheets.set(id, sheet);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      } catch (err) {
        console.error('注入邮件作用域 CSS 失败:', err);
      }
    });
    
    // 邮件笔记顶部操作按钮栏（Foxmail 风格：回复/回复全部/转发/作为附件转发/标记垃圾邮件）
    // 注入到每个 MarkdownView 的 .view-content 顶部，视图级唯一，不随渲染重复
    this.registerEvent(this.app.workspace.on('file-open', () => this.syncMailActionBars()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.syncMailActionBars()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncMailActionBars()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.syncMailActionBars()));
    this.syncMailActionBars();
    
    this.addCommand({
      id: 'receive-email',
      name: '收取邮件',
      callback: () => {
        this.receiveEmail();
      }
    });

    this.addCommand({
      id: 'refetch-emails-force',
      name: '重新收取邮件（重新解析已下载邮件）',
      callback: () => {
        new Notice('开始重新解析邮件（已下载的邮件会生成新笔记，可删除旧的损坏笔记）');
        this.receiveEmail(false, true);
      }
    });

    this.addCommand({
      id: 'download-oversized-emails',
      name: '下载已跳过的超大邮件',
      callback: async () => {
        const pending = Object.values(this.settings.oversizedEmails || {}).reduce((n, l) => n + (l?.length || 0), 0);
        if (pending === 0) {
          new Notice('没有待下载的超大邮件');
          return;
        }
        const count = await this.downloadOversizedEmails();
        new Notice(`超大邮件下载完成：成功 ${count} 封（失败的会保留记录，可稍后重试）`);
      }
    });

    this.addCommand({
      id: 'reconcile-fetched-ids',
      name: '修复去重记录（校对已收取列表与已保存邮件）',
      callback: async () => {
        const removed = await this.reconcileFetchedIds();
        if (removed === 0) {
          new Notice('去重记录与已保存邮件一致，没有需要修复的项');
        } else {
          new Notice(`已清理 ${removed} 条"标记为已收取但文件不存在"的记录；再次收取时这些邮件将重新下载`);
        }
      }
    });

    // 添加功能区按钮
    // 收取邮件按钮
    this.addRibbonIcon('download-cloud', '收取邮件', () => {
      this.receiveEmail();
    });

    // 发送邮件按钮
    this.addRibbonIcon('paper-plane', '发送邮件', () => {
      this.openComposeView();
    });
    
    // 初始化自动同步定时器
    this.updateSyncTimer();

    // 初始化当前活动文件，用于后续追踪文件切换
    this.lastActiveFile = this.app.workspace.getActiveFile();

    /**
     * 监听文件打开/切换事件
     * 逻辑：当用户从邮件笔记切换到其他笔记，或关闭邮件笔记页签时，自动将状态从“未读”更新为“已读”。
     * 对应 design.md 2.1.4 邮件状态管理
     */
    this.registerEvent(
      this.app.workspace.on('file-open', async (newFile) => {
        // 检查刚刚离开的文件是否为 Markdown 邮件笔记
        if (this.lastActiveFile && this.lastActiveFile instanceof TFile && this.lastActiveFile.extension === 'md') {
          // 确保文件依然存在（未被删除或移动）
          if (this.app.vault.getAbstractFileByPath(this.lastActiveFile.path)) {
            const cache = this.app.metadataCache.getFileCache(this.lastActiveFile);
            const frontmatter = cache?.frontmatter;
            
            // 判定条件：type 为“邮件笔记”且当前 status 为“未读”
            if (frontmatter && frontmatter.type === '邮件笔记' && frontmatter.status === '未读') {
              try {
                const targetFile = this.lastActiveFile;
                // 使用 Obsidian 官方推荐的 processFrontMatter API 进行原子化修改
                await (this.app as any).fileManager.processFrontMatter(targetFile, (fm: any) => {
                  fm.status = '已读';
                });
                console.log(`[MailPlugin] 邮件已在关闭/切换时自动标记为已读: ${targetFile.name}`);
              } catch (err) {
                console.error('[MailPlugin] 自动更新邮件状态失败:', err);
              }
            }
          }
        }
        // 更新 lastActiveFile 为当前新打开的文件，为下一次切换做准备
        this.lastActiveFile = newFile instanceof TFile ? newFile : null;
      })
    );
    
    console.log('Mail plugin loaded');
  }
  
  /** 激活/打开 Foxmail 风格邮件视图 */
  async activateMailView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(MAIL_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = existing.length > 0 ? existing[0] : null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: MAIL_VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
  
  /** 在新标签页中打开写信视图（所有发件入口统一走这里） */
  async openComposeView(
    initialData: { accountId?: string; to?: string; cc?: string; bcc?: string; subject?: string; content?: string } = {},
    attachments: Array<{ filename: string; content: Buffer }> = [],
    sourceFile: TFile | null = null,
    draftFile: TFile | null = null
  ): Promise<ObMailComposeView | null> {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: COMPOSE_VIEW_TYPE, active: true });
    const view = leaf.view;
    if (!(view instanceof ObMailComposeView)) return null;
    
    view.initCompose(initialData, attachments, sourceFile, draftFile);
    
    // 拦截关闭：内容被修改且未发送时，询问是否保存草稿
    if (!(leaf as any).obmailDetachWrapped) {
      (leaf as any).obmailDetachWrapped = true;
      const origDetach = leaf.detach.bind(leaf);
      (leaf as any).detach = async () => {
        const v = leaf.view;
        if (v instanceof ObMailComposeView && v.isDirty() && !this.isUnloading) {
          const choice = await askComposeCloseChoice(this.app);
          if (choice === 'cancel') return;
          if (choice === 'save') {
            try {
              await v.saveCurrentDraft();
              new Notice('草稿已保存');
            } catch (err) {
              console.error('关闭前保存草稿失败:', err);
              new Notice('保存草稿失败，已取消关闭');
              return;
            }
          }
        }
        await origDetach();
      };
    }
    
    return view;
  }
  
  /** 刷新所有已打开的邮件视图 */
  refreshMailView() {
    const leaves = this.app.workspace.getLeavesOfType(MAIL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MailFoxmailView) {
        view.refresh();
      }
    }
  }
  
  /**
   * 同步所有 Markdown 标签页的邮件操作按钮栏：
   * - 邮件笔记（type: 邮件笔记/发出邮件）在 .view-content 顶部显示唯一按钮栏
   * - 非邮件笔记则移除按钮栏
   */
  syncMailActionBars() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) continue;
        const contentEl = (view as any).contentEl as HTMLElement | undefined;
        if (!contentEl) continue;
        
        const file = view.file;
        const fm = file ? (this.app.metadataCache.getFileCache(file)?.frontmatter || null) : null;
        const isMail = !!file && !!fm && (fm.type === '邮件笔记' || fm.type === '发出邮件');
        
        let bar = contentEl.querySelector(':scope > .obmail-action-bar') as HTMLElement | null;
        
        if (isMail && file && fm) {
          if (!bar) {
            bar = this.buildMailActionBar(file, fm);
            contentEl.prepend(bar);
            contentEl.classList.add('has-obmail-bar');
          }
        } else if (bar) {
          bar.remove();
          contentEl.classList.remove('has-obmail-bar');
        }
      }
    } catch (err) {
      console.error('同步邮件操作按钮栏失败:', err);
    }
  }
  
  /** 构建 Foxmail 风格操作按钮栏（类名统一 obmail- 前缀，避免与 Obsidian 内置元素冲突） */
  buildMailActionBar(file: TFile, fm: Record<string, any>): HTMLElement {
    const bar = createDiv('obmail-action-bar');
    
    const mkBtn = (label: string, icon: string, onClick: () => void, danger = false) => {
      const btn = bar.createEl('button', { cls: `obmail-action-btn${danger ? ' obmail-action-btn-danger' : ''}` });
      const iconEl = btn.createSpan('obmail-action-btn-icon');
      setIcon(iconEl, icon);
      btn.createSpan({ text: label });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return btn;
    };
    
    mkBtn('回复', 'reply', () => replyToEmail(this, file));
    mkBtn('回复全部', 'reply-all', () => replyAllEmail(this, file));
    mkBtn('转发', 'forward', () => forwardEmail(this, file));
    mkBtn('作为附件转发', 'paperclip', () => forwardEmailAsAttachment(this, file));
    if (fm.type === '邮件笔记') {
      mkBtn('标记为垃圾邮件', 'ban', () => {
        new ConfirmModal(
          this.app,
          `将邮件「${fm.subject || file.name}」标记为垃圾邮件？\n邮件将移动到账户的「垃圾邮件」文件夹。`,
          () => { markEmailAsSpam(this, file); },
          () => {}
        ).open();
      }, true);
    }
    
    return bar;
  }
  
  async onunload() {
    this.isUnloading = true;
    // 清理自动同步定时器
    this.clearSyncTimer();
    
    // styles.css 由 Obsidian 自动管理（随插件启用/禁用加载与卸载），无需手动清理
    console.log('Mail plugin unloaded');
  }
  
  // 更新自动同步定时器
  updateSyncTimer() {
    // 清理现有定时器
    this.clearSyncTimer();
    
    // 设置新的定时器
    const intervalMs = this.settings.syncInterval * 60 * 1000;
    this.syncTimer = window.setInterval(() => {
      this.receiveEmail(true); // 传递isAutoSync参数为true，表示自动同步
    }, intervalMs);
    
    console.log(`自动同步定时器已设置，间隔：${this.settings.syncInterval}分钟`);
  }
  
  // 清理自动同步定时器
  clearSyncTimer() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log('自动同步定时器已清理');
    }
  }
  
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  
  async saveSettings() {
    await this.saveData(this.settings);
  }
  
  // 收取邮件（force=true 时忽略去重列表，重新解析已下载的邮件，用于修复旧邮件渲染问题）
  async receiveEmail(isAutoSync: boolean = false, force: boolean = false) {
    if (this.settings.accounts.length === 0) {
      if (!isAutoSync) {
        new Notice('请先添加邮件账户');
      }
      return;
    }
    
    if (!isAutoSync) {
      new Notice('开始收取邮件...');
    }
    
    let totalDownloaded = 0;
    let hasMoreEmails = false;
    
    // 遍历所有账户，收取邮件
    for (const account of this.settings.accounts) {
      try {
        const downloaded = await this.fetchEmailsForAccount(account, isAutoSync, force);
        totalDownloaded += downloaded;
        
        // 如果本次下载了100封邮件，可能还有更多邮件
        if (downloaded === 100) {
          hasMoreEmails = true;
        }
      } catch (err) {
        console.error(`收取账户 ${account.name} 的邮件时出错:`, err);
        if (!isAutoSync) {
          new Notice(`收取账户 ${account.name} 的邮件时出错: ${(err as Error).message}`);
        }
      }
    }
    
    if (!isAutoSync) {
      if (totalDownloaded === 0) {
        new Notice('所有邮件已全部下载完成');
      } else {
        new Notice(`本次共收取 ${totalDownloaded} 封邮件${hasMoreEmails ? '，还有更多邮件待下载' : ''}`);
      }
    }
    
    // 收取完成后刷新 Foxmail 视图
    this.refreshMailView();
  }
  
  // 为单个账户收取邮件
  async fetchEmailsForAccount(account: MailAccount, isAutoSync: boolean = false, force: boolean = false): Promise<number> {
    let imapClient = await this.connectIMAP(account);
    const plugin = this;
    let downloadedCount = 0;
    
    // 获取已获取的邮件ID列表
    console.log('初始settings.fetchedEmailIds:', this.settings.fetchedEmailIds);
    const fetchedIds = this.settings.fetchedEmailIds[account.id] || [];
    console.log(`为账户 ${account.id} 加载已获取邮件ID列表，共 ${fetchedIds.length} 个ID:`, fetchedIds);
    
    // 获取邮件
    await new Promise<void>((resolve, reject) => {
      imapClient.openBox('INBOX', false, (err: any, box: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        // 计算15天前的日期
        const fifteenDaysAgo = new Date();
        fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
        
        // 调试日志：查看日期对象
        console.log('15天前的日期:', fifteenDaysAgo);
        
        // 根据是否是自动同步选择搜索条件
        // 开启"收取后标记已读"后，已收取的邮件会被标 \Seen，因此搜索 UNSEEN 即可只拿到未收取的邮件，
        // 大幅减少每次同步的服务端访问（否则每次都要拉全部邮件头再靠 Message-ID 去重）。
        const markReadAfterFetch = plugin.settings.markAsReadAfterFetch ?? true;
        const searchCriteria = (isAutoSync || markReadAfterFetch) ? ['UNSEEN'] : ['ALL'];
        
        imapClient.search(searchCriteria, (err: any, allResults: any) => {
            if (err) {
              reject(err);
              return;
            }
            
            if (allResults.length === 0) {
              console.log('没有新邮件');
              resolve();
              return;
            }
            
            console.log(`共发现 ${allResults.length} 封邮件`);
            console.log(`已获取的邮件ID数量: ${fetchedIds.length}`);
            
            // 在服务器上把邮件标记为已读（\Seen）：批量 STORE，失败则回退逐封。非致命，失败仅告警。
            // 放在搜索回调作用域：头部识别阶段（清理历史未读积压）与逐封下载成功后的标记都会用到。
            const markSeen = (uids: number[]): Promise<void> => new Promise<void>((res) => {
              const list = (uids || []).filter(n => typeof n === 'number' && n > 0);
              if (list.length === 0 || !(plugin.settings.markAsReadAfterFetch ?? true)) { res(); return; }
              const oneByOne = (idx: number) => {
                if (idx >= list.length) { res(); return; }
                try {
                  imapClient.addFlags([list[idx]], '\\Seen', () => oneByOne(idx + 1));
                } catch { oneByOne(idx + 1); }
              };
              try {
                imapClient.addFlags(list, '\\Seen', (e: any) => {
                  if (!e) { console.log(`已在服务器标记 ${list.length} 封为已读`); res(); }
                  else { console.warn('批量标记已读失败，改为逐封标记:', e?.message || e); oneByOne(0); }
                });
              } catch (e) {
                console.warn('标记已读异常，改为逐封标记:', (e as any)?.message || e);
                oneByOne(0);
              }
            });

            // 定义处理邮件的函数
            // isFallback=true 表示这是"目标子集返回空"后的兜底整封下载，不再递归兜底
            const processEmails = (
              results: number[],
              onlyRecent: boolean = false,
              isFallback: boolean = false,
              onZero?: (received: number[]) => void,
              metaByUid?: Map<number, { subject: string; size: number; messageId: string }>,
              contentOnlyUids?: Set<number>
            ) => {
              if (results.length === 0) {
                console.log('没有需要处理的邮件');
                resolve();
                return;
              }

              // 关键修复：163 等服务器对"多 UID 逗号集合"的 UID FETCH 常返回空，导致此前误判为
              // "定向下载返回 0"并触发对全部候选邮件的暴力整封下载（连接被大报文掐断、最终什么也没收到）。
              // 改为【逐封 UID 单独取 + 单封失败自动重试一次】，彻底去掉暴力下载，同时更稳。
              console.log(`开始逐封处理 ${results.length} 封邮件（按 UID 单独取，规避服务器对多 UID 集合返回空）, onlyRecent=${onlyRecent}, isFallback=${isFallback}`);

              let totalReceived = 0;
              let reconnects = 0;
              const MAX_RECONNECT = 5;
              // 单封因连接断开时最多重连重试的次数——避免个别"毒邮件"（服务器端对该封固定掐断连接）
              // 耗尽整批预算，连带其余邮件都收不到
              const PER_UID_DROP_RETRY = 1;
              // 连续多少封邮件下载均被服务器掐断，才判定为服务器/网络整体异常并停止本批次
              const MAX_DROP_STREAK = 3;
              const stuckUids: number[] = [];
              let dropStreak = 0;

              // 判断错误是否为"连接被服务器/拆卸关闭"，这类需要重连后继续下载剩余邮件
              const isTeardownError = (err: any): boolean => {
                const msg = String(err?.message || err || '');
                return /ended by the other party|writeAfterFIN|socket.*destroy|EPIPE|connection closed|socket closed|not connected|disconnected|not ready/i.test(msg)
                  || err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_WRITE_AFTER_END';
              };

              // 重新建立连接并选择 INBOX，用于服务器在逐封下载中途断开后续传剩余邮件
              const reconnectAndSelect = async (): Promise<boolean> => {
                try { imapClient.end(); } catch (e) { console.warn('关闭旧连接时忽略异常:', (e as any)?.message); }
                try {
                  imapClient = await plugin.connectIMAP(account);
                  await new Promise<void>((res, rej) => {
                    imapClient.openBox('INBOX', false, (e: any) => (e ? rej(e) : res()));
                  });
                  console.warn('IMAP 已重连并重新选择 INBOX，继续下载剩余邮件');
                  return true;
                } catch (e) {
                  console.error('IMAP 重连失败:', (e as any)?.message || e);
                  return false;
                }
              };

              // 解析并入库（完整下载与"仅正文"下载共用）：contentOnly=true 表示只收了正文、未含附件
              const runParseAndSave = async (emailBuffer: Buffer, uid: number, contentOnly: boolean): Promise<void> => {
                try {
                  console.log(`解析 UID ${uid} 邮件前的buffer长度:`, emailBuffer.length, contentOnly ? '（仅正文，跳过大附件）' : '');
                  const parsed = await mailparser.simpleParser(emailBuffer, {
                    skipImageLinks: true,
                    defaultCharset: 'utf-8'
                  });
                  console.log('邮件解析结果:', {
                    subject: parsed.subject,
                    from: parsed.from?.text || '',
                    to: parsed.to?.text || '',
                    date: parsed.date,
                    hasText: !!parsed.text,
                    hasHtml: !!parsed.html,
                    messageId: parsed.messageId,
                    attachmentsCount: parsed.attachments?.length || 0
                  });

                  const messageId = parsed.messageId ? parsed.messageId.replace(/[<>]/g, '') : '';

                  if (!force && messageId && fetchedIds.includes(messageId)) {
                    console.log('邮件已存在，跳过:', messageId);
                    return;
                  }

                  if (onlyRecent) {
                    const emailDate = parsed.date ? new Date(parsed.date) : new Date();
                    if (emailDate < fifteenDaysAgo) {
                      console.log('跳过超过15天的邮件:', parsed.subject);
                      return;
                    }
                  }

                  console.log('邮件主题:', parsed.subject);
                  console.log('邮件附件数量:', parsed?.attachments?.length);

                  const attachments = parsed?.attachments || [];
                  const emailStatus = '未读';

                  let savedAttachments: any[] = [];
                  if (attachments.length > 0) {
                    savedAttachments = await plugin.saveAttachments(account, parsed, attachments);
                  }
                  const markdownContent = await plugin.createMarkdownContent(account, parsed, attachments, emailStatus, savedAttachments);
                  await plugin.saveEmailToFile(account, parsed, markdownContent);

                  const extractEmail = (str: string) => {
                    const match = str.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                    return match || [];
                  };
                  const fromStr = parsed.from?.text || '';
                  const toStr = parsed.to?.text || '';
                  const addrEntries: Array<{ address?: string; name?: string }> = [
                    ...((parsed.from?.value as any[]) || []),
                    ...((parsed.to?.value as any[]) || [])
                  ];
                  if (addrEntries.length > 0) {
                    for (const entry of addrEntries) {
                      if (entry.address) {
                        await plugin.collectContacts(entry.address, account, entry.name || '');
                      }
                    }
                  } else {
                    const emailAddresses = [...extractEmail(fromStr), ...extractEmail(toStr)];
                    for (const email of emailAddresses) {
                      await plugin.collectContacts(email, account);
                    }
                  }

                  if (messageId) {
                    fetchedIds.push(messageId);
                    console.log('标记邮件为已获取:', messageId, contentOnly ? '（仅正文，大附件未下载）' : '');
                  }
                  downloadedCount++;
                } catch (err) {
                  console.error('解析邮件时出错:', err);
                }
              };

              // 底层：对单个 UID 执行一次 FETCH，按 section（info.which）收集各段原始字节。
              // 连接被服务器掐断时 reject（供上层判定 dropped 并重连），自身清理连接级监听。
              const imapFetch = (client: any, uid: number, options: any): Promise<{ attrs: any; bodies: Record<string, Buffer> }> =>
                new Promise((resolveP, rejectP) => {
                  const attrsOut: any = {};
                  const bodiesOut: Record<string, Buffer> = {};
                  let settledL = false;
                  let f: any;
                  const cleanupL = () => {
                    client.removeListener('end', onDeadL);
                    client.removeListener('close', onDeadL);
                  };
                  const settle = (fn: () => void) => { if (settledL) return; settledL = true; cleanupL(); fn(); };
                  const onDeadL = () => settle(() => rejectP(new Error('connection closed')));
                  try {
                    f = client.fetch([uid], options);
                  } catch (e) {
                    settledL = true;
                    rejectP(e);
                    return;
                  }
                  f.on('message', (msg: any) => {
                    msg.on('attributes', (a: any) => { if (a) Object.assign(attrsOut, a); });
                    msg.on('body', (stream: any, info: any) => {
                      const key = info && info.which != null ? String(info.which) : '';
                      const chunks: Buffer[] = [];
                      stream.on('data', (c: any) => chunks.push(c));
                      stream.once('end', () => { bodiesOut[key] = Buffer.concat(chunks); });
                    });
                  });
                  client.once('end', onDeadL);
                  client.once('close', onDeadL);
                  f.once('error', (e: any) => settle(() => rejectP(e)));
                  f.once('end', () => settle(() => resolveP({ attrs: attrsOut, bodies: bodiesOut })));
                });

              // 遍历 BODYSTRUCTURE，收集正文文本段（text/plain、text/html）的 section 路径与大小。
              // 注意：node-imap 的 Parser 已把 BODYSTRUCTURE 解析成【对象树】，并非原始数组：
              //   - 单段节点 = [ { partID, type, subtype, params, encoding, size, lines, body? } ]
              //   - 多段节点 = [ { type: 'mixed'|'alternative', params }, 子节点数组, 子节点数组, ... ]
              // 单段对象的 partID 即 IMAP 的 section 路径（如 '1'、'2'、'1.2'），正是 BODY[<partID>] 要用的。
              const collectTextParts = (node: any, out: Array<{ section: string; subtype: string; size: number }>) => {
                if (!Array.isArray(node)) return;
                const head = node[0];
                if (head && typeof head === 'object' && !Array.isArray(head)) {
                  const type = String(head.type || '').toLowerCase();
                  const subtype = String(head.subtype || '').toLowerCase();
                  if (head.partID && type === 'text' && (subtype === 'html' || subtype === 'plain')) {
                    out.push({ section: String(head.partID), subtype, size: Number(head.size) || 0 });
                  } else if (type === 'message' && subtype === 'rfc822' && Array.isArray(head.body)) {
                    // 嵌套转发的邮件，其内部正文段也可收（partID 已由库按前缀算好）
                    collectTextParts(head.body, out);
                  }
                }
                // multipart 节点：从下标 1 开始是各子节点数组
                for (let i = 1; i < node.length; i++) {
                  if (Array.isArray(node[i])) collectTextParts(node[i], out);
                }
              };

              // 选出最合适的正文段：优先 HTML，其次 PLAIN；同类型取较大者（通常是完整正文）
              const pickTextSection = (struct: any): string | null => {
                const parts: Array<{ section: string; subtype: string; size: number }> = [];
                collectTextParts(struct, parts);
                const valid = parts.filter(p => p.section && p.section.length > 0);
                if (valid.length === 0) return null;
                const html = valid.filter(p => p.subtype === 'html').sort((a, b) => b.size - a.size);
                if (html.length > 0) return html[0].section;
                return valid.sort((a, b) => b.size - a.size)[0].section;
              };

              // 收集附件段（非正文文本段）的文件名/类型/大小，用于"正文取不到"时的占位笔记说明
              const collectAttachmentParts = (node: any, out: Array<{ name: string; type: string; size: number }>) => {
                if (!Array.isArray(node)) return;
                const head = node[0];
                if (head && typeof head === 'object' && !Array.isArray(head)) {
                  const type = String(head.type || '').toLowerCase();
                  const subtype = String(head.subtype || '').toLowerCase();
                  const isBodyText = type === 'text' && (subtype === 'plain' || subtype === 'html');
                  const params = head.params || {};
                  const dispParams = (head.disposition && head.disposition.params) || {};
                  const dispType = String((head.disposition && head.disposition.type) || '').toLowerCase();
                  const name = dispParams.filename || params.name || '';
                  if (!isBodyText && (name || dispType === 'attachment')) {
                    out.push({
                      name: name || `${type}/${subtype}`,
                      type: `${type}/${subtype}`,
                      size: Number(head.size) || 0
                    });
                  }
                  if (type === 'message' && subtype === 'rfc822' && Array.isArray(head.body)) {
                    collectAttachmentParts(head.body, out);
                  }
                }
                for (let i = 1; i < node.length; i++) {
                  if (Array.isArray(node[i])) collectAttachmentParts(node[i], out);
                }
              };

              // 将原始头部字节拆成 [{name, raw}]（保留折叠续行），遇空行停止
              const splitHeaders = (buf: Buffer): Array<{ name: string; raw: string }> => {
                const text = buf.toString('binary');
                const lines = text.split(/\r?\n/);
                const headers: Array<{ name: string; raw: string }> = [];
                let cur: { name: string; raw: string } | null = null;
                for (const line of lines) {
                  if (line === '') { if (cur) headers.push(cur); break; }
                  if (/^[ \t]/.test(line)) { if (cur) cur.raw += '\r\n' + line; continue; }
                  if (cur) headers.push(cur);
                  const idx = line.indexOf(':');
                  const name = idx >= 0 ? line.slice(0, idx).trim().toLowerCase() : '';
                  cur = { name, raw: line };
                }
                if (cur) headers.push(cur);
                return headers;
              };

              // 用「顶层身份头 + 正文段自身 MIME 头 + 正文段原始（仍按传输编码）字节」合成一封合法单段邮件，
              // 丢弃原 multipart 的 Content-Type/boundary，交给 mailparser 正常解析（会自动按 CTE 解码）
              const buildSinglePartMessage = (headerBuf: Buffer, mimeBuf: Buffer, bodyBuf: Buffer): Buffer => {
                const KEEP = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'reply-to', 'in-reply-to', 'references', 'sender']);
                const idHeaders = splitHeaders(headerBuf).filter(h => KEEP.has(h.name)).map(h => h.raw);
                const mimeHeaders = splitHeaders(mimeBuf)
                  .filter(h => h.name === 'content-type' || h.name === 'content-transfer-encoding')
                  .map(h => h.raw);
                if (mimeHeaders.length === 0) mimeHeaders.push('Content-Type: text/plain; charset=utf-8');
                const head = idHeaders.concat(mimeHeaders).join('\r\n');
                return Buffer.concat([Buffer.from(head + '\r\n\r\n', 'binary'), bodyBuf]);
              };

              // 仅取正文（跳过大附件）：先取 BODYSTRUCTURE+HEADER 定位正文段，再只取该段 MIME 头与内容
              const fetchContentOnlyAttempt = (uid: number, done: (res: { received: boolean; dropped: boolean }) => void) => {
                let received = false;
                let settled = false;
                const client = imapClient;
                const tasks: Promise<void>[] = [];
                let watchdog: any;
                const cleanup = () => {
                  if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
                  client.removeListener('end', onDead);
                  client.removeListener('close', onDead);
                };
                const finish = async (err?: any, forceDropped = false) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  await Promise.allSettled(tasks);
                  if (err) console.error(`获取 UID ${uid}（仅正文）出错:`, err?.message || err);
                  const dropped = forceDropped || (!!err && isTeardownError(err));
                  done({ received, dropped });
                };
                const onDead = () => finish(new Error('connection closed'), true);
                client.once('end', onDead);
                client.once('close', onDead);
                watchdog = setTimeout(() => finish(new Error(`UID ${uid} 仅正文 FETCH 超时`), true), FETCH_TIMEOUT_MS);

                (async () => {
                  console.log(`UID ${uid}：超大邮件，改用 BODYSTRUCTURE 仅取正文（跳过大附件）`);
                  const s1 = await imapFetch(client, uid, { struct: true, bodies: 'HEADER' });
                  const headerBuf: Buffer = s1.bodies['HEADER'] || Buffer.alloc(0);
                  const struct = s1.attrs?.struct;
                  if (headerBuf.length === 0) {
                    await finish(new Error(`UID ${uid} 连头部都未取到（服务器返回空）`));
                    return;
                  }

                  // 兜底：结构里确实没有可取的正文段（例如整封都是附件）时，仍保存一条占位笔记，
                  // 记录主题/发件人/日期与附件清单。否则这封邮件既看不见，又会每次同步被反复重试。
                  const saveStubNote = async (reason: string) => {
                    const atts: Array<{ name: string; type: string; size: number }> = [];
                    collectAttachmentParts(struct, atts);
                    const lines = [
                      '（这封邮件体积较大，自动收取时未能提取正文，已跳过大附件下载。）',
                      `原因：${reason}`
                    ];
                    if (atts.length > 0) {
                      lines.push('', `附件清单（共 ${atts.length} 个，未下载）：`);
                      for (const a of atts.slice(0, 50)) {
                        lines.push(`- ${a.name}（${a.type}，${(a.size / 1024 / 1024).toFixed(2)}MB）`);
                      }
                      if (atts.length > 50) lines.push(`- …另有 ${atts.length - 50} 个附件`);
                    }
                    lines.push('', '请到邮箱网页端查看原文。');
                    const mime = Buffer.from('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n', 'binary');
                    const synthetic = buildSinglePartMessage(headerBuf, mime, Buffer.from(lines.join('\n'), 'utf8'));
                    received = true;
                    tasks.push(runParseAndSave(synthetic, uid, true));
                    await finish();
                  };
                  // 诊断：打印正文候选段（避免结构解析出错时无从下手）
                  const debugParts: Array<{ section: string; subtype: string; size: number }> = [];
                  collectTextParts(struct, debugParts);
                  console.log(`UID ${uid} 正文候选段:`, debugParts.map(p => `${p.section}:${p.subtype}(${p.size}B)`).join(' | ') || '(无)');
                  const sec = pickTextSection(struct);
                  if (!sec) {
                    console.warn(`UID ${uid} 结构中无正文文本段（可能整封都是附件），改为保存占位笔记`);
                    await saveStubNote('结构中未找到 text/plain 或 text/html 正文段');
                    return;
                  }
                  const s2 = await imapFetch(client, uid, { bodies: [`${sec}.MIME`, sec] });
                  const mimeBuf: Buffer = s2.bodies[`${sec}.MIME`] || Buffer.alloc(0);
                  const bodyBuf: Buffer = s2.bodies[sec] || Buffer.alloc(0);
                  if (bodyBuf.length === 0) {
                    console.warn(`UID ${uid} 正文段 ${sec} 返回空，改为保存占位笔记`);
                    await saveStubNote(`正文段 ${sec} 内容为空`);
                    return;
                  }
                  const synthetic = buildSinglePartMessage(headerBuf, mimeBuf, bodyBuf);
                  received = true;
                  tasks.push(runParseAndSave(synthetic, uid, true));
                  await finish();
                })().catch(err => finish(err));
              };

              const attemptContentOnly = (uid: number) =>
                new Promise<{ received: boolean; dropped: boolean }>(r => fetchContentOnlyAttempt(uid, r));

              // 取单封邮件：回调返回 { received, dropped }（dropped 表示连接断开，需要重连重试）
              const FETCH_TIMEOUT_MS = 30000;
              const fetchAttempt = (uid: number, done: (res: { received: boolean; dropped: boolean }) => void) => {
                let received = false;
                let settled = false;
                const messagePromises: Promise<void>[] = [];
                const client = imapClient; // 本次 FETCH 所使用的连接
                let watchdog: any;
                let f: any;
                try {
                  f = client.fetch([uid], { bodies: '' });
                } catch (e) {
                  // 连接已断开时 fetch 可能同步抛错
                  console.error(`对 UID ${uid} 发起 FETCH 失败:`, (e as any)?.message || e);
                  done({ received: false, dropped: true });
                  return;
                }

                // 关键：服务器在 FETCH 期间直接断开时，node-imap 的 fetch 对象常不会再触发
                // 自身的 end/error，导致此处 await 永久挂起、重连续传逻辑永不执行。
                // 因此同时监听底层连接的 end/close，并加超时看门狗，任一发生即以“连接断开”结束本次 FETCH。
                const cleanup = () => {
                  if (watchdog) { clearTimeout(watchdog); watchdog = undefined; }
                  client.removeListener('end', onDead);
                  client.removeListener('close', onDead);
                };
                const finish = async (err?: any, forceDropped = false) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  // 等待本封解析落盘完成，再把已收取记录增量持久化（防止后续连接掐断导致进度丢失）
                  await Promise.allSettled(messagePromises);
                  if (err) console.error(`获取 UID ${uid} 出错:`, err?.message || err);
                  const dropped = forceDropped || (!!err && isTeardownError(err));
                  done({ received, dropped });
                };
                const onDead = () => finish(new Error('connection closed'), true);

                f.on('message', (msg: any) => {
                  console.log(`处理 UID ${uid} 的邮件（开始接收报文）`);
                  let emailBuffer = Buffer.alloc(0);
                  msg.on('body', (stream: any) => {
                    stream.on('data', (chunk: any) => {
                      emailBuffer = Buffer.concat([emailBuffer, chunk]);
                    });
                    stream.once('end', () => {
                      // 只有报文完整接收（stream end）才算“成功取到”，避免传输中途被断开时误判成功而跳过续传
                      received = true;
                      messagePromises.push(runParseAndSave(emailBuffer, uid, false));
                    });
                  });
                });

                client.once('end', onDead);
                client.once('close', onDead);
                watchdog = setTimeout(() => finish(new Error(`UID ${uid} FETCH 超时（连接可能被服务器挂起）`), true), FETCH_TIMEOUT_MS);
                f.once('error', (err: any) => { finish(err); });
                f.once('end', () => { finish(); });
              };

              const attemptOnce = (uid: number) =>
                new Promise<{ received: boolean; dropped: boolean }>(r => fetchAttempt(uid, r));

              const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

              const persistProgress = async () => {
                plugin.settings.fetchedEmailIds[account.id] = fetchedIds;
                try { await plugin.saveSettings(); } catch (e) { console.error('保存去重记录失败:', e); }
              };

              const finalize = () => {
                console.log(`逐封处理完成：成功收取 ${totalReceived}/${results.length} 封` +
                  (stuckUids.length ? `，另有 ${stuckUids.length} 封因服务器持续掐断连接被跳过（留待下次同步重试）` : ''));
                console.log(`即将保存的fetchedIds数量: ${fetchedIds.length}`);
                plugin.settings.fetchedEmailIds[account.id] = fetchedIds;
                plugin.saveSettings().then(() => resolve()).catch(() => resolve());
              };

              const describeUid = (uid: number): string => {
                const meta = metaByUid?.get(uid);
                if (!meta) return `UID ${uid}`;
                const mb = meta.size > 0 ? ` ${(meta.size / 1024 / 1024).toFixed(1)}MB` : '';
                return `UID ${uid} 「${meta.subject}」<${meta.messageId}>${mb}`;
              };

              const processOne = async (index: number) => {
                if (index >= results.length) {
                  if (totalReceived === 0 && onZero) { onZero([]); return; }
                  finalize();
                  return;
                }
                const uid = results[index];
                // 逐封之间留一点间隔，避免命令过于密集触发服务器限流断开
                if (index > 0) await sleep(300);
                // 超大邮件走"仅正文"抓取（跳过大附件），普通邮件走完整抓取
                const attempt = contentOnlyUids?.has(uid) ? attemptContentOnly : attemptOnce;
                let res = await attempt(uid);

                // 单封因连接断开：最多重连重试 PER_UID_DROP_RETRY 次。
                // 仍失败则判定为"毒邮件"（服务器对该封固定掐断），跳过它继续下一封，
                // 而不是让它耗尽整批重连预算——这正是"个别邮件卡住导致其余都收不到"的根因。
                let dropRetry = 0;
                while (!res.received && res.dropped && dropRetry < PER_UID_DROP_RETRY && reconnects < MAX_RECONNECT) {
                  dropRetry++;
                  reconnects++;
                  console.warn(`${describeUid(uid)} 下载中服务器断开，退避后重连重试（本封第 ${dropRetry} 次，累计第 ${reconnects} 次重连）`);
                  await sleep(Math.min(1000 * reconnects, 5000)); // 退避，别被服务器判定为滥用
                  const ok = await reconnectAndSelect();
                  if (!ok) { finalize(); return; }
                  res = await attempt(uid);
                }

                if (res.received) {
                  totalReceived++;
                  dropStreak = 0;
                  // 收取成功后在服务器标记已读，使下次搜索只命中未读、减少重复扫描
                  await markSeen([uid]);
                  await persistProgress();
                  processOne(index + 1);
                  return;
                }

                if (res.dropped) {
                  // 本封重试用尽仍被掐断：记录并跳过（不写入 fetchedEmailIds，下次同步会自动重试）
                  stuckUids.push(uid);
                  dropStreak++;
                  console.error(`跳过持续被服务器掐断连接的邮件：${describeUid(uid)}（连续第 ${dropStreak} 封）`);
                  if (dropStreak >= MAX_DROP_STREAK) {
                    console.error(`连续 ${dropStreak} 封邮件下载均被服务器掐断，判定为服务器/网络整体异常，停止本批次（已收取的已保存，可稍后再收）`);
                    finalize();
                    return;
                  }
                  // 连接已断，必须重连后才能尝试下一封
                  if (reconnects >= MAX_RECONNECT) { finalize(); return; }
                  reconnects++;
                  await sleep(Math.min(1000 * reconnects, 5000));
                  const ok = await reconnectAndSelect();
                  if (!ok) { finalize(); return; }
                  processOne(index + 1);
                  return;
                }

                // 非断开：服务器返回空/未命中，同一连接快速重试一次后跳过，不做无谓重连
                await sleep(500);
                const retry = await attempt(uid);
                if (retry.received) {
                  totalReceived++;
                  dropStreak = 0;
                  await markSeen([uid]);
                  await persistProgress();
                  processOne(index + 1);
                  return;
                }
                console.warn(`${describeUid(uid)} 未取到正文（服务器返回空），跳过继续`);
                await persistProgress();
                processOne(index + 1);
              };

              processOne(0);
            };
            
            // 限制每次最多处理 100 封；最新优先（修复：原先 slice(0,100) 取的是最旧的 100 封）
            const fetchedSet = new Set(fetchedIds);
            const candidates = allResults.slice(-100).reverse();

            // 强制重新解析模式：跳过头部去重，直接完整下载候选邮件
            if (force) {
              console.log(`本次将重新解析 ${candidates.length} 封邮件（强制模式）`);
              processEmails(candidates, false);
              return;
            }

            // 阶段一：仅抓取 Message-ID / DATE 头部字段（极小），据此过滤掉已收取的邮件，
            // 避免对重复邮件下载完整正文/附件——这也是服务器掐断连接（socket ended）的根因。
            // 用 HEADER.FIELDS + 正则直接提取，比把纯头部喂给 mailparser 更可靠
            // （mailparser.simpleParser 对某些 163 邮件在只有头部时取不到 messageId，会误判为新邮件）
            console.log(`先抓取 ${candidates.length} 封邮件的头部字段以识别新邮件...`);
            // size: true → attrs.size（node-imap 将 RFC822.SIZE 映射为 size，整封字节数），用于超大邮件阈值判定；HEADER.FIELDS 附带 SUBJECT 供跳过大邮件时展示
            const headerFetch = imapClient.fetch(candidates, { bodies: 'HEADER.FIELDS (MESSAGE-ID DATE SUBJECT)', size: true });
            // headerInfos 以 UID 为主键：imapClient.fetch 实为 UID FETCH，后续按 UID 精确下载新邮件正文
            const headerInfos: Array<{ uid: number; messageId: string; subject: string; date: Date | null; size: number }> = [];

            const extractHeaderField = (text: string, field: string): string => {
              const m = text.match(new RegExp('^' + field + ':\\s*([^\\r\\n]*)', 'im'));
              return m ? m[1].trim() : '';
            };

            headerFetch.on('message', (msg: any, seqno: any) => {
              // seqno 是服务器返回的"序列号"，与请求所用的 UID 不同；真正用于再下载的是 msg 属性里的 uid
              const rec: { uid: number; messageId: string; subject: string; date: Date | null; size: number } =
                { uid: 0, messageId: '', subject: '', date: null, size: 0 };
              let headerBuffer = Buffer.alloc(0);
              msg.on('attributes', (attrs: any) => {
                if (attrs && typeof attrs.uid === 'number') rec.uid = attrs.uid;
                // node-imap 将 RFC822.SIZE 映射为 attrs.size（见 Connection.js FETCH_ATTR_MAP），
                // 此前误读 attrs['rfc822size'] 恒为 undefined → size 恒为 0 → 超大邮件从未被拦截，
                // 导致对 17MB 这类大邮件直接取正文、被服务器在传输中掐断连接。
                if (attrs) {
                  const sz = attrs.size ?? attrs['rfc822size'];
                  const n = typeof sz === 'number' ? sz : (typeof sz === 'string' ? parseInt(sz, 10) : NaN);
                  if (!isNaN(n) && n > 0) rec.size = n;
                }
              });
              msg.on('body', (stream: any) => {
                stream.on('data', (chunk: any) => {
                  headerBuffer = Buffer.concat([headerBuffer, chunk]);
                });
                stream.on('end', () => {
                  const raw = headerBuffer.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
                  rec.messageId = extractHeaderField(raw, 'Message-ID').replace(/[<>]/g, '');
                  rec.subject = extractHeaderField(raw, 'Subject') || '(无主题)';
                  const dateStr = extractHeaderField(raw, 'Date');
                  if (dateStr) {
                    const d = new Date(dateStr);
                    if (!isNaN(d.getTime())) rec.date = d;
                  }
                });
              });
              // msg 的 'end' 在 attributes 与所有 body 处理完毕后触发，此时 uid/messageId/date 均已就绪
              msg.on('end', () => {
                if (rec.uid > 0) headerInfos.push(rec);
                else console.warn(`邮件头缺少 UID（序列号 ${seqno}），将按 messageId 兜底`);
              });
            });

            headerFetch.once('error', (err: any) => {
              console.error('抓取邮件头时出错，回退为完整下载:', err);
              processEmails(candidates, false);
            });

            headerFetch.once('end', async () => {
              // 新邮件 = Message-ID 不在已获取列表中（取不到 ID 的保守纳入，交由完整下载后的二次去重）
              const newEntries = headerInfos.filter(info => !info.messageId || !fetchedSet.has(info.messageId));
              const skippedExisting = headerInfos.filter(info => info.messageId && fetchedSet.has(info.messageId));
              console.log(`头部字段识别完成：候选 ${headerInfos.length} 封，已收取 ${skippedExisting.length} 封，新邮件 ${newEntries.length} 封`);
              // 诊断：列出被判为"已收取"而跳过的邮件，方便核对是否有"其实没收到却被标为已收取"的情况
              if (skippedExisting.length > 0) {
                console.log('已收取（跳过）明细：', skippedExisting.map(e => `${e.uid}:${e.subject}<${e.messageId}>`).join(' | '));
                // 这些邮件此前已收取但可能仍为未读（历史遗留）：顺手标记已读，清理积压，
                // 之后 UNSEEN 搜索就不会再反复把它们拉回来。
                await markSeen(skippedExisting.map(e => e.uid));
              }
              const noUidCount = candidates.length - headerInfos.length;
              if (noUidCount > 0) {
                console.warn(`有 ${noUidCount} 封候选邮件未能取到 UID，将不会参与本次收取（通常是服务器异常，可重试）`);
              }

              if (newEntries.length === 0) {
                console.log('没有新邮件需要下载');
                new Notice('没有新邮件');
                resolve();
                return;
              }

              const downloadNew = async (entries: typeof newEntries, ignoreThreshold = false) => {
                // 超大邮件阈值（MB）：整封大小超过此值则跳过自动下载，避免触发服务器大报文限流/掐断
                const thresholdMB = plugin.settings.largeEmailThresholdMB ?? 10;
                const thresholdBytes = thresholdMB > 0 ? thresholdMB * 1024 * 1024 : 0;
                let normalEntries = entries;
                let oversizedEntries: typeof entries = [];
                if (!ignoreThreshold && thresholdBytes > 0) {
                  oversizedEntries = entries.filter(e => e.size > thresholdBytes);
                  normalEntries = entries.filter(e => e.size <= thresholdBytes || e.size === 0);
                }

                // 记录被跳过的超大邮件元数据（按 messageId 去重），供后续手动下载
                if (oversizedEntries.length > 0) {
                  if (!plugin.settings.oversizedEmails) plugin.settings.oversizedEmails = {};
                  const list = plugin.settings.oversizedEmails[account.id] || [];
                  const known = new Set(list.map(o => o.messageId));
                  const newlyRecorded = oversizedEntries.filter(e => e.messageId && !known.has(e.messageId));
                  for (const e of newlyRecorded) {
                    list.push({ uid: e.uid, messageId: e.messageId, subject: e.subject, size: e.size });
                  }
                  plugin.settings.oversizedEmails[account.id] = list;
                  await plugin.saveSettings();
                  // 仅对本次新记录的超大邮件提示；自动同步只静默记录，避免每 5 分钟重复弹提示
                  if (newlyRecorded.length > 0 && !isAutoSync) {
                    const names = newlyRecorded.map(e => `${e.subject}（${(e.size / 1024 / 1024).toFixed(1)}MB）`).join('\n');
                    console.log(`${newlyRecorded.length} 封超过 ${thresholdMB}MB 的邮件将仅收取正文（跳过大附件，可日后手动整封下载）：`, names);
                    new Notice(`${newlyRecorded.length} 封超大邮件（>${thresholdMB}MB）将仅收取正文、跳过大附件，可日后手动下载：\n${names}`);
                  } else if (newlyRecorded.length > 0) {
                    console.log(`自动同步：${newlyRecorded.length} 封超大邮件（>${thresholdMB}MB）仅收取正文、跳过大附件`);
                  }
                }

                // 超大邮件也参与本次收取，但走"仅正文"模式（跳过大附件，只取头部+正文文本段），
                // 既避免服务器因大报文掐断连接，又能把邮件内容收进来；附件仍可日后手动整封下载。
                const contentOnlyUids = new Set<number>(
                  oversizedEntries.map(e => e.uid).filter(n => typeof n === 'number' && n > 0)
                );

                // 按真实 UID 去重升序：imapClient.fetch 即 UID FETCH，用 UID 才能精确命中"新邮件"正文
                const downloadable = [...normalEntries, ...oversizedEntries];
                const uids = [...new Set(downloadable.map(e => e.uid))]
                  .filter(n => typeof n === 'number' && n > 0)
                  .sort((a, b) => a - b);
                console.log(`本次将下载 ${uids.length} 封新邮件（其中 ${contentOnlyUids.size} 封超大邮件仅取正文、跳过大附件），UID=[${uids.join(',')}]`,
                  downloadable.map(e => `${e.uid}:${e.messageId}${contentOnlyUids.has(e.uid) ? '(仅正文)' : ''}`).join(' | '));
                if (uids.length === 0) {
                  console.log('没有需要立即下载的新邮件，结束');
                  resolve();
                  return;
                }

                // 逐封 UID 下载（单封断开最多重连重试 1 次后跳过，避免个别毒邮件卡住整批）
                const metaByUid = new Map<number, { subject: string; size: number; messageId: string }>(
                  downloadable.map(e => [e.uid, { subject: e.subject, size: e.size, messageId: e.messageId }])
                );
                processEmails(uids, false, false, () => {
                  console.warn('本次所有新邮件逐封 UID 取正文均未取到，已跳过（不做暴力全量下载，可稍后重试或手动单封下载）');
                  new Notice('部分新邮件本次未能取回正文，已跳过；可稍后重试');
                  resolve();
                }, metaByUid, contentOnlyUids);
              };

              // 自动同步：只下载最近 15 天内的新邮件（更符合"收取最新"的诉求）
              if (isAutoSync) {
                const recent = newEntries.filter(e => !e.date || e.date >= fifteenDaysAgo);
                if (recent.length === 0) {
                  console.log('没有 15 天内的新邮件');
                  resolve();
                  return;
                }
                downloadNew(recent);
                return;
              }

              // 手动获取：仅当新邮件超过 30 封时才弹框确认，否则直接下载全部新邮件
              if (newEntries.length <= 30) {
                downloadNew(newEntries);
                return;
              }

              const message = `发现 ${newEntries.length} 封新邮件（已自动跳过 ${skippedExisting.length} 封重复邮件）。

是否下载全部新邮件？

如果选择"取消"，将只下载最近 15 天内的新邮件。`;

              new ConfirmModal(plugin.app, message, () => {
                // 用户确认下载所有新邮件
                downloadNew(newEntries);
              }, () => {
                // 用户取消，只下载 15 天内的新邮件
                const recent = newEntries.filter(e => !e.date || e.date >= fifteenDaysAgo);
                downloadNew(recent);
              }).open();
            });
          });
        });
    });
    
    // 关闭连接（服务器可能已主动断开，end() 对已销毁套接字可能同步抛错，做兜底）
    try { imapClient.end(); } catch (e) { console.warn('关闭 IMAP 连接时忽略异常:', (e as any)?.message); }
    
    return downloadedCount;
  }

  /**
   * 手动下载此前因超过阈值而被跳过的超大邮件（不限制大小）。
   * 按账户记录的 UID 精确取正文，成功后移除对应记录；失败的保留以便重试。
   */
  async downloadOversizedEmails(): Promise<number> {
    const plugin = this;
    let total = 0;
    for (const account of this.settings.accounts) {
      const list = this.settings.oversizedEmails?.[account.id] || [];
      if (list.length === 0) continue;
      const uids = [...new Set(list.map(o => o.uid).filter(n => typeof n === 'number' && n > 0))];
      if (uids.length === 0) continue;
      new Notice(`正在下载 ${account.name} 的 ${uids.length} 封超大邮件…`);
      const imapClient = await this.connectIMAP(account);
      const fetchedIds = this.settings.fetchedEmailIds[account.id] || [];
      await new Promise<void>((resolve, reject) => {
        imapClient.openBox('INBOX', false, (err: any) => {
          if (err) { reject(err); return; }
          const tasks: Promise<void>[] = [];
          const savedMessageIds = new Set<string>();
          const f = imapClient.fetch(uids, { bodies: '' });
          f.on('message', (msg: any) => {
            let emailBuffer = Buffer.alloc(0);
            msg.on('body', (stream: any) => {
              stream.on('data', (chunk: any) => { emailBuffer = Buffer.concat([emailBuffer, chunk]); });
              stream.once('end', () => {
                tasks.push((async () => {
                  try {
                    const parsed = await mailparser.simpleParser(emailBuffer, { skipImageLinks: true, defaultCharset: 'utf-8' });
                    const messageId = parsed.messageId ? parsed.messageId.replace(/[<>]/g, '') : '';
                    if (messageId && fetchedIds.includes(messageId)) return; // 已存在，直接视为完成
                    const attachments = parsed?.attachments || [];
                    const savedAttachments = attachments.length > 0
                      ? await plugin.saveAttachments(account, parsed, attachments) : [];
                    const markdownContent = await plugin.createMarkdownContent(account, parsed, attachments, '未读', savedAttachments);
                    await plugin.saveEmailToFile(account, parsed, markdownContent);
                    if (messageId) { fetchedIds.push(messageId); savedMessageIds.add(messageId); }
                    total++;
                  } catch (e) {
                    console.error('下载超大邮件失败:', e);
                  }
                })());
              });
            });
          });
          f.once('error', (err: any) => {
            console.error('下载超大邮件时出错:', err);
            reject(err);
          });
          f.once('end', async () => {
            await Promise.all(tasks);
            plugin.settings.fetchedEmailIds[account.id] = fetchedIds;
            // 已成功保存或已存在的，从超大记录移除；失败的保留待重试
            plugin.settings.oversizedEmails[account.id] =
              (plugin.settings.oversizedEmails[account.id] || []).filter(o => !savedMessageIds.has(o.messageId));
            await plugin.saveSettings();
            resolve();
          });
        });
      }).catch(err => { console.error(err); });
      try { imapClient.end(); } catch (e) { console.warn('关闭 IMAP 连接时忽略异常:', (e as any)?.message); }
    }
    return total;
  }

  /** 统一规范化 messageId，用于把去重列表与笔记 frontmatter 的 mailID 对齐比较 */
  private normalizeMailId(raw: any): string {
    return String(raw ?? '')
      .replace(/[<>]/g, '')
      .replace(/[\\"'`]/g, '')
      .replace(/:/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 校对去重记录：移除 fetchedEmailIds 中"已标记收取但 vault 里找不到对应笔记文件"的条目。
   * 这样被误判为"已收取"的未收邮件，会在下次收取时重新下载。
   * 只修正内存/设置里的去重索引，绝不删除任何笔记或附件文件。
   * @returns 被清理的条目总数
   */
  async reconcileFetchedIds(): Promise<number> {
    const basePath = this.settings.obmailStoragePath;
    let removedTotal = 0;

    for (const account of this.settings.accounts) {
      const prefix = `${basePath}/${account.name}/收件箱/`;
      // 收集该账户所有已落盘邮件笔记的 mailID（优先用缓存的 frontmatter，缺失时回退读原文）
      const savedIds = new Set<string>();
      const files = this.app.vault.getFiles().filter(
        f => f.path.startsWith(prefix) && f.path.toLowerCase().endsWith('.md')
      );
      for (const f of files) {
        let id = this.app.metadataCache.getFileCache(f)?.frontmatter?.mailID;
        let norm = this.normalizeMailId(id);
        if (!norm) {
          try {
            const content = await this.app.vault.cachedRead(f);
            const m = content.match(/^mailID:\s*([^\r\n]*)/im);
            if (m) norm = this.normalizeMailId(m[1]);
          } catch { /* 读取失败则跳过该文件 */ }
        }
        if (norm) savedIds.add(norm);
      }

      const ids = this.settings.fetchedEmailIds[account.id] || [];
      const kept: string[] = [];
      const removed: string[] = [];
      for (const id of ids) {
        const norm = this.normalizeMailId(id);
        // 取不到 ID 的记录保守保留（无法核验，宁可不去动）
        if (!norm || savedIds.has(norm)) kept.push(id);
        else removed.push(id);
      }

      // 安全阀：仅当确实扫描到已保存笔记时才清理，避免 vault 尚未索引时误删全部记录
      if (savedIds.size > 0 && removed.length > 0) {
        this.settings.fetchedEmailIds[account.id] = kept;
        removedTotal += removed.length;
        console.log(`[${account.name}] 清理 ${removed.length} 条无对应文件的已收取记录:`, removed);
      }
    }

    if (removedTotal > 0) await this.saveSettings();
    return removedTotal;
  }
  
  // 创建Markdown内容
  async createMarkdownContent(account: MailAccount, parsed: any, attachments: any[] = [], emailStatus: string = '未读', savedAttachments?: Array<{originalFilename: string, savedPath: string}>): Promise<string> {
    // 基础信息
    const from = parsed.from?.text || '未知发件人';
    const to = parsed.to?.text || '未知收件人';
    const subject = parsed.subject || '无主题';
    const date = parsed.date || new Date();
    const dateStr = this.getCSTDateString(date);
    const timeStr = this.getCSTTimeString(date);
    
    // 替换可能破坏YAML格式的字符，包括冒号、引号、换行符、反斜杠等
    const sanitizeValue = (value: any): string => {
      // 确保值是字符串类型
      if (value == null) return '';
      let strValue = String(value);
      return strValue
        .replace(/[\\"'`]/g, '') // 移除反斜杠、引号
        .replace(/:/g, '_') // 替换冒号为下划线
        .replace(/\n/g, ' ') // 替换换行符为空格
        .replace(/\r/g, '') // 移除回车符
        .replace(/\t/g, ' ') // 替换制表符为空格
        .trim(); // 移除首尾空白
    };
    
    // 邮件正文
    console.log('邮件正文类型检查:', {
      hasText: !!parsed.text,
      hasHtml: !!parsed.html
    });
    
    // 检查多种可能的正文属性
    let bodyContent = '';
    let obmailScope = '';
    let obmailCss = '';
    if (parsed.text) {
      console.log('使用文本正文:', String(parsed.text).substring(0, 100) + '...');
      bodyContent = String(parsed.text);
    } else if (parsed.html) {
      const htmlStr = String(parsed.html);
      const mode = this.settings.htmlDisplayMode || 'html-styled';
      if (mode === 'formatted') {
        console.log('使用格式化 HTML 源码模式');
        bodyContent = formatHTMLSafely(htmlStr);
      } else if (mode === 'markdown') {
        console.log('使用HTML正文，长度:', htmlStr.length);
        // 将HTML转换为Markdown
        try {
          // 先清理 style/script/注释/缩进，再转换（修复 <style type="text/css"> 导致源码泄露的问题）
          const cleanedHtml = cleanHtmlForMarkdown(htmlStr);
          // 使用html-to-markdown转换，配置更友好的转换选项
          bodyContent = await convert(cleanedHtml, {
            headingStyle: 'atx',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
            // 不下载HTML中的远程资源
            getImageUrl: () => null
          });
          console.log('HTML转换为Markdown成功，结果长度:', bodyContent.length);
        } catch (error) {
          console.error('HTML转换为Markdown时出错:', error);
          // 如果转换失败，返回错误信息
          bodyContent = '[无法解析HTML内容]';
        }
      } else {
        // html-styled：保留原始样式渲染
        // 1. 提取 CSS 并加作用域前缀（只在本邮件的 scope div 内生效，不污染 Obsidian）
        // 2. 正文包裹同名 scope div，规范化为 Markdown 安全的 HTML 块
        console.log('使用保留原始样式模式，HTML长度:', htmlStr.length);
        obmailScope = `obmail-s-${simpleHash((parsed.messageId || '') + (parsed.subject || '') + dateStr)}`;
        const extracted = extractStyles(htmlStr);
        obmailCss = scopeCss(extracted.css, obmailScope);
        const bodyHtml = normalizeHtmlBlock(extracted.html);
        bodyContent = `<div class="${obmailScope} obmail-mail-body">\n${bodyHtml}\n</div>`;
      }
    } else {
      console.log('未找到任何邮件正文内容');
      bodyContent = '[邮件正文为空]';
    }
    
    let markdown = `---
type: 邮件笔记
created: ${dateStr} ${timeStr}
status: ${sanitizeValue(emailStatus)}
from: ${sanitizeValue(from)}
to: ${sanitizeValue(to)}
subject: ${sanitizeValue(subject)}
account: ${sanitizeValue(account.name)}
mailID: ${sanitizeValue(parsed.messageId || '')}
cssclasses:
  - email-note
${obmailScope ? `obmailscope: ${obmailScope}
obmailcss: |
${obmailCss.split('\n').map(l => '  ' + l).join('\n')}
` : ''}---

# ${subject}

${bodyContent}
`;
    
    // 附件链接
    if (attachments.length > 0) {
      markdown += '\n\n## 附件\n';
      
      attachments.forEach(attachment => {
        // 将附件文件名中的空格和特殊字符替换为下划线
        const sanitizedFilename = this.sanitizeAttachmentFilename(attachment.filename, this.mimeToExt(attachment.mimeType));
        
        // 查找对应的已保存附件路径
        let attachmentPath = null;
        if (savedAttachments && savedAttachments.length > 0) {
          const savedAttachment = savedAttachments.find(sa => sa.originalFilename === attachment.filename);
          if (savedAttachment) {
            // 从完整路径中提取相对路径用于链接
            const relativePath = savedAttachment.savedPath.substring(savedAttachment.savedPath.indexOf('收件箱/'));
            attachmentPath = relativePath;
          }
        }
        
        // 如果没有找到对应的已保存路径，使用默认路径
        if (!attachmentPath) {
          // 获取日期用于创建路径
          const date = parsed.date || new Date();
          const dateStr = this.getCSTDateString(date); // YYYY-MM-DD格式 (东八区时间)
          
          // 使用全局设置的附件文件夹名称
          const attachmentsFolderName = this.settings.obmailAttachmentDir;
          
          // 附件相对路径，按照新的日期子文件夹结构（在收件箱/附件/YYYY-MM-DD/）
          const attachmentsRelPath = `收件箱/${attachmentsFolderName}/${dateStr}`;
          attachmentPath = `${attachmentsRelPath}/${sanitizedFilename}`;
        }
        
        markdown += `- [${sanitizedFilename}](${attachmentPath})`;
      });
    }
    
    return markdown;
  }
  
  // 从联系人文件读取并转换为新数据结构（用于向后兼容）
  async migrateContactsFromFile(account: MailAccount): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.settings.obmailStoragePath;
    const contactsPath = `${basePath}/${account.name}/联系人.md`;
    
    try {
      const contactsFile = vault.getAbstractFileByPath(contactsPath);
      if (contactsFile && contactsFile instanceof TFile) {
        const content = await vault.read(contactsFile);
        const lines = content.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('- ') && !line.includes('<')) {
            // 旧格式：- 邮箱地址
            const email = line.substring(2).trim();
            if (email && !this.settings.contacts.some(contact => contact.email === email)) {
              const newContact: Contact = {
                id: `contact-${Date.now()}`,
                name: email.split('@')[0],
                email: email
              };
              this.settings.contacts.push(newContact);
            }
          } else if (line.startsWith('- ') && line.includes('<')) {
            // 新格式：- 姓名 <邮箱地址>
            const match = line.match(/^-\s*(.+?)\s*<([^>]+)>\s*$/);
            if (match) {
              const name = match[1];
              const email = match[2];
              if (email && !this.settings.contacts.some(contact => contact.email === email)) {
                const newContact: Contact = {
                  id: `contact-${Date.now()}`,
                  name: name,
                  email: email
                };
                this.settings.contacts.push(newContact);
              }
            }
          }
        }
        
        // 保存迁移后的联系人列表
        if (this.settings.contacts.length > 0) {
          this.saveSettings();
        }
      }
    } catch (err) {
      console.error('迁移联系人时出错:', err);
    }
  }

  // 将联系人写入到账号下的联系人.md文件
  async writeContactsToFile(account: MailAccount): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.settings.obmailStoragePath;
    const contactsPath = `${basePath}/${account.name}/联系人.md`;

    try {
      // 确保目录存在
      await this.ensureDirectoryExists(`${basePath}/${account.name}`);

      // 准备联系人内容
      let contactsContent = '# 联系人\n\n';
      
      // 添加自己的邮箱地址作为默认联系人
      if (account.email) {
        const existingContact = this.settings.contacts.find(contact => contact.email === account.email);
        if (!existingContact) {
          const newContact: Contact = {
            id: `contact-${Date.now()}`,
            name: account.name,
            email: account.email
          };
          this.settings.contacts.push(newContact);
          await this.saveSettings();
        }
      }

      // 按姓名字母顺序排序联系人
      const sortedContacts = [...this.settings.contacts].sort((a, b) => {
        const nameA = a.name || '';
        const nameB = b.name || '';
        return nameA.localeCompare(nameB);
      });

      // 添加联系人列表，格式：- 姓名 <邮箱地址>
      sortedContacts.forEach(contact => {
        contactsContent += `- ${contact.name} <${contact.email}>\n`;
      });

      // 保存或更新联系人.md文件
      const contactsFile = vault.getAbstractFileByPath(contactsPath);
      if (contactsFile && contactsFile instanceof TFile) {
        // 更新现有文件
        await vault.modify(contactsFile, contactsContent);
      } else {
        // 创建新文件
        await vault.create(contactsPath, contactsContent);
      }
    } catch (err) {
      console.error('写入联系人文件时出错:', err);
    }
  }

  // 保存邮件到文件
  async saveEmailToFile(account: MailAccount, parsed: any, markdownContent: string): Promise<void> {
    const vault = this.app.vault;
    const basePath = this.settings.obmailStoragePath;
    
    // 获取日期用于创建子文件夹
    const date = parsed.date || new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const monthFolder = `${year}-${month}`; // YYYY-MM
    const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD
    
    // 根据存储模式配置选择路径结构
    const storageMode = this.settings.storageMode || 'daily';
    let inboxPath: string;
    if (storageMode === 'monthly') {
      // 按年月存储：收件箱/YYYY-MM/
      inboxPath = `${basePath}/${account.name}/收件箱/${monthFolder}`;
    } else {
      // 按年月日存储：收件箱/YYYY-MM/YYYY-MM-DD/
      inboxPath = `${basePath}/${account.name}/收件箱/${monthFolder}/${dateStr}`;
    }
    
    // 确保目录存在
    await this.ensureDirectoryExists(inboxPath);
    
    // 生成文件名（使用主题和日期，格式为：日期-时间-主题.md）
    // 这种格式可以确保文件按时间从新到旧排序（因为文件名以最新日期开头）
    const timeStr = this.convertUTCToCST(date).toISOString().split('T')[1].replace(/[:.]/g, '-').slice(0, 12); // 15-04-05-000000
    // 移除所有特殊字符，包括空格，确保文件名安全
    const subjectStr = (parsed.subject || '无主题').replace(/[/*?:"'<>|\\[\]()（）\u201C\u201D\u2018\u2019\s]/g, '_').replace(/_{2,}/g, '_');
    // 使用邮件主题作为文件名，日期添加到末尾，不使用空格等特殊字符
    const filename = `${subjectStr}${dateStr}-${timeStr}.md`;
    
    // 保存文件
    const filePath = `${inboxPath}/${filename}`;
    
    // 检查文件是否存在，如果存在则添加序号
    let finalFilePath = filePath;
    let counter = 1;
    while (vault.getAbstractFileByPath(finalFilePath)) {
      const ext = '.md';
      const baseName = filename.slice(0, -ext.length);
      // 使用连字符替代空格，确保文件名不包含特殊字符
      finalFilePath = `${inboxPath}/${baseName}-${counter}${ext}`;
      counter++;
    }
    
    await vault.create(finalFilePath, markdownContent);
    
    // 保存成功
    
    new Notice(`邮件已保存: ${finalFilePath.split('/').pop()}`);
  }
  
  /** 从 MIME 类型推导一个短扩展名（仅用于 filename 缺失时兜底） */
  private mimeToExt(mimeType?: string): string {
    if (!mimeType || typeof mimeType !== 'string') return '';
    const map: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
      'application/pdf': '.pdf', 'text/plain': '.txt', 'text/html': '.html',
      'application/zip': '.zip', 'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    };
    return map[mimeType.toLowerCase()] || '';
  }

  /** 清理附件文件名：解码 HTML 实体并替换特殊字符 */
  private sanitizeAttachmentFilename(filename: string, fallbackExt = ''): string {
    // 防御：某些内联附件/畸形 Content-Disposition 的 filename 为 undefined 或空
    let name = (typeof filename === 'string' && filename.trim())
      ? filename
      : `attachment-${Date.now()}${fallbackExt}`;
    // 解码常见 HTML 实体
    name = name
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#8220;/g, '\u201C')
      .replace(/&#8221;/g, '\u201D')
      .replace(/&#8216;/g, '\u2018')
      .replace(/&#8217;/g, '\u2019');
    // 替换特殊字符为下划线
    name = name.replace(/[/*?:"<>|\\[\]()（）\u201C\u201D\u2018\u2019+\s]/g, '_');
    // 合并连续下划线
    name = name.replace(/_{2,}/g, '_');
    // 去除首尾下划线（但保留扩展名前的）
    const ext = name.match(/(\.[^.]+)$/);
    if (ext) {
      const base = name.slice(0, -ext[1].length).replace(/^_+|_+$/g, '');
      name = base + ext[1];
    } else {
      name = name.replace(/^_+|_+$/g, '');
    }
    return name || 'unnamed';
  }

  // 保存附件到指定目录
  async saveAttachments(account: MailAccount, parsed: any, attachments: any[]): Promise<Array<{originalFilename: string, savedPath: string}>> {
    const vault = this.app.vault;
    const basePath = this.settings.obmailStoragePath;
    
    // 获取日期用于创建日期子文件夹
    const date = parsed.date || new Date();
    const dateStr = this.getCSTDateString(date); // YYYY-MM-DD格式 (东八区时间)
    
    // 使用全局设置的附件文件夹名称
    const attachmentsFolderName = this.settings.obmailAttachmentDir;
    
    // 将附件存储在收件箱/附件/YYYY-MM-DD/ 目录结构中
    const attachmentDir = `${basePath}/${account.name}/收件箱/${attachmentsFolderName}/${dateStr}`;
    
    // 确保日期子目录存在
    await this.ensureDirectoryExists(attachmentDir);
    
    // 保存每个附件并跟踪实际保存路径
    const savedAttachments = [];
    
    for (const attachment of attachments) {
      // 将附件文件名中的空格和特殊字符替换为下划线
      const sanitizedFilename = this.sanitizeAttachmentFilename(attachment.filename, this.mimeToExt(attachment.mimeType));
      
      // 检查文件是否已存在，如果存在则添加序号区分
      const ext = path.extname(sanitizedFilename);
      const baseName = path.basename(sanitizedFilename, ext);
      let finalAttachmentPath = `${attachmentDir}/${sanitizedFilename}`;
      let counter = 1;

      try {
        let buffer: Buffer;
        
        // 检查attachment.content是否是流还是已经是Buffer
        if (attachment.content && typeof attachment.content.pipe === 'function') {
          // 如果是流，转换为Buffer
          buffer = await this.streamToBuffer(attachment.content);
        } else {
          // 如果已经是Buffer，直接使用
          buffer = attachment.content;
        }
        
        // 保存到Vault；多封邮件并发保存同名附件时 getAbstractFileByPath 存在竞态，
        // 因此对"已存在"错误做重试，逐个追加序号直到成功，避免附件被丢弃
        while (true) {
          try {
            await vault.createBinary(finalAttachmentPath, buffer);
            break;
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (/already exists/i.test(msg)) {
              finalAttachmentPath = `${attachmentDir}/${baseName}-${counter}${ext}`;
              counter++;
              continue;
            }
            throw err;
          }
        }
        console.log(`附件保存成功: ${finalAttachmentPath}`);
        
        // 记录原始文件名和实际保存路径
        savedAttachments.push({
          originalFilename: attachment.filename,
          savedPath: finalAttachmentPath
        });
      } catch (err) {
        console.error(`保存附件 ${attachment.filename} 时出错:`, err);
      }
    }
    
    return savedAttachments;
  }
  
  // 获取每周的开始日期（周一）
  getWeekStartDate(date: Date): string {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 调整到周一
    const weekStart = new Date(d.setDate(diff));
    return weekStart.toISOString().split('T')[0];
  }
  
  // 将流转换为Buffer
  streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
  
  // 将UTC时间转换为东八区（UTC+8）时间
  convertUTCToCST(date: Date): Date {
    // 创建一个新的Date对象，表示UTC时间
    const utcTime = date.getTime();
    // 加上8小时的毫秒数来转换为东八区时间
    const cstTime = utcTime + (8 * 60 * 60 * 1000);
    return new Date(cstTime);
  }
  
  // 获取东八区时间的日期字符串 (YYYY-MM-DD)
  getCSTDateString(date: Date): string {
    const cstDate = this.convertUTCToCST(date);
    return cstDate.toISOString().split('T')[0];
  }
  
  // 获取东八区时间的时间字符串 (HH-MM-SS)
  getCSTTimeString(date: Date): string {
    const cstDate = this.convertUTCToCST(date);
    const timeStr = cstDate.toISOString().split('T')[1].split('.')[0];
    return timeStr.replace(/:/g, '-');
  }
  
  // 确保目录存在
  async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      const vault = this.app.vault;
      const pathParts = dirPath.split('/');
      let currentPath = '';
      
      for (const part of pathParts) {
        if (!part) continue;
        
        currentPath += currentPath ? `/${part}` : part;
        
        // 检查目录是否存在
        const dir = vault.getAbstractFileByPath(currentPath);
        if (!dir) {
          try {
            await vault.createFolder(currentPath);
          } catch (err: any) {
            if (err.message && err.message.includes('Folder already exists')) {
              console.log(`目录已存在，跳过创建: ${currentPath}`);
            } else {
              throw err;
            }
          }
        } else if (!(dir instanceof TFolder)) {
          throw new Error(`路径 ${currentPath} 已存在但不是目录`);
        }
      }
    } catch (err) {
      console.error('创建目录时出错:', err);
      throw err;
    }
  }

  // 提取文件的frontmatter元数据
  async extractFrontmatter(file: TFile): Promise<Record<string, any>> {
    const content = await this.app.vault.read(file);
    const frontmatterMatch = content.match(/^---\s*([\s\S]*?)\s*---/);
    if (frontmatterMatch && frontmatterMatch[1]) {
      const frontmatterText = frontmatterMatch[1];
      const frontmatter: Record<string, any> = {};
      
      // 解析frontmatter键值对
      frontmatterText.split('\n').forEach(line => {
        line = line.trim();
        if (!line) return;
        
        const [key, ...valueParts] = line.split(':');
        if (key) {
          frontmatter[key.trim()] = valueParts.join(':').trim();
        }
      });
      
      return frontmatter;
    }
    
    return {};
  }



  // 连接 IMAP 服务器
  async connectIMAP(account: MailAccount): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        // 从 Keychain 获取密码（支持使用旧密码作为备用）
        const password = await getPasswordFromKeychain(this.app, account.passwordSecretId, account.password);
          
        const imapOptions: any = {
          user: account.username,
          password: password,
          host: account.imapHost,
          port: account.imapPort,
          tls: account.secure,
          connTimeout: 60000,
          socketTimeout: 120000,
          tlsOptions: {
            rejectUnauthorized: !account.tls
          }
        };
          
        console.log('准备连接 IMAP 服务器:', {
          host: account.imapHost,
          port: account.imapPort,
          secure: account.secure,
          proxyEnabled: account.proxyEnabled,
          username: account.username
        });
      
      // 设置IMAP事件的辅助函数（在这里定义以访问imapOptions）
      const setupIMAPEvents = (imap: any, resolve: any, reject: any) => {
        // 连接成功、已经开始收发数据后置为 true；此后出现的 socket 结束类错误多为
        // 服务器主动断连 / 我们 end() 时对半关闭套接字写 LOGOUT 触发，属良性拆卸噪声，不应报错刷屏
        let established = false;
        const isBenignTeardown = (err: any): boolean => {
          const msg = String(err?.message || err || '');
          return /ended by the other party|writeAfterFIN|socket.*destroy|EPIPE|connection closed/i.test(msg)
            || err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_WRITE_AFTER_END';
        };

        // 连接事件
        imap.once('ready', () => {
          console.log('IMAP连接成功');
          
          // 发送 RFC 2971 IMAP ID。此前上报的是"Obsidian-Mail-Plugin"这种非白名单客户端名，
          // 163/电信(21cn) 等可能据此施加风控（下发 FETCH 时掐断连接）。按方案 A 改为中性的通用
          // IMAP 客户端标识（不冒充 Foxmail / 网易邮箱大师），以降低被识别为可疑客户端而断连的概率。
          imap.id({
            name: 'IMAP',
            version: '1',
            vendor: 'IMAPClient',
            'support-email': ''
          });
          
          established = true;
          resolve(imap);
        });
        
        // 错误事件
        imap.once('error', (err: any) => {
          // 已建立连接后出现的拆卸期良性错误：仅提示，不 reject（promise 已 resolve，reject 无意义且会误报）
          if (established && isBenignTeardown(err)) {
            console.warn('IMAP连接已断开（服务器主动关闭或拆卸期正常现象，邮件数据不受影响）');
            return;
          }
          console.error('IMAP连接错误:', err);
          
          // 检查错误类型并提供更具体的错误信息
          if (err.code === 'ENOTFOUND') {
            console.error(`DNS解析失败: 无法找到主机 ${err.hostname || 'unknown'}`);
          } else if (err.code === 'ECONNREFUSED') {
            console.error('连接被拒绝: 目标服务器拒绝连接');
          } else if (err.code === 'ETIMEDOUT' || (err.message && err.message.includes('Timed out'))) {
            console.error('连接超时: 请检查网络连接和服务器地址');
            // 安全地访问imap.options
            if (imap && imap.options && imap.options.host && imap.options.port) {
              console.error(`目标服务器: ${imap.options.host}:${imap.options.port}`);
            } else {
              console.error(`目标服务器: ${imapOptions.host}:${imapOptions.port}`);
            }
          } else if (err.code === 'ECONNRESET') {
            console.error('连接被重置: 网络连接意外中断');
          } else if (err.code === 'EAI_AGAIN') {
            console.error('DNS查询超时: 请检查DNS设置');
          }
          reject(err);
        });
        
        // 结束事件
        imap.once('end', () => {
          console.log('IMAP连接已关闭');
        });
        
        // 连接服务器
        console.log(`正在连接到IMAP服务器: ${imapOptions.host}:${imapOptions.port} (TLS: ${imapOptions.tls})`);
        imap.connect();
      };
      
      // 如果启用了代理，配置代理连接
      if (account.proxyEnabled && account.proxyHost && account.proxyPort) {
        console.log('使用代理连接IMAP服务器:', {host: account.proxyHost, port: account.proxyPort, type: account.proxyType});
        
        // 创建TCP连接（net 已在文件顶部静态导入）
        const proxySocket = net.createConnection({
          host: account.proxyHost,
          port: account.proxyPort
        }, () => {
          console.log('代理连接成功');
          
          // 如果代理需要认证
          let authHeader = '';
          if (account.proxyUsername && account.proxyPassword) {
            const auth = `${account.proxyUsername}:${account.proxyPassword}`;
            authHeader = `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n`;
          }
          
          // 发送代理连接请求
          const proxyRequest = `CONNECT ${account.imapHost}:${account.imapPort} HTTP/1.1\r\n` +
                             `Host: ${account.imapHost}:${account.imapPort}\r\n` +
                             authHeader +
                             `Connection: close\r\n\r\n`;
          
          console.log(`发送代理CONNECT请求: ${account.imapHost}:${account.imapPort}`);
          proxySocket.write(proxyRequest);
          
          // 读取代理响应
          let response = '';
          proxySocket.on('data', (data: any) => {
            response += data.toString();
            
            // 检查响应是否结束
            if (response.includes('\r\n\r\n')) {
              // 检查响应状态
              if (response.startsWith('HTTP/1.1 200')) {
                console.log('代理隧道建立成功');
                
                // 配置IMAP使用代理套接字
                imapOptions.connection = proxySocket;
                
                // 创建IMAP客户端
                const imap = new Imap(imapOptions);
                setupIMAPEvents(imap, resolve, reject);
              } else {
                console.error('代理隧道建立失败:', response);
                reject(new Error(`代理连接失败: ${response.substring(0, 100)}`));
                proxySocket.destroy();
              }
            }
          });
          
          proxySocket.on('error', (error: any) => {
            console.error('代理连接错误:', error);
            // 更详细地处理不同类型的错误
            if (error.code === 'ENOTFOUND') {
              console.error(`DNS解析失败: 无法找到主机 ${account.imapHost}`);
              reject(new Error(`DNS解析失败: 无法解析IMAP服务器地址 ${account.imapHost}`));
            } else {
              reject(new Error(`代理连接错误: ${error.message}`));
            }
          });
        });
        
        proxySocket.on('error', (error: any) => {
          console.error('代理连接失败:', error);
          // 更详细地处理不同类型的错误
          if (error.code === 'ENOTFOUND') {
            console.error(`DNS解析失败: 无法找到代理服务器 ${account.proxyHost}`);
            reject(new Error(`DNS解析失败: 无法解析代理服务器地址 ${account.proxyHost}`));
          } else if (error.code === 'ECONNREFUSED') {
            console.error('代理连接被拒绝: 请检查代理服务器地址和端口');
            reject(new Error('代理连接被拒绝: 请检查代理服务器设置'));
          } else {
            reject(new Error(`代理连接失败: ${error.message}`));
          }
        });
        
        // 等待代理设置完成
        return;
      }
      
      // 如果没有代理，直接创建 IMAP 连接
      const imap = new Imap(imapOptions);
        
      // 如果没有代理，直接调用 setupIMAPEvents
      setupIMAPEvents(imap, resolve, reject);
      } catch (error: any) {
        console.error('获取密码失败:', error);
        reject(error);
      }
    });
  }
  
  // 创建 SMTP 客户端
  async createSMTPClient(account: MailAccount): Promise<any> {
    // 从 Keychain 获取密码（支持使用旧密码作为备用）
    const password = await getPasswordFromKeychain(this.app, account.passwordSecretId, account.password);
      
    const transportOptions: any = {
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.secure,
      auth: {
        user: account.username,
        pass: password
      },
      tls: {
        rejectUnauthorized: !account.tls
      }
    };
    
    // 如果启用了代理，配置代理连接
    if (account.proxyEnabled && account.proxyHost && account.proxyPort) {
      console.log('使用代理连接SMTP服务器:', {host: account.proxyHost, port: account.proxyPort, type: account.proxyType});
      
      // ProxyAgent 已在文件顶部静态导入（避免 require() 风格导入）
      
      // 构建代理URL
      let proxyUrl = `${account.proxyType}://`;
      if (account.proxyUsername && account.proxyPassword) {
        proxyUrl += `${account.proxyUsername}:${account.proxyPassword}@`;
      }
      proxyUrl += `${account.proxyHost}:${account.proxyPort}`;
      
      // 为transporter添加代理配置
      transportOptions.tls = transportOptions.tls || {};
      transportOptions.tls.agent = new ProxyAgent(proxyUrl);
      
      // 同时也设置socket连接的代理
      transportOptions.agent = new ProxyAgent(proxyUrl);
    }
    
    return nodemailer.createTransport(transportOptions);
  }
  
  // 测试IMAP连接
  async testIMAPConnection(account: MailAccount): Promise<void> {
    console.log('开始测试IMAP连接:', account.name);
    
    // 确保代理字段有默认值
    if (account.proxyEnabled === undefined) account.proxyEnabled = false;
    if (account.proxyHost === undefined) account.proxyHost = '';
    if (account.proxyPort === undefined) account.proxyPort = 8080;
    if (account.proxyType === undefined) account.proxyType = 'http';
    if (account.proxyUsername === undefined) account.proxyUsername = '';
    if (account.proxyPassword === undefined) account.proxyPassword = '';
    
    // 实现重试机制
    const maxRetries = 3;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`IMAP连接尝试 ${attempt}/${maxRetries}`);
        const imap = await this.connectIMAP(account);
        
        // 成功连接后直接关闭连接（测试连接不需要选择邮箱）
        return new Promise((resolve, reject) => {
          imap.once('error', (err: any) => {
            reject(new Error(`IMAP错误: ${err.message}`));
          });
          
          // 直接关闭连接，不尝试关闭邮箱（避免"No mailbox is currently selected"错误）
          imap.end();
          resolve();
        });
      } catch (error) {
        lastError = error;
        console.warn(`IMAP连接尝试 ${attempt} 失败:`, error);
        
        // 如果不是最后一次尝试，等待一段时间后重试
        if (attempt < maxRetries) {
          console.log(`等待 2 秒后进行下一次尝试...`);
          await new Promise(resolve => window.setTimeout(resolve, 2000));
        }
      }
    }
    
    // 如果所有尝试都失败，抛出最后一个错误
    throw lastError;
  }
  
  // 测试SMTP连接
  async testSMTPConnection(account: MailAccount): Promise<void> {
    console.log('开始测试SMTP连接:', account.name);
    
    // 确保代理字段有默认值
    if (account.proxyEnabled === undefined) account.proxyEnabled = false;
    if (account.proxyHost === undefined) account.proxyHost = '';
    if (account.proxyPort === undefined) account.proxyPort = 8080;
    if (account.proxyType === undefined) account.proxyType = 'http';
    if (account.proxyUsername === undefined) account.proxyUsername = '';
    if (account.proxyPassword === undefined) account.proxyPassword = '';
    
    const transporter = await this.createSMTPClient(account);
    
    // 测试连接
    try {
      await transporter.verify();
    } finally {
      // 关闭连接
      transporter.close();
    }
  }
  
  /**
   * 将一批解析出的地址保存到联系人列表（粘贴识别后调用）
   * - 新邮箱 → 新增联系人（带姓名）
   * - 已有邮箱但名称更完整 → 更新姓名
   */
  async saveContactsFromAddresses(addrs: ParsedAddress[], account?: MailAccount): Promise<number> {
    let addedCount = 0;
    let changed = false;
    
    for (const addr of addrs) {
      if (!isValidEmail(addr.email)) continue;
      const existing = this.settings.contacts.find(c => c.email.toLowerCase() === addr.email.toLowerCase());
      if (!existing) {
        this.settings.contacts.push({
          id: `contact-${Date.now()}-${addedCount}`,
          name: addr.name || addr.email.split('@')[0],
          email: addr.email
        });
        addedCount++;
        changed = true;
      } else if (addr.name && existing.name === existing.email.split('@')[0]) {
        // 原名称只是邮箱前缀，用真实姓名替换
        existing.name = addr.name;
        changed = true;
      }
    }
    
    if (changed) {
      await this.saveSettings();
      if (account) {
        await this.writeContactsToFile(account);
      }
    }
    return addedCount;
  }
  
  // 收集联系人
  async collectContacts(email: string, account: MailAccount, name: string = ''): Promise<void> {
    if (email) {
      // 更新内存中的联系人列表
      const existingContactIndex = this.settings.contacts.findIndex(contact => contact.email === email);
      const contactName = name || email.split('@')[0]; // 使用邮箱前缀作为默认姓名
      
      if (existingContactIndex === -1) {
        // 添加新联系人
        const newContact: Contact = {
          id: `contact-${Date.now()}`,
          name: contactName,
          email: email
        };
        this.settings.contacts.push(newContact);
        this.saveSettings();
      } else {
        // 更新现有联系人的姓名（如果提供了新姓名且原姓名是邮箱前缀）
        const existingContact = this.settings.contacts[existingContactIndex];
        if (name && existingContact.name === existingContact.email.split('@')[0]) {
          existingContact.name = name;
          this.saveSettings();
        }
      }

      // 将联系人写入到账号下的联系人.md文件
      await this.writeContactsToFile(account);
    }
  }
  
  // 从草稿发送邮件方法
  async sendFromDraft(): Promise<void> {
    // 获取当前打开的草稿文件
    const activeFile = this.app.workspace.getActiveFile();
    
    if (!activeFile || activeFile.extension !== 'md') {
      new Notice('请先打开一个邮件草稿');
      return;
    }
    
    // 读取草稿内容
    const draftContent = await this.app.vault.read(activeFile);
    
    // 解析草稿元数据
    const metadataMatch = draftContent.match(/---([\s\S]*?)---/);
    if (!metadataMatch) {
      new Notice('无法解析草稿元数据');
      return;
    }
    
    const metadata = metadataMatch[1];
    const accountMatch = metadata.match(/account: (.*)/);
    const toMatch = metadata.match(/to: (.*)/);
    const ccMatch = metadata.match(/cc: (.*)/);
    const bccMatch = metadata.match(/bcc: (.*)/);
    const subjectMatch = metadata.match(/subject: (.*)/);
    const typeMatch = metadata.match(/type: (.*)/);
    const attaMatch = metadata.match(/atta: (.*)/);  // 新增：匹配atta属性
    
    if (!typeMatch || typeMatch[1].trim() !== 'draft') {
      new Notice('这不是一个邮件草稿');
      return;
    }
    
    if (!accountMatch || !subjectMatch) {
      new Notice('草稿信息不完整');
      return;
    }
    
    const accountName = accountMatch[1].trim();
    const to = toMatch ? parseEmailList(toMatch[1]).map(formatAddress) : [];
    const cc = ccMatch ? parseEmailList(ccMatch[1]).map(formatAddress) : [];
    const bcc = bccMatch ? parseEmailList(bccMatch[1]).map(formatAddress) : [];
    const subject = subjectMatch[1].trim();
    
    // 提取草稿正文
    const bodyMatch = draftContent.match(/---[\s\S]*?---([\s\S]*)/);
    const body = bodyMatch ? bodyMatch[1].trim() : '';
    
    // 查找对应的邮件账户
    const account = this.settings.accounts.find(a => a.name === accountName);
    
    // 处理附件：优先使用atta属性指定的附件，否则从草稿文件所在目录下的attachments文件夹加载所有附件
    const attachments: any[] = [];
    
    if (attaMatch) {
      // 使用atta属性指定的附件路径列表（包含相对路径）
      const attachmentPaths = attaMatch[1].trim().split(',').map(path => path.trim());
      
      // 根据相对路径加载附件文件
      for (const attachmentPath of attachmentPaths) {
        // 构建完整路径（相对于草稿文件的父目录）
        const fullPath = `${activeFile.parent?.path ?? ''}/${attachmentPath}`;
        const attachmentFile = this.app.vault.getAbstractFileByPath(fullPath);
        
        if (attachmentFile && attachmentFile instanceof TFile) {
          // 读取附件文件内容
          const fileBuffer = await this.app.vault.readBinary(attachmentFile);
          // 提取文件名作为附件名称
          attachments.push({
            filename: attachmentFile.name,
            content: Buffer.from(fileBuffer)
          });
        }
      }
    } else {
      // 如果没有atta属性，按原有逻辑加载所有附件
      // 获取草稿文件所在的目录
      const draftDir = activeFile.parent?.path ?? '';
      const attachmentsDirPath = `${draftDir}/attachments`;
      const attachmentsDir = this.app.vault.getAbstractFileByPath(attachmentsDirPath);
      
      if (attachmentsDir && attachmentsDir instanceof TFolder) {
        // 遍历附件目录中的所有文件
        for (const child of attachmentsDir.children) {
          if (child instanceof TFile) {
            // 读取附件文件内容
            const fileBuffer = await this.app.vault.readBinary(child);
            attachments.push({
              filename: child.name,
              content: Buffer.from(fileBuffer)
            });
          }
        }
      }
    }
    
    // 打开写信标签页，预填充草稿内容（保存草稿时会更新原草稿文件，不新建）
    await this.openComposeView({
      accountId: account?.id,
      to: to.join(', '),
      cc: cc.join(', '),
      bcc: bcc.join(', '),
      subject: subject,
      content: body
    }, attachments, activeFile, activeFile);
  }

  // 添加发送邮件方法
  async sendEmail(account: MailAccount, to: string[], subject: string, body: string, attachments: any[] = [], cc: string[] = [], bcc: string[] = [], sourceFile?: TFile): Promise<void> {
    try {
      const transporter = await this.createSMTPClient(account);
      
      // 准备邮件选项
      // 在正文后添加签名
      const signature = account.signature ? account.signature.trim() : '';
      const textWithSignature = signature ? `${body.trim()}\n\n--\n${signature}` : body.trim();
      const htmlWithSignature = signature ? `${this.convertMarkdownToHtml(body)}<br><br>--<br>${signature}` : this.convertMarkdownToHtml(body);
      
      const mailOptions: any = {
        from: `${account.name} <${account.email}>`,
        to: to.join(','),
        subject: subject,
        text: textWithSignature, // 带签名的纯文本版本
        html: htmlWithSignature, // 带签名的HTML版本
        attachments: attachments
      };
      
      // 添加抄送和密送
      if (cc && cc.length > 0) {
        mailOptions['cc'] = cc.join(',');
      }
      
      if (bcc && bcc.length > 0) {
        mailOptions['bcc'] = bcc.join(',');
      }
      
      // 发送邮件
      const info = await transporter.sendMail(mailOptions);
      console.log('邮件发送成功:', info.messageId);
      
      // 保存已发送邮件
      await this.saveSentEmail(account, to, subject, body, attachments, cc, bcc, sourceFile);
      
      new Notice('邮件发送成功');
    } catch (err) {
      console.error('发送邮件时出错:', err);
      new Notice(`发送邮件时出错: ${(err as Error).message}`);
      throw err;
    }
  }
  
  // 保存邮件草稿（existingDraft 存在时更新原草稿文件，否则新建）
  async saveDraft(account: MailAccount | null, to: string[], subject: string, body: string, attachments: any[] = [], cc: string[] = [], bcc: string[] = [], sourceFile?: TFile, existingDraft?: TFile): Promise<void> {
    try {
      const vault = this.app.vault;
      const basePath = this.settings.obmailStoragePath;
      
      let draftPath: string;
      let accountName: string;
      let fromEmail: string;
      
      // 根据是否有账户选择不同的草稿路径
      if (account) {
        // 每个账户有自己的草稿箱
        accountName = account.name;
        fromEmail = account.email;
        draftPath = `${basePath}/${accountName}/草稿箱`;
      } else {
        // 没有选定发送账号时，存储在默认目录下的草稿箱
        accountName = '默认账户';
        fromEmail = '';
        draftPath = `${basePath}/草稿箱`;
      }
      
      // 确保草稿目录存在
      await this.ensureDirectoryExists(draftPath);
      
      // 生成草稿文件名
      const date = new Date();
      const dateStr = this.getCSTDateString(date);
      const timeStr = this.convertUTCToCST(date).toISOString().split('T')[1].replace(/[:.]/g, '-').slice(0, 15);
      const draftSubject = subject || '无主题';
      // 移除所有特殊字符，包括空格，确保文件名安全
      const sanitizedSubject = draftSubject.replace(/[/*?:"<>|\s]/g, '_');
      const draftFilename = `${dateStr}-${timeStr}-${sanitizedSubject}-草稿.md`;
      
      // 替换可能破坏YAML格式的字符，包括冒号、引号、换行符、反斜杠等
      const sanitizeValue = (value: any): string => {
        // 确保值是字符串类型
        if (value == null) return '';
        let strValue = String(value);
        return strValue
          .replace(/[\\"'`]/g, '') // 移除反斜杠、引号
          .replace(/:/g, '_') // 替换冒号为下划线
          .replace(/\n/g, ' ') // 替换换行符为空格
          .replace(/\r/g, '') // 移除回车符
          .replace(/\t/g, ' ') // 替换制表符为空格
          .trim(); // 移除首尾空白
      };

      // 构建草稿内容
      let draftContent = `---
type: draft
created: ${dateStr} ${timeStr}
account: ${sanitizeValue(accountName)}
from: ${sanitizeValue(fromEmail)}
to: ${sanitizeValue(to.join(', '))}
cc: ${sanitizeValue(cc.join(', '))}
bcc: ${sanitizeValue(bcc.join(', '))}
subject: ${sanitizeValue(subject)}
`;
      
      // 添加附件信息（如果存在附件）
      if (attachments.length > 0) {
        // 构建附件的相对路径（相对于草稿文件位置）
        const attachmentPaths = attachments.map(att => `attachments/${att.filename}`).join(',');
        draftContent += `atta: ${sanitizeValue(attachmentPaths)}
`;
      }
      
      // 添加来源邮件链接信息（如果存在）
      if (sourceFile) {
        const sourceFileName = sourceFile.basename; // 获取不带扩展名的文件名
        const sourceFilePath = sourceFile.path;      // 获取完整路径
        draftContent += `sourceFile: ${sanitizeValue(sourceFilePath)}
sourceFileName: ${sanitizeValue(sourceFileName)}
`;
      }
      
      draftContent += `---

${body}`;
      
      // 保存草稿文件（从已有草稿打开时更新原文件，避免草稿越存越多）
      if (existingDraft) {
        await vault.modify(existingDraft, draftContent);
      } else {
        const draftFilePath = `${draftPath}/${draftFilename}`;
        await vault.create(draftFilePath, draftContent);
      }
      
      // 保存附件
      if (attachments.length > 0) {
        const attachmentsDir = existingDraft && existingDraft.parent
          ? `${existingDraft.parent.path}/attachments`
          : `${draftPath}/attachments`;
        await this.ensureDirectoryExists(attachmentsDir);
        
        for (const attachment of attachments) {
          // 移除附件文件名中的空格和特殊字符
          const sanitizedAttachmentFilename = this.sanitizeAttachmentFilename(attachment.filename, this.mimeToExt(attachment.mimeType));
          const attachmentPath = `${attachmentsDir}/${sanitizedAttachmentFilename}`;
          const existingFile = vault.getAbstractFileByPath(attachmentPath);
          if (existingFile && existingFile instanceof TFile) {
            await vault.modifyBinary(existingFile, attachment.content);
          } else {
            await vault.createBinary(attachmentPath, attachment.content);
          }
        }
      }
      
      // 保存成功
      
    } catch (err) {
      console.error('保存草稿时出错:', err);
      throw err;
    }
  }

  // 保存已发送邮件
  async saveSentEmail(account: MailAccount, to: string[], subject: string, body: string, attachments: any[] = [], cc: string[] = [], bcc: string[] = [], sourceFile?: TFile): Promise<void> {
    try {
      const vault = this.app.vault;
      const basePath = this.settings.obmailStoragePath;
      
      // 根据存储模式配置选择路径结构
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const monthFolder = `${year}-${month}`; // YYYY-MM
      const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD
      
      const storageMode = this.settings.storageMode || 'daily';
      let sentPath: string;
      if (storageMode === 'monthly') {
        // 按年月存储：已发送/YYYY-MM/
        sentPath = `${basePath}/${account.name}/已发送/${monthFolder}`;
      } else {
        // 按年月日存储：已发送/YYYY-MM/YYYY-MM-DD/
        sentPath = `${basePath}/${account.name}/已发送/${monthFolder}/${dateStr}`;
      }
      await this.ensureDirectoryExists(sentPath);
      
      // 构建邮件对象（用于保存）
      const sentEmail = {
        from: `${account.name} <${account.email}>`,
        to: to.join(', '),
        cc: cc.join(', '),
        bcc: bcc.join(', '),
        subject: subject,
        date: date,
        text: body,
        attachments: attachments
      };
      
      const timeStr = this.getCSTTimeString(date);
      
      // 替换可能破坏YAML格式的字符，包括冒号、引号、换行符、反斜杠等
      const sanitizeValue = (value: any): string => {
        // 确保值是字符串类型
        if (value == null) return '';
        let strValue = String(value);
        return strValue
          .replace(/[\\"'`]/g, '') // 移除反斜杠、引号
          .replace(/:/g, '_') // 替换冒号为下划线
          .replace(/\n/g, ' ') // 替换换行符为空格
          .replace(/\r/g, '') // 移除回车符
          .replace(/\t/g, ' ') // 替换制表符为空格
          .trim(); // 移除首尾空白
      };

      // 构建 Markdown 内容
      let markdown = `---
type: 发出邮件
created: ${dateStr} ${timeStr}
status: 已发邮件
from: ${sanitizeValue(sentEmail.from)}
to: ${sanitizeValue(sentEmail.to)}
cc: ${sanitizeValue(sentEmail.cc)}
bcc: ${sanitizeValue(sentEmail.bcc)}
subject: ${sanitizeValue(sentEmail.subject)}
account: ${sanitizeValue(account.name)}
cssclasses:
  - email-note
`;
      
      // 添加来源邮件链接信息（如果存在）
      if (sourceFile) {
        const sourceFileName = sourceFile.basename; // 获取不带扩展名的文件名
        const sourceFilePath = sourceFile.path;      // 获取完整路径
        markdown += `sourceFile: ${sanitizeValue(sourceFilePath)}
sourceFileName: ${sanitizeValue(sourceFileName)}
`;
      }
      
      // 添加附件信息（如果存在附件）
      if (attachments.length > 0) {
        // 构建附件的相对路径（相对于已发送邮件位置）
        const attachmentPaths = attachments.map(att => {
          const dateStr = this.getCSTDateString(date);
          return `${account.name}/已发送/${this.settings.obmailAttachmentDir}/${dateStr}/${att.filename}`;
        }).join(',');
        markdown += `atta: ${sanitizeValue(attachmentPaths)}
`;
      }
      
      markdown += `---

# ${sentEmail.subject}

${sentEmail.text}
`;
      
      // 附件链接
      if (attachments.length > 0) {
        markdown += '\n\n## 附件\n';
        
        // 使用全局设置的附件文件夹名称
        const attachmentsFolderName = this.settings.obmailAttachmentDir;
        // 日期字符串（用于附件目录）
        const dateStr = this.getCSTDateString(date);
        
        // 附件存储目录（简化路径结构）
        const attachmentDir = `${basePath}/${account.name}/已发送/${attachmentsFolderName}/${dateStr}`;
        // 确保目录存在
        await this.ensureDirectoryExists(attachmentDir);
        
        // 保存附件并生成链接
        for (const attachment of attachments) {
          // 移除附件文件名中的空格和特殊字符
          const sanitizedAttachmentFilename = this.sanitizeAttachmentFilename(attachment.filename, this.mimeToExt(attachment.mimeType));
          
          // 保存附件到正确路径
          const finalAttachmentPath = `${attachmentDir}/${sanitizedAttachmentFilename}`;
          
          // 检查文件是否已存在，如果存在则添加序号区分
          let uniqueAttachmentPath = finalAttachmentPath;
          let counter = 1;
          while (vault.getAbstractFileByPath(uniqueAttachmentPath)) {
            const ext = path.extname(sanitizedAttachmentFilename);
            const baseName = path.basename(sanitizedAttachmentFilename, ext);
            uniqueAttachmentPath = `${attachmentDir}/${baseName}-${counter}${ext}`;
            counter++;
          }
          
          try {
            // 保存附件到Vault
            await vault.createBinary(uniqueAttachmentPath, attachment.content);
            console.log(`附件保存成功: ${uniqueAttachmentPath}`);
          } catch (err) {
            console.error(`保存附件 ${attachment.filename} 时出错:`, err);
          }
          
          // 生成相对附件路径，便于在Obsidian中正确链接
          const attachmentsRelPath = `${account.name}/已发送/${attachmentsFolderName}/${dateStr}`;
          const relAttachmentPath = `${attachmentsRelPath}/${sanitizedAttachmentFilename}`;
          
          // 添加附件链接到Markdown内容
          markdown += `- [${sanitizedAttachmentFilename}](${relAttachmentPath})`;
        }
      }
      
      // 生成文件名
      // 移除所有特殊字符，包括空格，确保文件名安全
      const subjectStr = (subject || '无主题').replace(/[/*?:"<>|\s]/g, '_');
      const filename = `${subjectStr}-${dateStr}-${timeStr}.md`;
      
      // 保存文件
      const filePath = `${sentPath}/${filename}`;
      
      // 检查文件是否存在，如果存在则添加序号
      let finalFilePath = filePath;
      let counter = 1;
      while (vault.getAbstractFileByPath(finalFilePath)) {
        const ext = '.md';
        const baseName = filename.slice(0, -ext.length);
        finalFilePath = `${sentPath}/${baseName} (${counter})${ext}`;
        counter++;
      }
      
      await vault.create(finalFilePath, markdown);
      
      // 保存成功
      
      console.log(`已发送邮件保存成功: ${finalFilePath}`);
    } catch (err) {
      console.error('保存已发送邮件时出错:', err);
      throw err;
    }
  }
  
  // 将Markdown转换为HTML
  convertMarkdownToHtml(markdown: string): string {
    // 简单的Markdown到HTML转换
    let html = markdown;
    
    // 标题
    html = html.replace(/^#{6} (.*$)/gm, '<h6>$1</h6>');
    html = html.replace(/^#{5} (.*$)/gm, '<h5>$1</h5>');
    html = html.replace(/^#{4} (.*$)/gm, '<h4>$1</h4>');
    html = html.replace(/^#{3} (.*$)/gm, '<h3>$1</h3>');
    html = html.replace(/^#{2} (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^#{1} (.*$)/gm, '<h1>$1</h1>');
    
    // 粗体和斜体
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // 链接
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
    
    // 换行
    html = html.replace(/\n/g, '<br>');
    
    return html;
  }
}

/**
 * 从邮件笔记内容中提取纯正文：
 * - 去掉 frontmatter
 * - 去掉一级标题（# 主题）
 * - 去掉「## 附件」链接列表（避免收件人看到无法访问的 Vault 链接）
 */
/**
 * 安全解码 URI：文件名含裸 % 等非法序列时 decodeURIComponent 会抛 URIError，
 * 抛出时返回原字符串，避免转发/打开附件流程整体失败。
 */
function safeDecodeURIComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function extractCleanEmailBody(fileContent: string): string {
  // 去掉 frontmatter
  let content = fileContent.replace(/^---[\s\S]*?---\s*/, '');
  // 去掉「## 附件」及其后面的列表内容（直到下一个二级标题或文件末尾）
  content = content.replace(/\n?## 附件[\s\S]*?(?=\n## |$)/, '');
  // 去掉开头的一级标题行（# 主题）
  content = content.replace(/^\s*# [^\n]*\n?/, '');
  return content.trim();
}

/**
 * 构建 Foxmail 风格的原始邮件引用块
 */
function buildQuotedOriginal(meta: { from: string; date: string; to: string; subject: string }, body: string): string {
  let quote = '\n\n------------------ 原始邮件 ------------------\n';
  if (meta.from) quote += `发件人: ${meta.from}\n`;
  if (meta.date) quote += `发送时间: ${meta.date}\n`;
  if (meta.to) quote += `收件人: ${meta.to}\n`;
  if (meta.subject) quote += `主题: ${meta.subject}\n`;
  quote += `\n${body}`;
  return quote;
}

/**
 * 解析邮件笔记 frontmatter 中的指定字段
 */
function extractMetaField(metadata: string, field: string): string {
  const match = metadata.match(new RegExp(`^${field}: (.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

// 回复邮件功能（支持从邮件视图传入目标文件）
async function replyToEmail(plugin: MailPlugin, targetFile?: TFile) {
  // 获取目标邮件文件（优先传入的文件，其次当前活动文件）
  const activeFile = targetFile || plugin.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== 'md') {
    new Notice('请先打开一封邮件');
    return;
  }

  // 读取邮件内容
  const fileContent = await plugin.app.vault.read(activeFile);

  // 解析元数据
  const metadataMatch = fileContent.match(/---([\s\S]*?)---/);
  if (!metadataMatch) {
    new Notice('无法解析邮件元数据');
    return;
  }

  const metadata = metadataMatch[1];
  const from = extractMetaField(metadata, 'from');
  const subject = extractMetaField(metadata, 'subject');
  const to = extractMetaField(metadata, 'to');
  const created = extractMetaField(metadata, 'created');

  if (!from || !subject) {
    new Notice('无法解析发件人和主题');
    return;
  }

  // 提取纯正文并构建 Foxmail 风格引用
  const cleanBody = extractCleanEmailBody(fileContent);
  const quoted = buildQuotedOriginal({ from, date: created, to, subject }, cleanBody);

  // 打开回复邮件标签页（正文留空，下方附原始邮件引用）
  await plugin.openComposeView({
    to: from,
    subject: subject.startsWith('Re: ') ? subject : `Re: ${subject}`,
    content: quoted
  }, [], activeFile);
}

// 转发邮件功能（支持从邮件视图传入目标文件）
async function forwardEmail(plugin: MailPlugin, targetFile?: TFile) {
  // 获取目标邮件文件
  const activeFile = targetFile || plugin.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== 'md') {
    new Notice('请先打开一封邮件');
    return;
  }

  // 读取邮件内容
  const fileContent = await plugin.app.vault.read(activeFile);

  // 解析元数据
  const metadataMatch = fileContent.match(/---([\s\S]*?)---/);
  if (!metadataMatch) {
    new Notice('无法解析邮件元数据');
    return;
  }

  const metadata = metadataMatch[1];
  const subject = extractMetaField(metadata, 'subject');
  const from = extractMetaField(metadata, 'from');
  const to = extractMetaField(metadata, 'to');
  const date = extractMetaField(metadata, 'created');

  if (!subject) {
    new Notice('无法解析邮件主题');
    return;
  }

  // 提取纯正文并构建 Foxmail 风格引用（不再内嵌 --- 块，避免破坏草稿解析）
  const cleanBody = extractCleanEmailBody(fileContent);
  const forwardedContent = buildQuotedOriginal({ from, date, to, subject }, cleanBody);

  // 处理附件：从邮件笔记中的附件链接加载真实文件（修复：之前只带了无法访问的 URL）
  const attachments: any[] = [];
  const loadedNames = new Set<string>();

  // 候选路径解析：依次尝试多种路径拼接方式
  const resolveAttachment = (linkPath: string, fileName: string): TFile | null => {
    const basePath = plugin.settings.obmailStoragePath;
    const candidates: string[] = [];

    // 1. 相对于存储根目录（旧格式）
    if (!linkPath.startsWith('/')) {
      candidates.push(`${basePath}/${linkPath}`);
    } else {
      candidates.push(linkPath.replace(/^\//, ''));
    }

    // 2. 相对于账户目录（邮件位于 basePath/账户名/收件箱/YYYY-MM/，链接从“收件箱/”开始）
    //    activeFile.parent = YYYY-MM 目录，parent.parent = 收件箱，再上一级 = 账户目录
    let dir: TFolder | null = activeFile.parent;
    for (let i = 0; i < 3 && dir; i++) {
      candidates.push(`${dir.path}/${linkPath}`);
      dir = dir.parent;
    }

    for (const candidate of candidates) {
      // 尝试解码 URI 编码（Obsidian 链接可能对中文/空格编码）
      const variants = [candidate, safeDecodeURIComponent(candidate)];
      for (const v of variants) {
        const f = plugin.app.vault.getAbstractFileByPath(v);
        if (f && f instanceof TFile) return f;
      }
    }

    // 3. 全库按文件名查找（兼容附件目录名被修改的情况）
    const byName = plugin.app.vault.getFiles().find(f => f.name === fileName || safeDecodeURIComponent(f.name) === fileName);
    return byName || null;
  };

  // 从邮件内容中解析附件链接
  const attachmentLines = fileContent.match(/- \[[^\]]+\]\([^)]+\)/g);
  if (attachmentLines) {
    for (const line of attachmentLines) {
      const match = line.match(/- \[(.*?)\]\((.*?)\)/);
      if (!match) continue;
      const fileName = match[1];
      const filePath = match[2];

      if (loadedNames.has(fileName)) continue;

      const attachmentFile = resolveAttachment(filePath, fileName);
      if (attachmentFile) {
        try {
          const fileBuffer = await plugin.app.vault.readBinary(attachmentFile);
          attachments.push({
            filename: attachmentFile.name,
            content: Buffer.from(fileBuffer)
          });
          loadedNames.add(fileName);
          console.log(`转发：已加载附件 ${attachmentFile.path}`);
        } catch (err) {
          console.error(`转发：读取附件失败 ${attachmentFile.path}`, err);
        }
      } else {
        console.warn(`转发：未找到附件文件: ${filePath}`);
      }
    }
  }

  if (attachments.length > 0) {
    new Notice(`转发：已加载 ${attachments.length} 个附件`);
  }

  // 打开转发邮件标签页
  await plugin.openComposeView({
    subject: subject.startsWith('Fwd: ') || subject.startsWith('转发: ') ? subject : `Fwd: ${subject}`,
    content: forwardedContent
  }, attachments, activeFile);
}

// 作为附件转发（Foxmail 同名功能：将原邮件笔记文件作为附件发送）
async function forwardEmailAsAttachment(plugin: MailPlugin, targetFile?: TFile) {
  const activeFile = targetFile || plugin.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== 'md') {
    new Notice('请先打开一封邮件');
    return;
  }

  const fm = plugin.app.metadataCache.getFileCache(activeFile)?.frontmatter || {};
  const subject = String(fm.subject || activeFile.basename || '无主题');

  try {
    const fileContent = await plugin.app.vault.read(activeFile);

    // 解析元数据，构建 Foxmail 风格的引用正文（转发时既带 .md 附件，也复制正文内容）
    const metadataMatch = fileContent.match(/---([\s\S]*?)---/);
    const metadata = metadataMatch ? metadataMatch[1] : '';
    const from = extractMetaField(metadata, 'from');
    const to = extractMetaField(metadata, 'to');
    const date = extractMetaField(metadata, 'created');
    const metaSubject = extractMetaField(metadata, 'subject') || subject;

    const cleanBody = extractCleanEmailBody(fileContent);
    const quoted = buildQuotedOriginal({ from, date, to, subject: metaSubject }, cleanBody);

    const fileBuffer = await plugin.app.vault.readBinary(activeFile);
    const attachments = [{
      filename: activeFile.name,
      content: Buffer.from(fileBuffer)
    }];

    await plugin.openComposeView({
      subject: metaSubject.startsWith('Fwd: ') || metaSubject.startsWith('转发: ') ? metaSubject : `Fwd: ${metaSubject}`,
      content: `（原邮件已作为附件发送）\n\n${quoted}`
    }, attachments, activeFile);
  } catch (err) {
    console.error('作为附件转发失败:', err);
    new Notice(`作为附件转发失败: ${(err as Error).message}`);
  }
}

// 标记为垃圾邮件：移动到账户下的「垃圾邮件」文件夹并更新状态
async function markEmailAsSpam(plugin: MailPlugin, targetFile?: TFile) {
  const activeFile = targetFile || plugin.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== 'md') {
    new Notice('请先打开一封邮件');
    return;
  }

  try {
    const basePath = plugin.settings.obmailStoragePath;
    let accountDir = '';

    // 从路径推断账户目录（basePath/账户名/...）
    if (activeFile.path.startsWith(basePath + '/')) {
      const rel = activeFile.path.substring(basePath.length + 1);
      accountDir = rel.split('/')[0];
    } else {
      // 不在邮件存储目录内，用 frontmatter 的 account 字段
      const fm = plugin.app.metadataCache.getFileCache(activeFile)?.frontmatter || {};
      accountDir = String(fm.account || '默认账户');
    }

    const spamDir = `${basePath}/${accountDir}/垃圾邮件`;
    await plugin.ensureDirectoryExists(spamDir);

    // 目标路径（重名时加序号）
    let newPath = `${spamDir}/${activeFile.name}`;
    let counter = 1;
    while (plugin.app.vault.getAbstractFileByPath(newPath)) {
      const ext = '.md';
      const baseName = activeFile.name.slice(0, -ext.length);
      newPath = `${spamDir}/${baseName}-${counter}${ext}`;
      counter++;
    }

    await plugin.app.fileManager.renameFile(activeFile, newPath);
    await (plugin.app as any).fileManager.processFrontMatter(activeFile, (fm: any) => {
      fm.status = '垃圾邮件';
    });

    new Notice(`已标记为垃圾邮件并移动到: ${newPath}`);
    plugin.refreshMailView();
  } catch (err) {
    console.error('标记垃圾邮件失败:', err);
    new Notice(`标记垃圾邮件失败: ${(err as Error).message}`);
  }
}

// 回复全部邮件功能（支持从邮件视图传入目标文件）
async function replyAllEmail(plugin: MailPlugin, targetFile?: TFile) {
  // 获取目标邮件文件
  const activeFile = targetFile || plugin.app.workspace.getActiveFile();

  if (!activeFile || activeFile.extension !== 'md') {
    new Notice('请先打开一封邮件');
    return;
  }

  // 读取邮件内容
  const fileContent = await plugin.app.vault.read(activeFile);

  // 解析元数据
  const metadataMatch = fileContent.match(/---([\s\S]*?)---/);
  if (!metadataMatch) {
    new Notice('无法解析邮件元数据');
    return;
  }

  const metadata = metadataMatch[1];
  const from = extractMetaField(metadata, 'from');
  const to = extractMetaField(metadata, 'to');
  const cc = extractMetaField(metadata, 'cc');
  const subject = extractMetaField(metadata, 'subject');
  const created = extractMetaField(metadata, 'created');

  if (!from || !subject) {
    new Notice('无法解析发件人和主题');
    return;
  }

  // 构建回复全部的收件人列表（发件人 + 原收件人 + 原抄送，排除自己的邮箱）
  const ownEmails = plugin.settings.accounts.map(a => a.email.toLowerCase()).filter(Boolean);
  const allAddrs = [...parseEmailList(from), ...parseEmailList(to), ...parseEmailList(cc)];
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const addr of allAddrs) {
    const key = addr.email.toLowerCase();
    if (!isValidEmail(addr.email)) continue;
    if (ownEmails.includes(key)) continue; // Foxmail 逻辑：回复全部不包含自己
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(formatAddress(addr));
  }

  // 提取纯正文并构建 Foxmail 风格引用
  const cleanBody = extractCleanEmailBody(fileContent);
  const quoted = buildQuotedOriginal({ from, date: created, to, subject }, cleanBody);

  // 打开回复全部邮件标签页
  await plugin.openComposeView({
    to: recipients.join(', '),
    subject: subject.startsWith('Re: ') ? subject : `Re: ${subject}`,
    content: quoted
  }, [], activeFile);
}
