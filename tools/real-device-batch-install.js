'use strict';

/**
 * 批量安装 · 真机演练
 *
 * 用真实的 runInstallBatch（electron/install-batch.js）驱动真实的 adb，
 * 把「成功 / 失败 / 平台不符跳过 / 类型不支持跳过」四种行态一次跑全。
 *
 * 与 Electron 内运行的差别只有一处：这里自己拼 installOne，
 * 而 main.js 里是 installAppPackage。编排、进度换算、取消归一化、汇总都是同一份代码。
 *
 * 用法：
 *   node tools/real-device-batch-install.js              # 混合批次
 *   node tools/real-device-batch-install.js --cancel     # 额外演练「中途取消」
 *   node tools/real-device-batch-install.js --serial 60e0b399
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { createToolContext, createToolRunner } = require(path.join(ROOT, 'electron', 'tool-env'));
const { parsePackageInstallProgress } = require(path.join(ROOT, 'electron', 'ideviceinstaller'));
const {
  planInstallBatch,
  runInstallBatch,
  overallPercent,
  describeBatchResult
} = require(path.join(ROOT, 'electron', 'install-batch'));

const APK_DIR = '/Users/violet/Documents/other_dev/QA_AUTO/apks';
const DEFAULT_DEVICE = '60e0b399';

const args = process.argv.slice(2);
const WITH_CANCEL = args.includes('--cancel');
const serialIndex = args.indexOf('--serial');
const DEVICE_ID = serialIndex >= 0 ? args[serialIndex + 1] : DEFAULT_DEVICE;

const { resolveTool, runToolStream } = createToolRunner(createToolContext());

// ---------- 与 main.js 的 installAndroidPackage 保持一致 ----------
function outputLooksFailed(text) {
  return /Failure|error:|failed/i.test(text) && !/Success|Install: Complete|App installed/i.test(text);
}

async function installAndroidPackage(filePath, deviceId, onProgress, control) {
  onProgress?.({ percent: 8, stage: '开始安装 APK' });
  const adbArgs = deviceId
    ? ['-s', deviceId, 'install', '-r', filePath]
    : ['install', '-r', filePath];
  let latest = { percent: 8, stage: '正在安装 APK' };

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await runToolStream('adb', adbArgs, {
      timeout: 300000,
      onChild: (child) => { if (control) control.child = child; },
      onChunk: (_chunk, _stream, so, se) => {
        latest = parsePackageInstallProgress(`${so || ''}\n${se || ''}`, latest.percent);
        onProgress?.(latest);
      }
    }));
  } catch (error) {
    // 进程是我们自己 kill 掉的，adb 的报错没有意义
    if (control?.cancelled) {
      const cancelled = new Error('已取消安装');
      cancelled.cancelled = true;
      throw cancelled;
    }
    throw error;
  }

  const text = `${stdout || ''}\n${stderr || ''}`.trim();
  if (outputLooksFailed(text) || !/Success/i.test(text)) throw new Error(text || 'adb 安装失败');
  onProgress?.({ percent: 100, stage: '安装完成' });
  return { success: true, message: 'APK 安装成功' };
}

// ---------- 造批次 ----------
function buildFiles() {
  const real = fs.existsSync(APK_DIR)
    ? fs.readdirSync(APK_DIR).filter((n) => n.toLowerCase().endsWith('.apk')).sort()
    : [];
  const pick = (keyword) => {
    const name = real.find((n) => n.includes(keyword));
    return name ? path.join(APK_DIR, name) : null;
  };

  const small = pick('csfusion') || (real[0] ? path.join(APK_DIR, real[0]) : null);
  const mid = pick('wlxq2855') || (real[1] ? path.join(APK_DIR, real[1]) : null);

  const files = [];
  if (small) files.push(small);
  if (mid) files.push(mid);
  // 平台不符：目标是 Android，给一个 .ipa
  files.push(path.join(APK_DIR, '同批混入的 iOS 版本.ipa'));
  // 类型不支持
  files.push(path.join(APK_DIR, '安装说明.txt'));
  // 文件不存在 → 安装阶段失败
  files.push(path.join(APK_DIR, '不存在的包.apk'));
  return files;
}

function fmtDuration(ms) {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

async function main() {
  const adb = await resolveTool('adb');
  if (!adb || adb.installed === false) {
    console.error('未找到 adb，无法进行真机演练。');
    process.exit(1);
  }
  console.log(`adb: ${adb.path || adb.executable || '(PATH)'}`);
  console.log(`目标设备: ${DEVICE_ID}\n`);

  const files = buildFiles();
  const plan = planInstallBatch(files, 'android');

  console.log('=== 批次规划 ===');
  for (const item of plan.items) {
    const mark = item.status === 'skipped' ? '跳过' : '待装';
    console.log(`  [${mark}] ${item.name}  ${item.size_human}${item.reason ? `  ← ${item.reason}` : ''}`);
  }
  console.log(`  共 ${plan.total} 个：可安装 ${plan.installable_count}，跳过 ${plan.skipped_count}，去重丢弃 ${plan.duplicates_dropped}\n`);

  console.log('=== 串行安装 ===');
  const startedAt = Date.now();
  let lastLine = '';

  const outcome = await runInstallBatch(plan.items, {
    installOne: (item, onProgress, control) => installAndroidPackage(
      item.path, DEVICE_ID, onProgress, control
    ),
    onEvent: (event) => {
      if (event.phase === 'progress') {
        const line = `  ${String(event.percent).padStart(3)}%  第${event.index + 1}个 ${event.stage}`;
        if (line !== lastLine) { console.log(line); lastLine = line; }
        return;
      }
      if (event.phase === 'item') {
        const s = event.item.status;
        const tag = { pending: '待装', running: '安装中', success: '成功', failed: '失败', skipped: '跳过' }[s] || s;
        const extra = event.item.message || event.item.reason || '';
        console.log(`  [${tag}] ${event.item.name}${extra ? `  ← ${extra}` : ''}`);
      }
    }
  });

  console.log('\n=== 汇总 ===');
  console.log(`  ${describeBatchResult(outcome.summary)}`);
  console.log(`  耗时 ${fmtDuration(outcome.elapsed_ms)}（墙钟 ${fmtDuration(Date.now() - startedAt)}）`);
  console.log(`  取消: ${outcome.cancelled ? '是' : '否'}`);
  if (outcome.summary.failures.length) {
    console.log('  失败明细:');
    for (const f of outcome.summary.failures) console.log(`    · ${f.name}: ${f.message.split('\n')[0]}`);
  }

  // ---------- 可选：中途取消 ----------
  if (WITH_CANCEL) {
    const big = buildFiles().find((f) => f.includes('wlxq2855')) || buildFiles()[0];
    if (!big) {
      console.log('\n（没有可用于取消演练的包）');
      return;
    }
    console.log(`\n=== 取消演练：装 ${path.basename(big)} 的过程中打断 ===`);
    const cancelPlan = planInstallBatch([big], 'android');
    const control = { child: null, cancelled: false };
    let aborted = false;

    // 1.2 秒后模拟用户点「取消」：置标志 + kill 正在跑的 adb
    const timer = setTimeout(() => {
      aborted = true;
      control.cancelled = true;
      if (control.child && !control.child.killed) {
        console.log('  → 触发取消，kill 掉 adb 进程');
        control.child.kill();
      }
    }, 1200);

    const cancelOutcome = await runInstallBatch(cancelPlan.items, {
      installOne: (item, onProgress, c) => installAndroidPackage(item.path, DEVICE_ID, onProgress, c),
      onEvent: (event) => {
        if (event.phase === 'progress') return;
        const tag = { running: '安装中', success: '成功', failed: '失败', skipped: '跳过' }[event.item.status] || event.item.status;
        console.log(`  [${tag}] ${event.item.name}${event.item.reason ? `  ← ${event.item.reason}` : ''}`);
      },
      control,
      isAborted: () => aborted
    });
    clearTimeout(timer);

    console.log(`  ${describeBatchResult(cancelOutcome.summary)}`);
    console.log(`  取消: ${cancelOutcome.cancelled ? '是' : '否'}`);
    console.log(`  预期：cancelled=true，success=0，skipped=1（而不是 failed）`);
    const ok = cancelOutcome.cancelled && cancelOutcome.summary.skipped === 1 && cancelOutcome.summary.failed === 0;
    console.log(`  ${ok ? '✓ 取消归一化正确' : '✗ 取消归一化不符合预期'}`);
  }
}

main().catch((error) => {
  console.error('\n演练失败:', error?.message || error);
  process.exit(1);
});
