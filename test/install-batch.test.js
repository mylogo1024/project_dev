'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PACKAGE_EXTENSIONS,
  ITEM_STATUS,
  CANCEL_REASON,
  classifyInstallFile,
  planInstallBatch,
  overallPercent,
  summarizeBatchResults,
  runInstallBatch,
  describeBatchResult
} = require('../electron/install-batch');

const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-batch-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) { /* 清理失败不影响断言 */ }
  }
});

// ==================================================================
// 文件分类
// ==================================================================

test('classifyInstallFile 按扩展名识别平台', () => {
  assert.equal(classifyInstallFile('/tmp/app.apk', { size: 0 }).platform, 'android');
  assert.equal(classifyInstallFile('/tmp/app.ipa', { size: 0 }).platform, 'ios');
  assert.equal(classifyInstallFile('/tmp/app.APK', { size: 0 }).platform, 'android');
  assert.equal(classifyInstallFile('/tmp/app.ipa', { size: 0 }).platform_label, 'iOS');
  assert.equal(classifyInstallFile('/tmp/app.apk', { size: 0 }).platform_label, 'Android');
});

test('classifyInstallFile 对不支持的类型给出 supported=false', () => {
  const zip = classifyInstallFile('/tmp/app.zip', { size: 0 });
  assert.equal(zip.supported, false);
  assert.equal(zip.platform, '');
  assert.equal(zip.platform_label, '未知');
  assert.equal(zip.ext, 'ZIP');

  const noExt = classifyInstallFile('/tmp/README', { size: 0 });
  assert.equal(noExt.supported, false);
  assert.equal(noExt.ext, '');
});

test('classifyInstallFile 保留文件名、路径与可读体积', () => {
  const info = classifyInstallFile('/a/b/我的应用.apk', { size: 1536 });
  assert.equal(info.name, '我的应用.apk');
  assert.equal(info.path, '/a/b/我的应用.apk');
  assert.equal(info.size, 1536);
  assert.equal(typeof info.size_human, 'string');
  assert.notEqual(info.size_human, '');
});

test('classifyInstallFile 在文件不存在时回退为 0 而不是抛错', () => {
  const info = classifyInstallFile('/definitely/not/here/app.apk');
  assert.equal(info.size, 0);
  assert.equal(info.supported, true);
});

test('classifyInstallFile 能真实 stat 磁盘上的文件', () => {
  const dir = tempDir();
  const file = path.join(dir, 'real.apk');
  fs.writeFileSync(file, Buffer.alloc(2048));
  const info = classifyInstallFile(file);
  assert.equal(info.size, 2048);
});

test('PACKAGE_EXTENSIONS 只声明 apk / ipa', () => {
  assert.deepEqual(Object.keys(PACKAGE_EXTENSIONS).sort(), ['.apk', '.ipa']);
});

// ==================================================================
// 批次规划
// ==================================================================

test('planInstallBatch 把同平台文件标记为可安装', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/two.apk'], 'android');
  assert.equal(plan.total, 2);
  assert.equal(plan.installable_count, 2);
  assert.equal(plan.skipped_count, 0);
  assert.equal(plan.duplicates_dropped, 0);
  assert.ok(plan.items.every((item) => item.status === ITEM_STATUS.PENDING));
  assert.ok(plan.items.every((item) => item.reason === ''));
});

test('planInstallBatch 把平台不符的文件标记为 skipped 并说明原因', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/two.ipa'], 'android');
  assert.equal(plan.total, 2);
  assert.equal(plan.installable_count, 1);
  assert.equal(plan.skipped_count, 1);

  const skipped = plan.items.find((item) => item.status === ITEM_STATUS.SKIPPED);
  assert.equal(skipped.name, 'two.ipa');
  assert.match(skipped.reason, /目标设备类型不符/);
  assert.match(skipped.reason, /Android/);
  assert.match(skipped.reason, /iOS/);
});

test('planInstallBatch 反向：目标是 iOS 时 apk 被跳过', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/two.ipa'], 'ios');
  assert.equal(plan.installable_count, 1);
  assert.equal(plan.items[0].status, ITEM_STATUS.SKIPPED);
  assert.equal(plan.items[1].status, ITEM_STATUS.PENDING);
});

