const esbuild = require('esbuild');
const builtinModules = require('builtin-modules');
const fs = require('fs');
const path = require('path');
const isProd = process.argv[2] === 'production';

// 添加 Node.js 内置模块（包括带有 node:前缀的版本）
const nodeBuiltins = [
  ...builtinModules,
  // 明确添加带有 node:前缀的内置模块
  'node:buffer',
  'node:stream',
  'node:util',
  'node:net',
  'node:tls',
  'node:dns',
  'node:path',
  'node:fs',
  'node:events'
];

// CSS 文件处理函数
async function copyCSS() {
  const cssSource = path.join(__dirname, 'styles/foxmail-email.css');
  
  // 两个目标位置都复制
  const targets = [
    path.join(__dirname, './test_note/.obsidian/plugins/obsidian-mail/styles.css'),
    // Windows Obsidian 实际插件目录
    // path.join(process.env.APPDATA || '', 'Obsidian/.obsidian/plugins/obsidian-mail/styles.css')
  ];
  
  try {
    for (const cssDest of targets) {
      try {
        // 确保目标目录存在
        const destDir = path.dirname(cssDest);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        
        // 复制 CSS 文件
        if (fs.existsSync(cssSource)) {
          fs.copyFileSync(cssSource, cssDest);
          console.log('✅ CSS 文件已复制到:', cssDest);
        } else {
          console.warn('⚠️ 警告：CSS 源文件不存在:', cssSource);
        }
      } catch (err) {
        console.warn('⚠️ 复制到', cssDest, '失败:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ 复制 CSS 文件失败:', err);
  }
}

const config = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    ...nodeBuiltins,
  ],
  format: 'cjs',
  watch: !isProd,
  target: 'es2018',
  logLevel: 'info',
  sourcemap: isProd ? false : 'inline',
  treeShaking: true,
  outfile: './test_note/.obsidian/plugins/obsidian-mail/main.js',
  plugins: [{
    name: 'copy-css',
    setup(build) {
      build.onEnd(async () => {
        await copyCSS();
      });
    }
  }]
};

esbuild.build(config).catch(() => process.exit(1));