'use strict';

/**
 * build-probe.cjs — 框架探测模块
 *
 * 只读探测：按端目录识别框架、推导默认 command / cwd / artifact_globs
 * 所有探测结果可被 config.dev.json 中的显式配置覆盖。
 */

const fs   = require('fs');
const path = require('path');

// ── 框架标记 → 探测结果映射 ────────────────────────────────────────

/**
 * 探测 probeRoot 内的框架
 * @returns {{ framework, markers[], command, artifact_globs[] } | null}
 */
function probeFramework(probeRoot) {
  // Flutter
  if (fs.existsSync(path.join(probeRoot, 'pubspec.yaml'))) {
    return {
      framework:      'flutter',
      markers:        ['pubspec.yaml'],
      command:        'flutter build apk --release',
      artifact_globs: ['build/app/outputs/**/*.apk'],
    };
  }

  const pkgPath = path.join(probeRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}

    // Taro（project.config.json + app.json）
    if (fs.existsSync(path.join(probeRoot, 'project.config.json')) &&
        fs.existsSync(path.join(probeRoot, 'app.json'))) {
      return {
        framework:      'taro',
        markers:        ['package.json', 'project.config.json', 'app.json'],
        command:        'npm run build:weapp',
        artifact_globs: ['dist/**'],
      };
    }

    // Next.js
    const nextCfg = ['next.config.js', 'next.config.ts', 'next.config.mjs', 'next.config.cjs'];
    if (nextCfg.some(f => fs.existsSync(path.join(probeRoot, f)))) {
      return {
        framework:      'next',
        markers:        ['package.json', 'next.config.*'],
        command:        'npm run build',
        artifact_globs: ['.next/**', 'out/**'],
      };
    }

    // Vite
    const viteCfg = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'];
    if (viteCfg.some(f => fs.existsSync(path.join(probeRoot, f)))) {
      return {
        framework:      'vite',
        markers:        ['package.json', 'vite.config.*'],
        command:        'npm run build',
        artifact_globs: ['dist/**'],
      };
    }

    // Angular
    if (fs.existsSync(path.join(probeRoot, 'angular.json'))) {
      return {
        framework:      'angular',
        markers:        ['package.json', 'angular.json'],
        command:        'npm run build',
        artifact_globs: ['dist/**'],
      };
    }

    // 通用 npm（有 scripts.build）
    if (pkg.scripts && pkg.scripts.build) {
      return {
        framework:      'npm',
        markers:        ['package.json'],
        command:        'npm run build',
        artifact_globs: ['dist/**', 'build/**'],
      };
    }

    // 通用 npm（无 scripts.build）
    return {
      framework:      'npm',
      markers:        ['package.json'],
      command:        'npm run build --if-present',
      artifact_globs: ['dist/**'],
    };
  }

  // Rust
  if (fs.existsSync(path.join(probeRoot, 'Cargo.toml'))) {
    return {
      framework:      'rust',
      markers:        ['Cargo.toml'],
      command:        'cargo build --release',
      artifact_globs: ['target/release/**'],
    };
  }

  // Go
  if (fs.existsSync(path.join(probeRoot, 'go.mod'))) {
    return {
      framework:      'go',
      markers:        ['go.mod'],
      command:        'go build -o bin/ ./...',
      artifact_globs: ['bin/**'],
    };
  }

  // Python
  if (fs.existsSync(path.join(probeRoot, 'pyproject.toml')) ||
      fs.existsSync(path.join(probeRoot, 'setup.py'))) {
    return {
      framework:      'python',
      markers:        ['pyproject.toml'],
      command:        'python -m build',
      artifact_globs: ['dist/*.whl'],
    };
  }

  // 小程序原生（manifest.json + pages/）
  if (fs.existsSync(path.join(probeRoot, 'manifest.json')) &&
      fs.existsSync(path.join(probeRoot, 'pages'))) {
    return {
      framework:      'miniapp-native',
      markers:        ['manifest.json', 'pages/'],
      command:        null,
      artifact_globs: ['miniprogram/**'],
    };
  }

  return null;
}

/**
 * 查找 probeRoot（优先级顺序）
 * 1. config 中指定的 cwd
 * 2. src/<target>/
 * 3. apps/<target>/, packages/<target>/, <target>/
 * 4. 项目根（兜底）
 */
function findProbeRoot(projectRoot, target, targetConfig) {
  // 1. config.cwd
  if (targetConfig && targetConfig.cwd) {
    const cwdPath = path.resolve(projectRoot, targetConfig.cwd);
    if (fs.existsSync(cwdPath)) return cwdPath;
  }

  // 2. src/<target>/
  const srcTarget = path.join(projectRoot, 'src', target);
  if (fs.existsSync(srcTarget)) return srcTarget;

  // 3. 常见 monorepo 路径
  for (const prefix of ['apps', 'packages']) {
    const p = path.join(projectRoot, prefix, target);
    if (fs.existsSync(p)) return p;
  }

  // 4. <target>/ 直接目录
  const direct = path.join(projectRoot, target);
  if (fs.existsSync(direct)) return direct;

  // 5. 项目根
  return projectRoot;
}