test('planInstallBatch 跳过不支持的文件类型', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/notes.txt', '/a/pic.png'], 'android');
  assert.equal(plan.total, 3);
  assert.equal(plan.installable_count, 1);
  assert.equal(plan.skipped_count, 2);

  const txt = plan.items.find((item) => item.name === 'notes.txt');
  assert.equal(txt.status, ITEM_STATUS.SKIPPED);
  assert.match(txt.reason, /不支持的文件类型/);
  assert.match(txt.reason, /TXT/);
});

test('planInstallBatch 默认去重并统计丢弃数量', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/one.apk', '/a/two.apk'], 'android');
  assert.equal(plan.total, 2);
  assert.equal(plan.duplicates_dropped, 1);
  assert.deepEqual(plan.items.map((item) => item.name), ['one.apk', 'two.apk']);
});

test('planInstallBatch 可以用 dedupe:false 保留重复项', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/one.apk'], 'android', { dedupe: false });
  assert.equal(plan.total, 2);
  assert.equal(plan.duplicates_dropped, 0);
});

test('planInstallBatch 接受对象形式的条目并复用其中的 size', () => {
  const plan = planInstallBatch([{ path: '/a/one.apk', size: 4096 }], 'android');
  assert.equal(plan.items[0].size, 4096);
  assert.equal(plan.items[0].name, 'one.apk');
});

test('planInstallBatch 忽略空条目与非法输入', () => {
  assert.deepEqual(planInstallBatch(null, 'android').items, []);
  assert.deepEqual(planInstallBatch(undefined, 'android').items, []);
  assert.equal(planInstallBatch(['', null, undefined, '/a/one.apk'], 'android').total, 1);
  assert.equal(planInstallBatch([{}], 'android').total, 0);
});

test('planInstallBatch 不传目标平台时全部视为可安装', () => {
  const plan = planInstallBatch(['/a/one.apk', '/a/two.ipa'], '');
  assert.equal(plan.installable_count, 2);
  assert.equal(plan.skipped_count, 0);
});

// ==================================================================
// 进度换算
// ==================================================================

test('overallPercent 覆盖边界值', () => {
  assert.equal(overallPercent(0, 1, 0), 0);
  assert.equal(overallPercent(0, 1, 100), 100);
  assert.equal(overallPercent(0, 4, 0), 0);
  assert.equal(overallPercent(0, 4, 100), 25);
  assert.equal(overallPercent(1, 4, 0), 25);
  assert.equal(overallPercent(3, 4, 100), 100);
  assert.equal(overallPercent(1, 2, 50), 75);
});

test('overallPercent 结果始终落在 0~100 且为整数', () => {
  for (let index = 0; index < 5; index += 1) {
    for (const itemPercent of [-50, 0, 33, 99, 100, 250]) {
      const value = overallPercent(index, 5, itemPercent);
      assert.equal(Number.isInteger(value), true);
      assert.ok(value >= 0 && value <= 100, `越界: ${value}`);
    }
  }
});

test('overallPercent 对 total=0 或非法参数不产生 NaN', () => {
  assert.equal(overallPercent(0, 0, 0), 0);
  assert.equal(Number.isNaN(overallPercent(0, 0, 0)), false);
  assert.equal(Number.isNaN(overallPercent(undefined, undefined, undefined)), false);
});

test('overallPercent 单调不减', () => {
  let previous = -1;
  for (let index = 0; index < 3; index += 1) {
    for (const itemPercent of [0, 50, 100]) {
      const value = overallPercent(index, 3, itemPercent);
      assert.ok(value >= previous, `${value} < ${previous}`);
      previous = value;
    }
  }
});

// ==================================================================
// 结果汇总
// ==================================================================

