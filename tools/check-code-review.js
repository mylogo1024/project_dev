'use strict';

/**
 * 代码审核（阿里前端代码规约的零依赖落地版）。
 *
 * 为什么不是直接装 eslint-config-ali：本机安装新依赖被 broker 策略拦住了。
 * 于是把《阿里巴巴前端代码规约》里**适用于本项目、且能被静态可靠检出**的条目
 * 固化成这个脚本 —— 好处是零依赖、可随时跑、规则是显式的（不会因为升级插件而悄悄变）。
 *
 * 设计原则（吃过误报的亏，所以刻意保守）：
 *   1. **先剥离注释与字符串**，否则注释里写个 `var` 都会误报
 *   2. 每条规则只匹配「确定有问题」的形态，拿不准的不报
 *   3. 报错必须带 文件:行:列 与规则名，人能一眼判断真假
 *
 * 用法：node tools/check-code-review.js [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'electron', 'tools'];
const EXTENSIONS = new Set(['.js', '.jsx']);

// 这些文件本身就是检查器/脚手架，规则对它不适用
const IGNORED = new Set([
  path.join('tools', 'check-code-review.js')
]);

const SEVERITY = { error: 'error', warn: 'warn' };

/**
 * 把注释和字符串替换成等长空白，保留换行。
 * 这样后面所有规则都基于「代码骨架」匹配，行列号依然准确。
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // 行注释
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    // 块注释
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // 字符串 / 模板串
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === quote) { out += ' '; i += 1; break; }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    // 正则字面量：`/` 既可能是除号也可能是正则开头，这是 JS 的经典歧义。
    // 判据是**前一个非空白字符**能不能作为表达式的结尾：
    //   `= /re/`、`(/re/)`、`, /re/` → 正则
    //   `total / 2`、`a / b / c`    → 除法
    // 早先我用「前一个字符是空白就当正则」，结果 `a / b / c` 里的 `/ b /`
    // 被整个吃掉，代码骨架就错了（这条是测试抓出来的）。
    if (ch === '/') {
      const before = out.replace(/\s+$/, '').slice(-1);
      const canStartRegex = before === '' || /[=(,:;[!&|?{};+\-*%<>~^]/.test(before);
      if (canStartRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const c = source[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '\n') break;
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { closed = true; break; }
          j += 1;
        }
        if (closed) {
          out += ' '.repeat(j - i + 1);
          i = j + 1;
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const columnOf = (text, index) => index - text.lastIndexOf('\n', index - 1);

/** 规则表。每条规则返回 [{line, column, message}]。 */
const RULES = [
  {
    id: 'ali/no-var',
    severity: SEVERITY.error,
    desc: '阿里规约：用 let / const 代替 var',
    check(code) {
      const hits = [];
      for (const m of code.matchAll(/\bvar\s+[A-Za-z_$]/g)) {
        hits.push({ index: m.index, message: '使用了 var，应改为 let / const' });
      }
      return hits;
    }
  },
  {
    id: 'ali/no-loose-equal',
    severity: SEVERITY.error,
    desc: '阿里规约：必须使用 === / !==，避免隐式类型转换',
    check(code) {
      const hits = [];
      // 允许 `== null` / `!= null`（这是社区共识的例外，用于同时判 null 与 undefined）
      for (const m of code.matchAll(/([^=!<>])(==|!=)([^=])/g)) {
        const after = code.slice(m.index + m[0].length, m.index + m[0].length + 5);
        if (/^\s*null\b/.test(after)) continue;
        hits.push({ index: m.index, message: `使用了 ${m[2]}，应改为 ${m[2] === '==' ? '===' : '!=='}` });
      }
      return hits;
    }
  },
  {
    id: 'ali/no-eval',
    severity: SEVERITY.error,
    desc: '阿里规约：禁止使用 eval',
    check(code) {
      return [...code.matchAll(/\beval\s*\(/g)].map((m) => ({ index: m.index, message: '禁止使用 eval' }));
    }
  },
  {
    id: 'ali/no-new-function',
    severity: SEVERITY.error,
    desc: '阿里规约：禁止使用 new Function（等价于 eval）',
    check(code) {
      return [...code.matchAll(/new\s+Function\s*\(/g)].map((m) => ({ index: m.index, message: '禁止使用 new Function' }));
    }
  },
  {
    id: 'ali/no-with',
    severity: SEVERITY.error,
    desc: '阿里规约：禁止使用 with',
    check(code) {
      return [...code.matchAll(/\bwith\s*\(/g)].map((m) => ({ index: m.index, message: '禁止使用 with' }));
    }
  },
  {
    id: 'ali/no-extend-native',
    severity: SEVERITY.error,
    desc: '阿里规约：禁止修改内置对象原型',
    check(code) {
      const re = /\b(Array|Object|String|Number|Boolean|Function|Date|RegExp|Promise)\.prototype\s*[.[\w]*\s*=/g;
      return [...code.matchAll(re)].map((m) => ({ index: m.index, message: `禁止修改 ${m[1]}.prototype` }));
    }
  },
  {
    id: 'sec/no-document-write',
    severity: SEVERITY.error,
    desc: '安全：禁止 document.write',
    check(code) {
      return [...code.matchAll(/document\.write(?:ln)?\s*\(/g)].map((m) => ({ index: m.index, message: '禁止 document.write（可被注入）' }));
    }
  },
  {
    id: 'sec/no-innerhtml',
    severity: SEVERITY.error,
    desc: '安全：禁止直接写 innerHTML / dangerouslySetInnerHTML',
    check(code) {
      const hits = [];
      for (const m of code.matchAll(/\.innerHTML\s*=/g)) hits.push({ index: m.index, message: '直接赋值 innerHTML 有 XSS 风险' });
      for (const m of code.matchAll(/dangerouslySetInnerHTML/g)) hits.push({ index: m.index, message: 'dangerouslySetInnerHTML 有 XSS 风险' });
      return hits;
    }
  },
  {
    id: 'quality/no-empty-catch',
    severity: SEVERITY.warn,
    desc: '质量：空的 catch 会吞掉错误，至少要留一行注释说明为什么可以忽略',
    // 必须基于原文判断：注释已经被剥离过了，
    // 否则 `catch (_) { /* 忽略 */ }` 这种「写了原因」的会被误报成空 catch
    raw: true,
    check(source) {
      const hits = [];
      for (const m of source.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
        hits.push({ index: m.index, message: '空 catch：请写明为什么可以忽略' });
      }
      return hits;
    }
  },
  {
    id: 'quality/no-alert',
    severity: SEVERITY.error,
    desc: '质量：不要用阻塞式 alert（会卡住渲染进程、样式与应用脱节），改用 lib/toastStore',
    check(code) {
      return [...code.matchAll(/(?:^|[^.\w])alert\s*\(/gm)]
        .map((m) => ({ index: m.index, message: '阻塞式 alert，应改用 toastSuccess / toastError / toastWarning' }));
    }
  },
  {
    id: 'quality/no-debugger',
    severity: SEVERITY.error,
    desc: '质量：提交前必须移除 debugger',
    check(code) {
      return [...code.matchAll(/\bdebugger\b/g)].map((m) => ({ index: m.index, message: '残留 debugger' }));
    }
  },
  {
    id: 'quality/no-index-key',
    severity: SEVERITY.warn,
    desc: 'React：列表可能增删时不要用数组下标当 key（会导致状态错位）',
    // 只认「下标本身就是 key」这一种形态。
    // `key={row.id || i}` 里的 i 只是兜底，属于合理写法，不该报 —— 这条曾经误报过。
    check(code) {
      return [...code.matchAll(/key=\{\s*(?:index|i)\s*\}/g)]
        .map((m) => ({ index: m.index, message: '用数组下标作 key，列表增删时会导致复用错位' }));
    }
  },
  {
    id: 'quality/todo-needs-context',
    severity: SEVERITY.warn,
    desc: '质量：TODO / FIXME 要写清楚要做什么，不能只留一个标记',
    check(code) {
      return [...code.matchAll(/(?:\/\/|\/\*)\s*(TODO|FIXME)\s*(?:\*\/)?\s*$/gm)]
        .map((m) => ({ index: m.index, message: `${m[1]} 没有说明内容` }));
    }
  },
  {
    id: 'sec/no-hardcoded-password',
    severity: SEVERITY.warn,
    desc: '安全：默认口令不应硬编码在源码里',
    check(code) {
      return [...code.matchAll(/\bpassword\s*[:=]\s*['"][^'"]{1,12}['"]/g)]
        .map((m) => ({ index: m.index, message: '硬编码口令' }));
    }
  }
];

function walk(dir, out = []) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

/**
 * 行内豁免。
 *
 *   // code-review-allow <rule-id>        作用于「下一行」
 *   // code-review-allow-file <rule-id>   作用于整个文件
 *
 * 规则要能豁免，否则遇到「我知道有风险且已经处理过」的地方只能把规则关掉 —— 那更糟。
 * 豁免必须写明理由（注释本身就写在源码里，人 review 时看得见）。
 */
function collectSuppressions(source) {
  const lineAllow = new Map();
  const fileAllow = new Set();
  const lines = source.split('\n');

  lines.forEach((text, index) => {
    const fileMatch = /code-review-allow-file\s+([\w/-]+)/.exec(text);
    if (fileMatch) {
      fileAllow.add(fileMatch[1]);
      return;
    }
    const lineMatch = /code-review-allow\s+([\w/-]+)/.exec(text);
    if (!lineMatch) return;

    // 豁免作用于「注释结束后的下一行」。
    // 块注释可能跨多行，直接 +1 会偏 —— 必须先把注释剩余部分跳过去。
    let next = index + 1;
    if (text.includes('/*') && !text.includes('*/')) {
      while (next < lines.length && !lines[next].includes('*/')) next += 1;
      next += 1;
    }

    const target = next + 1; // 转成 1-based
    if (!lineAllow.has(target)) lineAllow.set(target, new Set());
    lineAllow.get(target).add(lineMatch[1]);
  });

  return { lineAllow, fileAllow };
}

function review() {
  const files = SCAN_DIRS.flatMap((dir) => walk(dir)).filter((rel) => !IGNORED.has(rel));
  const findings = [];

  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = stripCommentsAndStrings(source);
    const { lineAllow, fileAllow } = collectSuppressions(source);

    for (const rule of RULES) {
      if (fileAllow.has(rule.id)) continue;
      // raw 规则要看原文（注释有意义），其余基于剥离后的代码骨架
      const target = rule.raw ? source : code;
      for (const hit of rule.check(target, source)) {
        const line = lineOf(target, hit.index);
        if (lineAllow.get(line)?.has(rule.id)) continue;
        findings.push({
          file: rel,
          line,
          column: columnOf(target, hit.index),
          rule: rule.id,
          severity: rule.severity,
          message: hit.message
        });
      }
    }
  }

  return { files: files.length, findings };
}

function main() {
  const { files, findings } = review();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ files, findings }, null, 2));
    return;
  }

  const errors = findings.filter((item) => item.severity === SEVERITY.error);
  const warns = findings.filter((item) => item.severity === SEVERITY.warn);

  console.log(`阿里前端代码规约自检 —— 扫描 ${files} 个文件`);
  console.log('');

  const byRule = new Map();
  for (const item of findings) {
    if (!byRule.has(item.rule)) byRule.set(item.rule, []);
    byRule.get(item.rule).push(item);
  }

  for (const rule of RULES) {
    const list = byRule.get(rule.id) || [];
    if (!list.length) continue;
    console.log(`[${rule.severity === SEVERITY.error ? '错误' : '警告'}] ${rule.id} —— ${rule.desc}（${list.length} 处）`);
    for (const item of list.slice(0, 8)) {
      console.log(`    ${item.file}:${item.line}:${item.column}  ${item.message}`);
    }
    if (list.length > 8) console.log(`    …还有 ${list.length - 8} 处`);
    console.log('');
  }

  if (!findings.length) console.log('✓ 未发现问题');
  console.log(`合计：${errors.length} 个错误、${warns.length} 个警告`);

  process.exitCode = errors.length ? 1 : 0;
}

if (require.main === module) main();

module.exports = { RULES, collectSuppressions, review, stripCommentsAndStrings };