/**
 * 推导 install 命令
 */
function getInstallCommand(framework, probeRoot) {
  switch (framework) {
    case 'npm':
    case 'vite':
    case 'next':
    case 'angular':
    case 'taro': {
      const hasLock = fs.existsSync(path.join(probeRoot, 'package-lock.json')) ||
                      fs.existsSync(path.join(probeRoot, 'npm-shrinkwrap.json'));
      return hasLock ? 'npm ci' : 'npm install';
    }
    case 'flutter':
      return 'flutter pub get';
    case 'go':
      return 'go mod download';
    case 'rust':
      return null; // cargo build 自带
    default:
      return null;
  }
}

/**
 * 探测单个 build unit 的完整信息
 * @param {string}  projectRoot  业务项目根路径
 * @param {string}  target       client_target 标识
 * @param {string}  subPlatform  sub_platform id（默认 'default'）
 * @param {object}  targetConfig config.build.client_targets.<target>（可为 null）
 * @param {object}  buildConfig  config.build（可为 null）
 * @returns {ProbeResult}
 */
function probe(projectRoot, target, subPlatform, targetConfig, buildConfig) {
  const probeRoot = findProbeRoot(projectRoot, target, targetConfig);
  const detected  = probeFramework(probeRoot);

  // ── 命令解析（优先级从高到低）────────────────────────────────────
  let command = null;
  let source  = 'fallback';

  // 1. sub_platforms[].build 匹配 sub_platform.id
  if (targetConfig && Array.isArray(targetConfig.sub_platforms)) {
    const spConfig = targetConfig.sub_platforms.find(sp => sp.id === subPlatform);
    if (spConfig && spConfig.build) {
      command = spConfig.build;
      source  = 'config';
    }
  }

  // 2. build.client_targets.<target>.build
  if (!command && targetConfig && targetConfig.build) {
    command = targetConfig.build;
    source  = 'config';
  }

  // 3. build.commands.<target>
  if (!command && buildConfig && buildConfig.commands && buildConfig.commands[target]) {
    command = buildConfig.commands[target];
    source  = 'config';
  }

  // 4. 探测默认命令（flutter ios 特殊处理）
  if (!command && detected) {
    if (detected.framework === 'flutter' && subPlatform === 'ios') {
      command = 'flutter build ios --release --no-codesign';
    } else if (detected.command) {
      command = detected.command;
    }
    if (command) source = 'detected';
  }

  // 5. 全局 build.commands.build（兜底）
  if (!command && buildConfig && buildConfig.commands && buildConfig.commands.build) {
    command = buildConfig.commands.build;
    source  = 'fallback';
  }

  // ── build_type ──────────────────────────────────────────────────
  let build_type;
  const framework = (detected && detected.framework) || 'unknown';

  if (targetConfig && targetConfig.skip === true) {
    build_type = 'skipped';
  } else if (framework === 'backend-source' || (!detected && target === 'backend')) {
    build_type = 'not_applicable';
  } else if (!command) {
    build_type = target === 'backend' ? 'not_applicable' : 'not_configured';
  } else if (source === 'config') {
    build_type = 'configured';
  } else if (source === 'detected') {
    build_type = 'detected';
  } else {
    build_type = 'not_configured';
  }

  // ── artifact_globs ──────────────────────────────────────────────
  let artifact_globs;
  if (targetConfig && targetConfig.artifact_globs) {
    artifact_globs = targetConfig.artifact_globs;
  } else if (detected && detected.framework === 'flutter' && subPlatform === 'ios') {
    artifact_globs = ['build/ios/iphoneos/*.app'];
  } else if (detected && detected.artifact_globs) {
    artifact_globs = detected.artifact_globs;
  } else {
    const artifactsDir = (buildConfig && buildConfig.artifacts_dir) || 'dist';
    artifact_globs = [
      `${artifactsDir}/${target}/${subPlatform}`,
      'dist/**',
      'build/**',
    ];
  }

  // ── install 命令 ────────────────────────────────────────────────
  const installCommand = getInstallCommand(framework, probeRoot);

  return {
    probeRoot,
    framework,
    build_type,
    command,
    artifact_globs,
    markers:        detected ? detected.markers : [],
    source,
    cwd:            probeRoot,
    installCommand,
  };
}

module.exports = { probe, findProbeRoot, probeFramework, getInstallCommand };