test('summarizeBatchResults 统计各状态数量', () => {
  const summary = summarizeBatchResults([
    { name: 'a.apk', status: 'success' },
    { name: 'b.apk', status: 'success' },
    { name: 'c.apk', status: 'failed', message: 'INSTALL_FAILED_OLDER_SDK' },
    { name: 'd.ipa', status: 'skipped', reason: '与目标设备类型不符' },
    { name: 'e.apk', status: 'pending' }
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.success, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.running, 0);
});

test('summarizeBatchResults 收集失败明细', () => {
  const summary = summarizeBatchResults([
    { name: 'c.apk', status: 'failed', message: 'INSTALL_FAILED_OLDER_SDK' },
    { name: 'd.apk', status: 'failed' },
    { name: 'ok.apk', status: 'success' }
  ]);
  assert.equal(summary.failures.length, 2);
  assert.deepEqual(summary.failures[0], { name: 'c.apk', message: 'INSTALL_FAILED_OLDER_SDK' });
  // 没有 message 时退回 reason，再退回默认文案
  assert.equal(summary.failures[1].message, '安装失败');
});

test('summarizeBatchResults 对空输入返回全零', () => {
  const summary = summarizeBatchResults(null);
  assert.deepEqual(
    { ...summary, failures: summary.failures.length },
    { total: 0, success: 0, failed: 0, skipped: 0, pending: 0, running: 0, failures: 0 }
  );
});

test('summarizeBatchResults 统计 running 状态', () => {
  const summary = summarizeBatchResults([{ status: 'running' }, { status: 'pending' }]);
  assert.equal(summary.running, 1);
  assert.equal(summary.pending, 1);
});

// ==================================================================
// 文案
// ==================================================================

test('describeBatchResult 只列出非零的失败/跳过', () => {
  assert.equal(
    describeBatchResult({ total: 3, success: 3, failed: 0, skipped: 0 }),
    '共 3 个安装包：成功 3 个'
  );
  assert.equal(
    describeBatchResult({ total: 4, success: 2, failed: 1, skipped: 1 }),
    '共 4 个安装包：成功 2 个，失败 1 个，跳过 1 个'
  );
});

// ==================================================================
// 端到端：规划 → 执行 → 汇总
// ==================================================================

test('规划结果可以直接驱动一轮串行安装并汇总', async () => {
  const dir = tempDir();
  const files = ['one.apk', 'two.apk', 'three.ipa', 'notes.txt'];
  for (const name of files) fs.writeFileSync(path.join(dir, name), Buffer.alloc(16));

  const plan = planInstallBatch(files.map((name) => path.join(dir, name)), 'android');
  assert.equal(plan.total, 4);
  assert.equal(plan.installable_count, 2);
  assert.equal(plan.skipped_count, 2);

  const installed = [];
  const items = plan.items.map((item) => ({ ...item }));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.status !== ITEM_STATUS.PENDING) continue;
    item.status = ITEM_STATUS.RUNNING;
    installed.push(item.name);
    item.status = ITEM_STATUS.SUCCESS;
    // 进度在整批维度上单调递增，最后一个文件装完正好 100
    const percent = overallPercent(index, items.length, 100);
    assert.ok(percent > 0 && percent <= 100);
  }
  assert.deepEqual(installed, ['one.apk', 'two.apk']);

  const summary = summarizeBatchResults(items);
  assert.equal(summary.success, 2);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.failed, 0);
  assert.equal(describeBatchResult(summary), '共 4 个安装包：成功 2 个，跳过 2 个');
});

// ==================================================================
// 串行编排：runInstallBatch
// ==================================================================

/** 造一批「已规划好」的条目，等价于 planInstallBatch 的产出。 */
function planFor(names, targetPlatform = 'android') {
  const dir = tempDir();
  const paths = names.map((name) => {
    const full = path.join(dir, name);
    fs.writeFileSync(full, Buffer.alloc(8));
    return full;
  });
  return planInstallBatch(paths, targetPlatform);
}

test('runInstallBatch 全部成功时逐条推进并汇总', async () => {
  const plan = planFor(['a.apk', 'b.apk', 'c.apk']);
  const installed = [];

  const outcome = await runInstallBatch(plan.items, {
    installOne: async (item) => {
      installed.push(item.name);
      return { message: `${item.name} 装好了` };
    }
  });

  assert.deepEqual(installed, ['a.apk', 'b.apk', 'c.apk']);
  assert.equal(outcome.summary.success, 3);
  assert.equal(outcome.summary.failed, 0);
  assert.equal(outcome.summary.skipped, 0);
  assert.equal(outcome.cancelled, false);
  assert.equal(typeof outcome.elapsed_ms, 'number');
  assert.equal(plan.items[0].message, 'a.apk 装好了');
});

