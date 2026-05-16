'use strict';

const fs = require('fs');
const path = require('path');
const { runWithTimeout } = require('./run-with-timeout.cjs');

/** 环境不满足、AI 无法自动修复（对齐 ai-soak3 §3.4） */
const BLOCKER_ENV = 'mobile_env_unsatisfied';

function log(msg) {
  console.error(`[ai-e2e3][mobile] ${msg}`);
}

function mobileRoot(projectRoot) {
  return path.join(projectRoot, 'src', 'mobile');
}

function mobileCfg(config, platform) {
  const ui = config?.ui_e2e?.mobile || {};
  const cmds = ui.commands || {};
  const plat = platform === 'ios' ? ui.ios || {} : ui.android || {};
  return {
    ui,
    plat,
    cmds,
    bootWaitS: typeof cmds.boot_wait_s === 'number' && cmds.boot_wait_s > 0 ? cmds.boot_wait_s : 90,
    smokeRunS: typeof cmds.smoke_run_s === 'number' && cmds.smoke_run_s > 0 ? cmds.smoke_run_s : 35,
    autoLaunch:
      platform === 'ios'
        ? plat.auto_launch_simulator !== false
        : plat.auto_launch_emulator !== false,
    installBefore: plat.install_before_test !== false,
    preferredId:
      platform === 'ios'
        ? String(plat.simulator || plat.device_id || '').trim()
        : String(plat.device_id || plat.emulator_id || '').trim(),
  };
}

function envBlocker(platform, detail) {
  return {
    ok: false,
    unresolvable: true,
    blocker: BLOCKER_ENV,
    error: `[不可解·环境不满足] ${platform}: ${detail}`,
  };
}

/**
 * @returns {Promise<object[]>}
 */
async function listFlutterDevicesMachine() {
  const r = await runWithTimeout('flutter', ['devices', '--machine'], { timeoutMs: 60000 });
  if (r.timedOut || r.code !== 0) return [];
  const raw = (r.stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 按平台筛选已连接设备（含真机 USB 与已启动的模拟器）。
 * 优先级：config 指定 id（若在线）→ 真机 → 已运行模拟器 → 任意候选。
 * @returns {{ id: string, kind: 'physical'|'emulator', name?: string } | null}
 */
function pickConnectedDevice(devices, platform, preferredId) {
  const want = platform === 'ios' ? 'ios' : 'android';
  const candidates = devices.filter((d) => {
    const tp = String(d.targetPlatform || '').toLowerCase();
    if (tp !== want) return false;
    return d.isSupported !== false;
  });

  if (preferredId) {
    const hit = candidates.find((d) => d.id === preferredId);
    if (hit) {
      return {
        id: hit.id,
        kind: hit.emulator ? 'emulator' : 'physical',
        name: hit.name,
      };
    }
  }

  const physical = candidates.filter((d) => d.emulator === false);
  if (physical.length) {
    return { id: physical[0].id, kind: 'physical', name: physical[0].name };
  }

  const emulators = candidates.filter((d) => d.emulator === true);
  if (emulators.length) {
    return { id: emulators[0].id, kind: 'emulator', name: emulators[0].name };
  }

  return null;
}

/** @deprecated 使用 pickConnectedDevice */
function pickRunningDevice(devices, platform, preferredId) {
  const picked = pickConnectedDevice(devices, platform, preferredId);
  return picked ? picked.id : null;
}

/**
 * @param {string} stdout flutter emulators
 * @param {'android'|'ios'} platform
 */
function parseEmulatorIds(stdout, platform) {
  const ids = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes('•')) continue;
    const lower = line.toLowerCase();
    if (platform === 'ios' && !lower.includes('ios')) continue;
    if (platform === 'android' && !lower.includes('android')) continue;
    const id = line.split('•')[0].trim();
    if (id && id.toLowerCase() !== 'id') ids.push(id);
  }
  return ids;
}

/**
 * @returns {Promise<{ ids: string[], flutterMissing?: boolean, listFailed?: boolean }>}
 */
async function listInstalledEmulatorIds(platform) {
  const ver = await runWithTimeout('flutter', ['--version'], { timeoutMs: 30000 });
  if (ver.timedOut || ver.code !== 0) {
    return { ids: [], flutterMissing: true };
  }
  const r = await runWithTimeout('flutter', ['emulators'], { timeoutMs: 60000 });
  if (r.timedOut || r.code !== 0) {
    return { ids: [], listFailed: true };
  }
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  return { ids: parseEmulatorIds(text, platform) };
}

