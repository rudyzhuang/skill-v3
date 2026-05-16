'use strict';

const fs = require('fs');
const path = require('path');
const { runWithTimeout } = require('./run-with-timeout.cjs');

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

function pickRunningDevice(devices, platform, preferredId) {
  const want = platform === 'ios' ? 'ios' : 'android';
  const candidates = devices.filter((d) => {
    const tp = String(d.targetPlatform || '').toLowerCase();
    if (want === 'ios' && tp !== 'ios') return false;
    if (want === 'android' && tp !== 'android') return false;
    if (d.emulator === false && want === 'android') return false;
    return d.isSupported !== false;
  });
  if (preferredId) {
    const hit = candidates.find((d) => d.id === preferredId);
    if (hit) return hit.id;
  }
  const emu = candidates.find((d) => d.emulator === true);
  if (emu) return emu.id;
  if (candidates.length) return candidates[0].id;
  return null;
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

async function listEmulatorIds(platform) {
  const r = await runWithTimeout('flutter', ['emulators'], { timeoutMs: 60000 });
  if (r.timedOut || r.code !== 0) return [];
  return parseEmulatorIds(`${r.stdout || ''}\n${r.stderr || ''}`, platform);
}

async function launchEmulator(emulatorId) {
  log(`启动模拟器: ${emulatorId}`);
  const r = await runWithTimeout('flutter', ['emulators', '--launch', emulatorId], {
    timeoutMs: 120000,
  });
  return !r.timedOut && r.code === 0;
}

async function waitForDevice(platform, preferredId, bootWaitS) {
  const deadline = Date.now() + bootWaitS * 1000;
  while (Date.now() < deadline) {
    const devices = await listFlutterDevicesMachine();
    const id = pickRunningDevice(devices, platform, preferredId);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

/**
 * @param {'android'|'ios'} platform
 * @param {object} config
 * @returns {Promise<{ ok: boolean, deviceId?: string, error?: string, launched?: boolean }>}
 */
async function ensureMobileDevice(platform, config) {
  if (platform === 'ios' && process.platform !== 'darwin') {
    return { ok: false, error: 'ios 模拟器仅支持 macOS（Darwin）' };
  }

  const mc = mobileCfg(config, platform);
  let devices = await listFlutterDevicesMachine();
  let deviceId = pickRunningDevice(devices, platform, mc.preferredId);
  if (deviceId) {
    log(`${platform} 已就绪: ${deviceId}`);
    return { ok: true, deviceId, launched: false };
  }

  if (!mc.autoLaunch) {
    return {
      ok: false,
      error: `无运行中的 ${platform} 模拟器，且 auto_launch_${platform === 'ios' ? 'simulator' : 'emulator'}=false`,
    };
  }

  const emuIds = await listEmulatorIds(platform);
  const launchId =
    mc.preferredId && emuIds.includes(mc.preferredId)
      ? mc.preferredId
      : emuIds[0] || (platform === 'ios' ? 'apple_ios_simulator' : '');

  if (!launchId) {
    return { ok: false, error: `未找到可启动的 ${platform} 模拟器（flutter emulators 为空）` };
  }

  const launched = await launchEmulator(launchId);
  if (!launched) {
    return { ok: false, error: `flutter emulators --launch ${launchId} 失败` };
  }

  deviceId = await waitForDevice(platform, mc.preferredId, mc.bootWaitS);
  if (!deviceId) {
    return { ok: false, error: `${platform} 模拟器启动超时（${mc.bootWaitS}s）` };
  }
  log(`${platform} 启动完成: ${deviceId}`);
  return { ok: true, deviceId, launched: true };
}

function artifactReady(mobileDir, platform) {
  if (platform === 'android') {
    return fs.existsSync(
      path.join(mobileDir, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk')
    );
  }
  return fs.existsSync(path.join(mobileDir, 'build', 'ios', 'iphonesimulator', 'Runner.app'));
}

async function ensureMobileBuild(mobileDir, platform) {
  if (artifactReady(mobileDir, platform)) return { ok: true };
  log(`${platform} 产物缺失，执行 flutter build…`);
  const args =
    platform === 'android'
      ? ['build', 'apk', '--debug']
      : ['build', 'ios', '--simulator'];
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
 * 确保模拟器运行、构建产物存在、安装 app，并执行测试或冒烟。
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
  const build = await ensureMobileBuild(root, platform);
  if (!build.ok) return { ok: false, deviceId: dev.deviceId, error: build.error };

  if (mc.installBefore) {
    const inst = await flutterInstall(root, dev.deviceId);
    if (!inst.ok) return { ok: false, deviceId: dev.deviceId, error: inst.error };
  }

  const int = await runIntegrationTests(root, dev.deviceId);
  if (int.missing) {
    const smoke = await runSmokeLaunch(root, dev.deviceId, mc.smokeRunS);
    if (!smoke.ok) return { ok: false, deviceId: dev.deviceId, error: smoke.error };
    return { ok: true, deviceId: dev.deviceId, mode: 'smoke_run' };
  }
  if (!int.ok) return { ok: false, deviceId: dev.deviceId, error: int.error };
  return { ok: true, deviceId: dev.deviceId, mode: 'integration_test' };
}

/**
 * @param {string} projectRoot
 * @param {object} config
 * @param {object[]} scenarios
 */
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
  ensureMobileDevice,
  ensureDevicesForScenarios,
  prepareMobileAndRun,
  listFlutterDevicesMachine,
  pickRunningDevice,
  parseEmulatorIds,
};