test('runInstallBatch 是串行的：上一个装完才开始下一个', async () => {
  const plan = planFor(['a.apk', 'b.apk']);
  const order = [];

  await runInstallBatch(plan.items, {
    installOne: async (item) => {
      order.push(`start:${item.name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${item.name}`);
    }
  });

  assert.deepEqual(order, ['start:a.apk', 'end:a.apk', 'start:b.apk', 'end:b.apk']);
});

test('runInstallBatch 单个失败不影响后续', async () => {
  const plan = planFor(['a.apk', 'b.apk', 'c.apk']);

  const outcome = await runInstallBatch(plan.items, {
    installOne: async (item) => {
      if (item.name === 'b.apk') throw new Error('INSTALL_FAILED_OLDER_SDK');
      return {};
    }
  });

  assert.equal(outcome.summary.success, 2);
  assert.equal(outcome.summary.failed, 1);
  assert.equal(plan.items[1].status, ITEM_STATUS.FAILED);
  assert.equal(plan.items[1].message, 'INSTALL_FAILED_OLDER_SDK');
  assert.equal(plan.items[2].status, ITEM_STATUS.SUCCESS);
  assert.equal(outcome.summary.failures.length, 1);
  assert.equal(outcome.summary.failures[0].name, 'b.apk');
});

test('runInstallBatch 预先把 skipped 项推出去，且不调用 installOne', async () => {
  const plan = planFor(['a.apk', 'b.ipa', 'c.apk']);
  assert.equal(plan.items[1].status, ITEM_STATUS.SKIPPED);

  const attempted = [];
  const events = [];

  await runInstallBatch(plan.items, {
    installOne: async (item) => { attempted.push(item.name); },
    onEvent: (e) => events.push(e)
  });

  assert.deepEqual(attempted, ['a.apk', 'c.apk']);
  const skippedIndex = events.findIndex((e) => e.item?.name === 'b.ipa');
  assert.ok(skippedIndex >= 0, '应有一条 b.ipa 的事件');
  assert.equal(events[skippedIndex].phase, 'item');
  // 被跳过的条目要在任何进度事件之前就推出去
  const firstProgress = events.findIndex((e) => e.phase === 'progress');
  assert.ok(firstProgress < 0 || skippedIndex < firstProgress);
});

test('runInstallBatch 开始前已取消：全部剩余项标为跳过', async () => {
  const plan = planFor(['a.apk', 'b.apk', 'c.apk']);
  const attempted = [];

  const outcome = await runInstallBatch(plan.items, {
    installOne: async (item) => { attempted.push(item.name); },
    isAborted: () => true
  });

  assert.deepEqual(attempted, [], '取消后不应再尝试安装');
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.summary.skipped, 3);
  assert.equal(outcome.summary.success, 0);
  assert.ok(plan.items.every((item) => item.reason === CANCEL_REASON));
});

test('runInstallBatch 中途取消：当前项与剩余项都标为跳过，已完成的不受影响', async () => {
  const plan = planFor(['a.apk', 'b.apk', 'c.apk']);
  const attempted = [];
  let aborted = false;

  const outcome = await runInstallBatch(plan.items, {
    installOne: async (item) => {
      attempted.push(item.name);
      if (item.name === 'b.apk') {
        // 模拟用户点了「取消」→ 主进程置 aborted 并 kill 子进程
        aborted = true;
        const error = new Error('adb 被终止');
        error.cancelled = true;
        throw error;
      }
      return {};
    },
    isAborted: () => aborted
  });

  assert.deepEqual(attempted, ['a.apk', 'b.apk'], '取消后不应再装 c.apk');
  assert.equal(plan.items[0].status, ITEM_STATUS.SUCCESS);
  assert.equal(plan.items[1].status, ITEM_STATUS.SKIPPED);
  assert.equal(plan.items[1].reason, CANCEL_REASON);
  assert.equal(plan.items[2].status, ITEM_STATUS.SKIPPED);
  assert.equal(plan.items[2].reason, CANCEL_REASON);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.summary.success, 1);
  assert.equal(outcome.summary.skipped, 2);
  assert.equal(outcome.summary.failed, 0, '取消不应被算成失败');
});