async function launchEmulator(emulatorId) {
  log(`无已连接设备，启动模拟器: ${emulatorId}`);
  const r = await runWithTimeout('flutter', ['emulators', '--launch', emulatorId], {
    timeoutMs: 120000,
  });
  return !r.timedOut && r.code === 0;
}

async function waitForDevice(platform, preferredId, bootWaitS) {
  const deadline = Date.now() + bootWaitS * 1000;
  while (Date.now() < deadline) {
    const devices = await listFlutterDevicesMachine();
    const picked = pickConnectedDevice(devices, platform, preferredId);
    if (picked) return picked;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/**
 * @param {'android'|'ios'} platform
 * @param {object} config
 * @returns {Promise<{ ok: boolean, deviceId?: string, deviceKind?: string, error?: string, launched?: boolean, unresolvable?: boolean, blocker?: string }>}
 */
async function ensureMobileDevice(platform, config) {
  if (platform === 'ios' && process.platform !== 'darwin') {
    return envBlocker('ios', '真机/模拟器测试仅支持 macOS（Darwin）');
  }

  const mc = mobileCfg(config, platform);
  const devices = await listFlutterDevicesMachine();
  let picked = pickConnectedDevice(devices, platform, mc.preferredId);

  if (picked) {
    const label = picked.kind === 'physical' ? '真机/已连接设备' : '模拟器';
    log(`${platform} 使用${label}: ${picked.name || picked.id} (${picked.id})`);
    return {
      ok: true,
      deviceId: picked.id,
      deviceKind: picked.kind,
      launched: false,
    };
  }

  log(`${platform} 当前无可用连接设备（已检测真机与模拟器）`);

  if (!mc.autoLaunch) {
    return {
      ok: false,
      error: `无已连接的 ${platform} 设备，且 auto_launch_${platform === 'ios' ? 'simulator' : 'emulator'}=false；请连接真机或手动启动模拟器`,
    };
  }

  const emu = await listInstalledEmulatorIds(platform);
  if (emu.flutterMissing) {
    return envBlocker(platform, '未安装 Flutter SDK 或 flutter 不在 PATH');
  }

  if (emu.ids.length === 0) {
    const hint =
      platform === 'android'
        ? '请安装 Android Studio 并创建 AVD（Android Virtual Device），或 USB 连接真机后开启 USB 调试'
        : '请安装 Xcode 并安装 iOS Simulator（Xcode → Settings → Platforms），或 USB 连接真机并信任本机';
    return envBlocker(
      platform,
      `本机未安装任何 ${platform} 模拟器（flutter emulators 列表为空）。${hint}`
    );
  }

  const launchId =
    mc.preferredId && emu.ids.includes(mc.preferredId)
      ? mc.preferredId
      : emu.ids[0];

  const launched = await launchEmulator(launchId);
  if (!launched) {
    return envBlocker(
      platform,
      `flutter emulators --launch ${launchId} 失败；请在本机手动启动模拟器或连接真机`
    );
  }

  picked = await waitForDevice(platform, mc.preferredId, mc.bootWaitS);
  if (!picked) {
    return envBlocker(
      platform,
      `模拟器 ${launchId} 启动后 ${mc.bootWaitS}s 内仍无可用设备；请检查模拟器镜像或手动启动`
    );
  }

  log(`${platform} 模拟器已就绪: ${picked.name || picked.id}`);
  return {
    ok: true,
    deviceId: picked.id,
    deviceKind: picked.kind,
    launched: true,
  };
}

function artifactReady(mobileDir, platform, deviceKind) {
  if (platform === 'android') {
    return fs.existsSync(
      path.join(mobileDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk')
    );
  }
  if (deviceKind === 'physical') {
    return fs.existsSync(path.join(mobileDir, 'build', 'ios', 'iphoneos', 'Runner.app'));
  }
  return fs.existsSync(path.join(mobileDir, 'build', 'ios', 'iphonesimulator', 'Runner.app'));
}

async function ensureMobileBuild(mobileDir, platform, deviceKind) {
  if (artifactReady(mobileDir, platform, deviceKind)) return { ok: true };
  log(`${platform} 产物缺失（${deviceKind || 'emulator'}），执行 flutter build…`);
  let args;
  if (platform === 'android') {
    args = ['build', 'apk', '--debug'];
  } else if (deviceKind === 'physical') {
    args = ['build', 'ios', '--debug', '--no-codesign'];
  } else {
    args = ['build', 'ios', '--simulator'];
  }
  const r = await runWithTimeout('flutter', args, { cwd: mobileDir, timeoutMs: 600000 });
  if (r.timedOut) return { ok: false, error: 'flutter build 超时' };
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || 'flutter build failed').slice(0, 600) };
  }
  return { ok: true };
}

