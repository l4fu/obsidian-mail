const esbuild = require('esbuild');
// 使用 Node 内置的 module.builtinModules 替代 builtin-modules 包（审查建议）
const { builtinModules } = require('module');
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

// CSS / manifest 文件处理函数（保证测试 Vault 插件目录与仓库源一致）
async function copyCSS() {
  const cssSource = path.join(__dirname, 'styles/foxmail-email.css');
  const manifestSource = path.join(__dirname, 'manifest.json');
  
  // 两个目标位置都复制
  const pluginDir = path.join(__dirname, './test_note/.obsidian/plugins/ob-mail-client');
  const targets = [
    { src: cssSource, dest: path.join(pluginDir, 'styles.css') },
    { src: manifestSource, dest: path.join(pluginDir, 'manifest.json') },
    // Windows Obsidian 实际插件目录
    // { src: cssSource, dest: path.join(process.env.APPDATA || '', 'Obsidian/.obsidian/plugins/ob-mail-client/styles.css') }
  ];
  
  try {
    for (const { src, dest } of targets) {
      try {
        // 确保目标目录存在
        const destDir = path.dirname(dest);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        
        // 复制文件
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          console.log('✅ 已复制:', dest);
        } else {
          console.warn('⚠️ 警告：源文件不存在:', src);
        }
      } catch (err) {
        console.warn('⚠️ 复制到', dest, '失败:', err.message);
      }
    }
  } catch (err) {
    console.error('❌ 复制文件失败:', err);
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
  target: 'es2018',
  logLevel: 'info',
  sourcemap: isProd ? false : 'inline',
  treeShaking: true,
  outfile: './test_note/.obsidian/plugins/ob-mail-client/main.js',
  plugins: [{
    name: 'copy-css',
    setup(build) {
      build.onEnd(async () => {
        await copyCSS();
      });
    }
  }]
};

// esbuild >= 0.25 移除了 build() 的 watch 选项，开发模式改用 context API
if (isProd) {
  esbuild.build(config).catch(() => process.exit(1));
} else {
  esbuild.context(config).then(ctx => ctx.watch()).catch(() => process.exit(1));
}