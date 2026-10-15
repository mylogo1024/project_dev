'use strict';

/**
 * 批量安装的纯逻辑部分
 *
 * 与设备交互的部分（adb / ideviceinstaller）留在 main.js，这里只放
 * 「能单测、且容易出错」的部分：文件分类、批次规划、进度换算、结果汇总。
 */

const fs = require('fs');
const path = require('path');

const { formatBytes } = require('./pkginfo/util');

/** 安装包扩展名 → 目标平台。 */
const PACKAGE_EXTENSIONS = {
  '.apk': 'android',
  '.ipa': 'ios'
};

const PLATFORM_LABELS = {
  android: 'Android',
  ios: 'iOS'
};

/** 一个文件的安装状态。 */
const ITEM_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

/**
 * 识别单个文件：类型、平台、体积。
 * @param {string} filePath
 * @param {{size?: number}} [stat] 已知的文件信息（避免重复 stat）
 */
function classifyInstallFile(filePath, stat) {
  const name = path.basename(String(filePath || ''));
  const ext = path.extname(name).toLowerCase();
  const platform = PACKAGE_EXTENSIONS[ext] || '';

  let size = Number(stat?.size);
  if (!Number.isFinite(size)) {
    try {
      size = fs.statSync(filePath).size;
    } catch (_) {
      size = 0;
    }
  }

  return {
    path: filePath,
    name,
    ext: ext.replace(/^\./, '').toUpperCase(),
    platform,
    platform_label: PLATFORM_LABELS[platform] || '未知',
    supported: Boolean(platform),
    size,
    size_human: formatBytes(size)
  };
}

/**
 * 规划一批安装任务。
 *
 * 目标设备只能是 Android 或 iOS，因此与目标平台不符的文件会被标记为
 * `skipped` 并给出原因 —— 而不是等到 adb 报错才让用户去猜。
 *
 * @param {Array<string|{path: string, size?: number}>} files
 * @param {string} targetPlatform 'android' | 'ios'
 * @param {{dedupe?: boolean}} [options]
 */
function planInstallBatch(files, targetPlatform, options = {}) {
  const { dedupe = true } = options;
  const seen = new Set();
  const items = [];
  let duplicates = 0;

  for (const entry of Array.isArray(files) ? files : []) {
    const filePath = typeof entry === 'string' ? entry : entry?.path;
    if (!filePath) continue;
    if (dedupe) {
      if (seen.has(filePath)) {
        duplicates += 1;
        continue;
      }
      seen.add(filePath);
    }

    const info = classifyInstallFile(filePath, typeof entry === 'object' ? entry : undefined);

    let status = ITEM_STATUS.PENDING;
    let reason = '';
    if (!info.supported) {
      status = ITEM_STATUS.SKIPPED;
      reason = `不支持的文件类型（.${info.ext || '无扩展名'}），仅支持 APK / IPA`;
    } else if (targetPlatform && info.platform !== targetPlatform) {
      status = ITEM_STATUS.SKIPPED;
      reason = `与目标设备类型不符：目标是 ${PLATFORM_LABELS[targetPlatform] || targetPlatform}，文件是 ${info.platform_label}`;
    }

    items.push({ ...info, status, reason });
  }

  return {
    items,
    total: items.length,
    installable_count: items.filter((item) => item.status === ITEM_STATUS.PENDING).length,
    skipped_count: items.filter((item) => item.status === ITEM_STATUS.SKIPPED).length,
    duplicates_dropped: duplicates
  };
}

/**
 * 把「第 index 个文件的 itemPercent%」换算成整批的总体进度。
 *
 * @param {number} index 从 0 开始的序号
 * @param {number} total 总数
 * @param {number} itemPercent 当前文件内部进度 0~100
 */
function overallPercent(index, total, itemPercent = 0) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeIndex = Math.max(0, Math.min(safeTotal - 1, Number(index) || 0));
  const safeItem = Math.max(0, Math.min(100, Number(itemPercent) || 0));
  return Math.max(0, Math.min(100, Math.round(((safeIndex + safeItem / 100) / safeTotal) * 100)));
}

/** 汇总一轮批量安装的结果。 */
function summarizeBatchResults(items) {
  const list = Array.isArray(items) ? items : [];
  const count = (status) => list.filter((item) => item.status === status).length;
  return {
    total: list.length,
    success: count(ITEM_STATUS.SUCCESS),
    failed: count(ITEM_STATUS.FAILED),
    skipped: count(ITEM_STATUS.SKIPPED),
    pending: count(ITEM_STATUS.PENDING),
    running: count(ITEM_STATUS.RUNNING),
    failures: list
      .filter((item) => item.status === ITEM_STATUS.FAILED)
      .map((item) => ({ name: item.name, message: item.message || item.reason || '安装失败' }))
  };
}

/** 用户取消时，剩余任务统一的跳过原因。 */
const CANCEL_REASON = '用户取消了批量安装';