async function flutterInstall(mobileDir, deviceId) {
  log(`安装应用到设备 ${deviceId}`);
  const r = await runWithTimeout('flutter', ['install', '-d', deviceId], {
    cwd: mobileDir,
    timeoutMs: 300000,
  });
  if (r.timedOut) return { ok: false, error: 'flutter install 超时' };
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || 'flutter install failed').slice(0, 600) };
  }
  return { ok: true };
}

async function runIntegrationTests(mobileDir, deviceId) {
  const intDir = path.join(mobileDir, 'integration_test');
  if (!fs.existsSync(intDir)) return { ok: false, missing: true };
  log(`运行 integration_test @ ${deviceId}`);
  const r = await runWithTimeout('flutter', ['test', 'integration_test', '-d', deviceId], {
    cwd: mobileDir,
    timeoutMs: 600000,
  });
  if (r.timedOut) return { ok: false, error: 'flutter test integration_test 超时' };
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || 'flutter test failed').slice(0, 800) };
  }
  return { ok: true };
}

async function runSmokeLaunch(mobileDir, deviceId, smokeRunS) {
  log(`冒烟启动 app @ ${deviceId}（${smokeRunS}s）`);
  const r = await runWithTimeout(
    'flutter',
    ['run', '-d', deviceId, '--debug'],
    { cwd: mobileDir, timeoutMs: (smokeRunS + 60) * 1000 }
  );
  if (r.timedOut) {
    return { ok: true, note: 'smoke: flutter run 超时结束（视为已启动）' };
  }
  if (r.code !== 0 && !/Lost connection|Syncing files/.test(r.stderr || r.stdout || '')) {
    return { ok: false, error: (r.stderr || r.stdout || 'flutter run failed').slice(0, 800) };
  }
  return { ok: true };
}

/**
 * @param {string} projectRoot
 * @param {'android'|'ios'} platform
 * @param {object} config
 */
async function prepareMobileAndRun(projectRoot, platform, config) {
  const root = mobileRoot(projectRoot);
  if (!fs.existsSync(path.join(root, 'pubspec.yaml'))) {
    return { ok: false, error: '缺少 src/mobile/pubspec.yaml' };
  }

  const dev = await ensureMobileDevice(platform, config);
  if (!dev.ok) return dev;

  const mc = mobileCfg(config, platform);
  const build = await ensureMobileBuild(root, platform, dev.deviceKind);
  if (!build.ok) {
    return { ok: false, deviceId: dev.deviceId, error: build.error, unresolvable: dev.unresolvable };
  }

  if (mc.installBefore) {
    const inst = await flutterInstall(root, dev.deviceId);
    if (!inst.ok) return { ok: false, deviceId: dev.deviceId, error: inst.error };
  }

  const int = await runIntegrationTests(root, dev.deviceId);
  if (int.missing) {
    const smoke = await runSmokeLaunch(root, dev.deviceId, mc.smokeRunS);
    if (!smoke.ok) return { ok: false, deviceId: dev.deviceId, error: smoke.error };
    return {
      ok: true,
      deviceId: dev.deviceId,
      deviceKind: dev.deviceKind,
      mode: 'smoke_run',
    };
  }
  if (!int.ok) return { ok: false, deviceId: dev.deviceId, error: int.error };
  return {
    ok: true,
    deviceId: dev.deviceId,
    deviceKind: dev.deviceKind,
    mode: 'integration_test',
  };
}

async function ensureDevicesForScenarios(projectRoot, config, scenarios) {
  const platforms = new Set();
  for (const s of scenarios) {
    const p = String(s.platform || '').toLowerCase();
    if (p === 'android' || p === 'ios') platforms.add(p);
  }
  const out = {};
  for (const p of platforms) {
    out[p] = await ensureMobileDevice(p, config);
  }
  return out;
}

module.exports = {
  BLOCKER_ENV,
  ensureMobileDevice,
  ensureDevicesForScenarios,
  prepareMobileAndRun,
  listFlutterDevicesMachine,
  pickConnectedDevice,
  pickRunningDevice,
  parseEmulatorIds,
  listInstalledEmulatorIds,
};
