'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RANDOM_ALPHABETS,
  WORD_BANK,
  applyRules,
  ensureUniqueTargets,
  parseFilename,
  joinFilename,
  randomChars,
  randomDate,
  randomUuid,
  randomWords
} = require('../src/lib/batchRenameEngine');
const { collectFiles, applyRenames, undoRenames } = require('../electron/batch-rename');

test('replace, sequence and case compose in order', () => {
  const files = [
    { path: '/a/Photo 01.JPG', dir: '/a', name: 'Photo 01.JPG', parentName: 'a', size: 1, mtime: 0 },
    { path: '/a/Photo 02.JPG', dir: '/a', name: 'Photo 02.JPG', parentName: 'a', size: 1, mtime: 0 }
  ];
  const preview = applyRules(files, [
    { type: 'replace', enabled: true, find: 'Photo', replace: 'IMG', all: true },
    { type: 'case', enabled: true, mode: 'lower' },
    { type: 'sequence', enabled: true, start: 1, step: 1, pad: 3, position: 'prefix', separator: '_' }
  ]);
  assert.equal(preview[0].preview, '001_img 01.JPG');
  assert.equal(preview[1].preview, '002_img 02.JPG');
});

test('truncate, insert, regex and custom template', () => {
  const files = [{ path: '/a/hello_world.txt', dir: '/a', name: 'hello_world.txt', parentName: 'docs', mtime: Date.parse('2026-09-16') }];
  const preview = applyRules(files, [
    { type: 'truncate', enabled: true, mode: 'keep-start', n: 5 },
    { type: 'insert', enabled: true, text: 'X', position: 'prefix' },
    { type: 'regex', enabled: true, pattern: 'Xhe', replace: 'He', flags: 'g' },
    { type: 'custom', enabled: true, template: '%parent%_%name%_%n%', start: 1, pad: 2 }
  ]);
  assert.equal(preview[0].preview, 'docs_hello_world_01.txt');
});

test('joinFilename strips illegal characters', () => {
  assert.equal(joinFilename('a:b', 't*xt'), 'a_b.t_xt');
  assert.equal(parseFilename('a.b.c').stem, 'a.b');
});

test('collect files from folder and rename with undo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-rename-'));
  const a = path.join(dir, 'one.txt');
  const b = path.join(dir, 'two.txt');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const collected = collectFiles([dir], { recursive: false });
  assert.equal(collected.length, 2);
  const renamed = await applyRenames([
    { from: a, to: path.join(dir, 'alpha.txt') }
  ]);
  assert.equal(renamed[0].status, 'renamed');
  assert.equal(fs.existsSync(path.join(dir, 'alpha.txt')), true);
  await undoRenames(renamed.filter((item) => item.status === 'renamed'));
  assert.equal(fs.existsSync(a), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