test('runInstallBatch 把安装内的阶段进度换算成整批百分比', async () => {
  const plan = planFor(['a.apk', 'b.apk']);
  const percents = [];

  await runInstallBatch(plan.items, {
    installOne: async (item, onProgress) => {
      onProgress({ percent: 30, stage: '正在安装' });
      onProgress({ percent: 100, stage: '安装完成' });
    },
    onEvent: (e) => {
      if (typeof e.percent === 'number') percents.push(e.percent);
    }
  });

  assert.ok(percents.length > 0);
  for (let i = 1; i < percents.length; i += 1) {
    assert.ok(percents[i] >= percents[i - 1], `${percents[i]} 小于 ${percents[i - 1]}`);
  }
  assert.equal(percents[percents.length - 1], 100, '整批结束应到 100');
  assert.ok(percents.includes(15), '第 1 个包跑到 30% 时整批应为 15%');
});

test('runInstallBatch 把 control 交给 installOne，并在每个包开始前重置', async () => {
  const plan = planFor(['a.apk', 'b.apk']);
  const seen = [];

  await runInstallBatch(plan.items, {
    installOne: async (item, onProgress, control) => {
      seen.push({ name: item.name, cancelled: control.cancelled, child: control.child });
      control.child = { fake: item.name };
      control.cancelled = true;
      return {};
    },
    isAborted: () => false
  });

  assert.equal(seen.length, 2);
  // 第二个包开始时，上一个包留下的状态必须被清掉
  assert.equal(seen[1].cancelled, false);
  assert.equal(seen[1].child, null);
});

test('runInstallBatch 对空列表返回零汇总', async () => {
  const outcome = await runInstallBatch([], { installOne: async () => {} });
  assert.equal(outcome.total, 0);
  assert.equal(outcome.summary.total, 0);
  assert.equal(outcome.cancelled, false);
});

test('runInstallBatch 缺少 installOne 时明确报错', async () => {
  await assert.rejects(() => runInstallBatch([], {}), /installOne/);
});

test('runInstallBatch 的进度按「可安装条目」算，不被跳过的条目拉出跳跃', async () => {
  // 5 条里只有 3 条要装：如果按全部 5 条算，进度会是 0 → 20 → 40 → 80 → 100
  // （中间从 40 直接跳到 80，看起来像卡住）。按可安装的 3 条算才是 0 → 33 → 67 → 100。
  const plan = planFor(['a.apk', 'b.apk', 'c.ipa', 'd.txt', 'e.apk']);
  assert.equal(plan.installable_count, 3);
  assert.equal(plan.skipped_count, 2);

  const marks = [];
  await runInstallBatch(plan.items, {
    installOne: async () => {},
    onEvent: (e) => {
      if (e.phase === 'item' && e.item.status === 'running') marks.push(e.percent);
    }
  });

  assert.deepEqual(marks, [0, 33, 67], `实际 ${marks.join(', ')}`);
});

test('runInstallBatch 全部条目都被跳过时进度不产生 NaN', async () => {
  const plan = planFor(['a.ipa', 'b.txt']);
  assert.equal(plan.installable_count, 0);

  const percents = [];
  const outcome = await runInstallBatch(plan.items, {
    installOne: async () => { throw new Error('不该被调用'); },
    onEvent: (e) => { if (typeof e.percent === 'number') percents.push(e.percent); }
  });

  assert.equal(outcome.summary.skipped, 2);
  assert.ok(percents.every((p) => Number.isFinite(p)), '不应出现 NaN');
});

test('runInstallBatch 的失败明细与 describeBatchResult 文案一致', async () => {
  const plan = planFor(['a.apk', 'b.ipa', 'c.apk']);
  const outcome = await runInstallBatch(plan.items, {
    installOne: async (item) => {
      if (item.name === 'c.apk') throw new Error('安装被拒绝');
    }
  });
  assert.equal(outcome.summary.success, 1);
  assert.equal(outcome.summary.failed, 1);
  assert.equal(outcome.summary.skipped, 1);
  assert.equal(describeBatchResult(outcome.summary), '共 3 个安装包：成功 1 个，失败 1 个，跳过 1 个');
});
