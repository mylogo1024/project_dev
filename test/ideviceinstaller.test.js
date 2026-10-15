'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  runIdeviceinstaller,
  installArgSets,
  uninstallArgSets,
  listXmlArgSets,
  listArgSets,
  collectInstallOutput,
  stripSideloadWarnings,
  iosInstallSucceeded,
  parseInstalledBundleId,
  parsePackageInstallProgress,
  explainIosInstallError
} = require('../electron/ideviceinstaller');

test('prefers modern ideviceinstaller install PATH over legacy -i', async () => {
  const calls = [];
  const result = await runIdeviceinstaller(async (tool, args) => {
    calls.push(args);
    if (args.includes('-i')) throw new Error('should not fall back');
    return { stdout: 'Install: Complete\n' };
  }, installArgSets('UDID', '/tmp/app.ipa'));
  assert.equal(result.stdout.includes('Complete'), true);
  assert.deepEqual(calls[0], ['-u', 'UDID', 'install', '/tmp/app.ipa']);
  assert.equal(calls.length, 1);
});

test('falls back to legacy -i when modern install option is unknown', async () => {
  const calls = [];
  const result = await runIdeviceinstaller(async (tool, args) => {
    calls.push(args.slice());
    if (args.includes('install')) throw new Error('ideviceinstaller: invalid option -- install');
    return { stdout: 'Success\n' };
  }, installArgSets('UDID', '/tmp/app.ipa'));
  assert.equal(result.stdout.trim(), 'Success');
  assert.deepEqual(calls[0], ['-u', 'UDID', 'install', '/tmp/app.ipa']);
  assert.deepEqual(calls[1], ['-u', 'UDID', '-i', '/tmp/app.ipa']);
});

test('falls back list/uninstall commands the same way', async () => {
  assert.deepEqual(listXmlArgSets('A')[0], ['-u', 'A', 'list', '--xml']);
  assert.deepEqual(listArgSets('A')[0], ['-u', 'A', 'list']);
  assert.deepEqual(uninstallArgSets('A', 'com.foo')[0], ['-u', 'A', 'uninstall', 'com.foo']);
  assert.deepEqual(uninstallArgSets('A', 'com.foo')[1], ['-u', 'A', '-U', 'com.foo']);

  await assert.rejects(
    () => runIdeviceinstaller(async () => {
      throw new Error('device locked');
    }, listArgSets('A')),
    /device locked/
  );
});

test('sideload metadata warnings are not treated as the real install error', () => {
  const warnings = [
    'WARNING: could not locate iTunesMetadata.plist in archive!',
    'WARNING: could not locate Payload/xfhd.app/SC_Info/xfhd.sinf in archive!'
  ].join('\n');
  assert.equal(stripSideloadWarnings(warnings), '');
  assert.equal(iosInstallSucceeded(warnings), false);
  assert.match(explainIosInstallError(warnings), /不是失败原因/);

  assert.equal(
    iosInstallSucceeded(`${warnings}\nCopying '/tmp/a.ipa' to device... DONE.`),
    false
  );
  assert.equal(
    iosInstallSucceeded(`${warnings}\nCopying '/tmp/a.ipa' to device... DONE.\nInstall: Complete`),
    true
  );
  assert.match(
    explainIosInstallError(`${warnings}\nERROR: Install failed. Got error "ApplicationVerificationFailed"`),
    /签名校验/
  );

  const wrapped = new Error('ideviceinstaller 执行失败: WARNING: could not locate iTunesMetadata.plist in archive!');
  wrapped.cause = {
    stderr: warnings,
    stdout: "Copying '/tmp/a.ipa' to device... FAILED\n"
  };
  assert.match(collectInstallOutput(wrapped), /FAILED/);
});

test('only Install Complete counts as success, and progress maps copy vs install', () => {
  assert.equal(parseInstalledBundleId("Installing 'com.foo.bar'\n"), 'com.foo.bar');
  assert.equal(
    parsePackageInstallProgress("Copying '/tmp/a.ipa' to device... DONE.").percent,
    40
  );
  assert.equal(
    parsePackageInstallProgress("Install: ExtractingPackage (20%)", 40).percent >= 40,
    true
  );
  assert.equal(parsePackageInstallProgress('Install: Complete').percent, 100);
});