/**
 * 串行跑完一批安装任务。
 *
 * 这里只做编排：顺序、整批进度换算、取消归一化、汇总。
 * 真正的安装动作由 `installOne` 注入，因此既能接 adb / ideviceinstaller，
 * 也能在单测和真机演练里换成别的实现。
 *
 * @param {Array} items planInstallBatch() 产出的条目（会被就地更新状态）
 * @param {object} options
 * @param {(item, onProgress, control) => Promise} options.installOne 单个安装
 * @param {(event: object) => void} [options.onEvent] 每次状态变化回调（对应 IPC 推送）
 * @param {{child: any, cancelled: boolean}} [options.control] 取消控制块
 * @param {() => boolean} [options.isAborted] 是否已被要求取消
 */
async function runInstallBatch(items, options = {}) {
  const {
    installOne,
    onEvent = () => {},
    control = { child: null, cancelled: false },
    isAborted = () => Boolean(control.cancelled)
  } = options;

  if (typeof installOne !== 'function') throw new Error('runInstallBatch 需要 installOne 回调');

  const startedAt = Date.now();
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const emit = (data) => onEvent({ ...data, total, elapsed_ms: Date.now() - startedAt });

  // 进度只按「真正要装的」条目算。若按全部条目算，被跳过的那些会在列表里
  // 留下空洞，进度条就会从 40% 直接跳到 80% —— 看起来像卡了一下。
  const installable = list.filter((item) => item.status !== ITEM_STATUS.SKIPPED);
  const progressTotal = installable.length || 1;
  const progressIndex = new Map(installable.map((item, i) => [item, i]));
  const progressOf = (item, itemPercent) => overallPercent(
    progressIndex.has(item) ? progressIndex.get(item) : 0,
    progressTotal,
    itemPercent
  );

  // 先把「跳过」的项一次性报出去，前端表格立刻能看到原因
  for (let index = 0; index < total; index += 1) {
    if (list[index].status !== ITEM_STATUS.SKIPPED) continue;
    emit({ phase: 'item', index, item: { ...list[index] }, percent: 0 });
  }

  const skipRest = (from) => {
    for (let rest = from; rest < total; rest += 1) {
      if (list[rest].status !== ITEM_STATUS.PENDING) continue;
      list[rest].status = ITEM_STATUS.SKIPPED;
      list[rest].reason = CANCEL_REASON;
      emit({ phase: 'item', index: rest, item: { ...list[rest] }, percent: 0 });
    }
  };

  for (let index = 0; index < total; index += 1) {
    const item = list[index];
    if (item.status === ITEM_STATUS.SKIPPED) continue;

    if (isAborted()) {
      skipRest(index);
      break;
    }

    item.status = ITEM_STATUS.RUNNING;
    emit({
      phase: 'item',
      index,
      item: { ...item },
      percent: progressOf(item, 0),
      stage: `正在安装 ${item.name}（${index + 1}/${total}）`
    });

    // 每个包开始前重置控制块，避免上一个包的取消状态串到下一个
    control.child = null;
    control.cancelled = false;

    try {
      const result = await installOne(item, (progress) => emit({
        phase: 'progress',
        index,
        item: { ...item },
        item_percent: progress?.percent ?? null,
        percent: progressOf(item, progress?.percent || 0),
        stage: `${item.name} · ${progress?.stage || '安装中'}`
      }), control);
      item.status = ITEM_STATUS.SUCCESS;
      item.message = result?.message || '安装成功';
    } catch (error) {
      // 取消时正在跑的进程会被 kill，报错内容没有意义，统一归一化
      if (isAborted() || error?.cancelled) {
        item.status = ITEM_STATUS.SKIPPED;
        item.reason = CANCEL_REASON;
      } else {
        item.status = ITEM_STATUS.FAILED;
        item.message = error?.message || '安装失败';
      }
    }

    emit({
      phase: 'item',
      index,
      item: { ...item },
      percent: progressOf(item, 100),
      stage: item.status === ITEM_STATUS.SUCCESS
        ? `已完成 ${item.name}`
        : `${item.name} · ${item.message || item.reason || '安装失败'}`
    });

    if (isAborted()) {
      skipRest(index + 1);
      break;
    }
  }

  const summary = summarizeBatchResults(list);
  return {
    items: list,
    total,
    cancelled: isAborted(),
    summary,
    elapsed_ms: Date.now() - startedAt
  };
}

/** 生成一句人话总结，用于提示条。 */
function describeBatchResult(summary) {
  const parts = [`成功 ${summary.success} 个`];
  if (summary.failed) parts.push(`失败 ${summary.failed} 个`);
  if (summary.skipped) parts.push(`跳过 ${summary.skipped} 个`);
  return `共 ${summary.total} 个安装包：${parts.join('，')}`;
}

module.exports = {
  PACKAGE_EXTENSIONS,
  PLATFORM_LABELS,
  ITEM_STATUS,
  CANCEL_REASON,
  classifyInstallFile,
  planInstallBatch,
  overallPercent,
  summarizeBatchResults,
  runInstallBatch,
  describeBatchResult
};
