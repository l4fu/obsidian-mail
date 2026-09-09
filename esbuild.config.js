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

// 生产构建把样式复制为仓库根 styles.css（Obsidian 加载插件时自动读取）。
// main.js / styles.css 已加入 .gitignore，不作为源码提交；
// 打 tag 时 .github/workflows/release.yml 会自动构建，并把 main.js / manifest.json / styles.css 上传为 Release 资产。
function copyStyles() {
  const cssSource = path.join(__dirname, 'styles/foxmail-email.css');
  const cssDest = path.join(__dirname, 'styles.css');
  if (!fs.existsSync(cssSource)) {
    console.warn('⚠️ 警告：样式源文件不存在:', cssSource);
    return;
  }
  fs.copyFileSync(cssSource, cssDest);
  console.log('✅ 已复制:', cssDest);
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
  outfile: 'main.js',
  plugins: [{
    name: 'copy-styles',
    setup(build) {
      build.onEnd(() => {
        copyStyles();
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
