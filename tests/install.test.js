import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, chmod, realpath } from 'node:fs/promises';
import { prepareProject, npmCliCandidates, runtimeTarget } from '../scripts/install.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'boss install 空格 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { playwright: '1.63.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { playwright: '1.63.0' } }, 'node_modules/playwright': { version: '1.63.0' } } }));
  return root;
}
async function installed(root, version = '1.63.0') {
  await mkdir(path.join(root, 'node_modules/playwright'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/playwright/package.json'), JSON.stringify({ version }));
}

test('first setup installs locked dependencies using the selected Node and npm CLI, then the next launch skips installation', async t => {
  const root = await fixture(t);
  const calls = [];
  const options = { root, nodePath: process.execPath, npmCli: '/fixture/npm-cli.js', run: async (...args) => { calls.push(args); await installed(root); } };
  assert.equal((await prepareProject(options)).installed, true);
  assert.equal((await prepareProject(options)).installed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ['/fixture/npm-cli.js', 'ci', '--no-audit', '--no-fund']);
  assert.equal(calls[0][2].cwd, root);
  assert.equal(calls[0][2].env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, '1');
  assert.equal(calls[0][2].timeout, 180_000);
  assert.equal(JSON.parse(await readFile(path.join(root, '.runtime/dependencies.json'), 'utf8')).schema, 1);
});

test('an updated lock file invalidates the install marker even when old packages remain present', async t => {
  const root = await fixture(t); let installs = 0;
  const options = { root, npmCli: '/fixture/npm-cli.js', run: async () => { installs++; await installed(root); } };
  await prepareProject(options);
  await writeFile(path.join(root, 'package-lock.json'), (await readFile(path.join(root, 'package-lock.json'), 'utf8')) + '\n');
  await prepareProject(options);
  assert.equal(installs, 2);
});

test('missing installed packages invalidate an otherwise matching marker', async t => {
  const root = await fixture(t); let installs = 0;
  const options = { root, npmCli: '/fixture/npm-cli.js', run: async () => { installs++; await installed(root); } };
  await prepareProject(options); await rm(path.join(root, 'node_modules'), { recursive: true });
  await prepareProject(options); assert.equal(installs, 2);
});

test('failed npm installation does not create a successful marker or touch user data', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'data')); await writeFile(path.join(root, 'data/config.json'), 'private settings');
  await assert.rejects(prepareProject({ root, npmCli: '/fixture/npm-cli.js', run: async () => { throw new Error('network failed'); } }), /network failed/);
  await assert.rejects(readFile(path.join(root, '.runtime/dependencies.json')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'data/config.json'), 'utf8'), 'private settings');
});

test('a npm success exit with incomplete packages never stamps the installation as ready', async t => {
  const root = await fixture(t);
  await assert.rejects(prepareProject({ root, npmCli: '/fixture/npm-cli.js', run: async () => {} }), /依赖.*完整|安装.*完整/);
  await assert.rejects(readFile(path.join(root, '.runtime/dependencies.json')), { code: 'ENOENT' });
});

test('project runtime symlinks are rejected before any installation or write', async t => {
  if (process.platform === 'win32') { t.skip('Windows fixture symlink privilege is not required for normal setup'); return; }
  const root = await fixture(t); const outside = await mkdtemp(path.join(tmpdir(), 'boss outside '));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.runtime'));
  let calls = 0;
  await assert.rejects(prepareProject({ root, npmCli: '/fixture/npm-cli.js', run: async () => { calls++; } }), /符号链接|普通目录/);
  assert.equal(calls, 0);
  await assert.rejects(readFile(path.join(outside, 'dependencies.json')), { code: 'ENOENT' });
});

test('node_modules symlinks are rejected rather than overwriting files outside the project', async t => {
  if (process.platform === 'win32') { t.skip('Windows fixture symlink privilege is not required for normal setup'); return; }
  const root = await fixture(t); const outside = await mkdtemp(path.join(tmpdir(), 'boss modules '));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, 'node_modules'));
  await assert.rejects(prepareProject({ root, npmCli: '/fixture/npm-cli.js', run: async () => { throw new Error('must not run'); } }), /符号链接|普通目录/);
});

test('lockfiles that disagree with package.json are rejected before installing', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { playwright: '1.0.0' } }));
  await assert.rejects(prepareProject({ root, npmCli: '/fixture/npm-cli.js', run: async () => { throw new Error('must not run'); } }), /锁定|lock/);
});

test('npm CLI candidates remain literal paths with spaces and use project-local portable layouts', () => {
  assert.ok(npmCliCandidates('/Project Space/.runtime/node/bin/node', { PATH: '' }, 'linux').includes('/Project Space/.runtime/node/lib/node_modules/npm/bin/npm-cli.js'));
  assert.ok(npmCliCandidates('C:\\Project Space\\.runtime\\node\\node.exe', { PATH: '' }, 'win32').includes('C:\\Project Space\\.runtime\\node\\node_modules\\npm\\bin\\npm-cli.js'));
});

for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
  test(`official portable Node archive supports ${platform}/${arch}`, () => {
    const target = runtimeTarget(platform, arch);
    assert.match(target.url, /^https:\/\/nodejs\.org\/dist\/v22\.23\.3\/node-v22\.23\.3-/);
    assert.match(target.sha256, /^[a-f0-9]{64}$/);
    assert.equal(target.extension, platform === 'win32' ? 'zip' : 'tar.gz');
  });
}
test('unsupported Node platforms and architectures fail before download', () => {
  for (const args of [['freebsd', 'x64'], ['linux', 'ia32'], ['darwin', 'mips']]) assert.throws(() => runtimeTarget(...args), /不支持/);
});

test('a transitive package missing after npm success prevents a ready marker', async t => {
  const root = await fixture(t);
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/playwright-core'] = { version: '1.63.0' };
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(prepareProject({ root, npmCli: '/fixture/npm-cli.js', run: async () => installed(root) }), /依赖.*完整|安装.*完整/);
  await assert.rejects(readFile(path.join(root, '.runtime/dependencies.json')), { code: 'ENOENT' });
});

test('concurrent first launches cannot run two npm ci processes against the same project', async t => {
  const root = await fixture(t);
  let resolveEntered, release;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const options = { root, npmCli: '/fixture/npm-cli.js', run: async () => { if (++calls > 1) throw new Error('duplicate npm install'); resolveEntered(); await paused; await installed(root); } };
  const first = prepareProject(options);
  await entered;
  try { await assert.rejects(prepareProject(options), /安装.*运行|安装.*进行/); }
  finally { release(); await first; }
  assert.equal(calls, 1);
  assert.equal((await prepareProject(options)).installed, false);
});

async function shellFixture(t, { wrongHash = false, platform = 'Darwin', arch = 'arm64' } = {}) {
  const root = await fixture(t), bins = path.join(root, 'fake bins');
  await mkdir(bins); await mkdir(path.join(root, 'scripts'));
  await copyFile(path.join(import.meta.dirname, '../scripts/install-node.sh'), path.join(root, 'scripts/install-node.sh'));
  for (const [name, text] of Object.entries({
    node: '#!/bin/sh\nexit 1\n', npm: '#!/bin/sh\nexit 0\n',
    uname: `#!/bin/sh\nif [ "$1" = -s ]; then printf '%s\\n' '${platform}'; else printf '%s\\n' '${arch}'; fi\n`,
    curl: '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; dest=$1; fi; shift; done\ncp "$FIXTURE_ARCHIVE" "$dest"\nprintf download >> "$FIXTURE_DOWNLOAD_LOG"\n',
  })) { await writeFile(path.join(bins, name), text); await chmod(path.join(bins, name), 0o755); }
  const tree = path.join(root, 'archive tree'), folder = path.join(tree, 'node-v22.23.3-darwin-arm64');
  await mkdir(path.join(folder, 'bin'), { recursive: true }); await mkdir(path.join(folder, 'lib/node_modules/npm/bin'), { recursive: true });
  await writeFile(path.join(folder, 'bin/node'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(folder, 'bin/node'), 0o755);
  await writeFile(path.join(folder, 'lib/node_modules/npm/bin/npm-cli.js'), 'fixture');
  const archive = path.join(root, 'official fixture.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', tree, path.basename(folder)], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const hash = wrongHash ? '0'.repeat(64) : createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(path.join(root, 'scripts/install-node-checksums.txt'), `${hash}  node-v22.23.3-darwin-arm64.tar.gz\n`);
  const env = { ...process.env, PATH: `${bins}:/usr/bin:/bin`, FIXTURE_ARCHIVE: archive, FIXTURE_DOWNLOAD_LOG: path.join(root, 'download.log') };
  return { root, env, run: () => spawnSync('/bin/sh', [path.join(root, 'scripts/install-node.sh')], { env, encoding: 'utf8', timeout: 20_000 }) };
}

test('portable shell setup verifies its archive, installs only in a project path with spaces, and reuses it without downloading again', async t => {
  if (process.platform === 'win32') { t.skip('POSIX bootstrap is covered on macOS and Linux CI'); return; }
  const fixture = await shellFixture(t);
  const first = fixture.run(); assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), path.join(await realpath(fixture.root), '.runtime/node/bin/node'));
  const second = fixture.run(); assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(path.join(fixture.root, 'download.log'), 'utf8'), 'download');
  await assert.rejects(readFile(path.join(fixture.root, 'data/config.json')), { code: 'ENOENT' });
});

test('portable shell setup refuses a checksum mismatch before extracting or executing Node', async t => {
  if (process.platform === 'win32') { t.skip('POSIX bootstrap is covered on macOS and Linux CI'); return; }
  const fixture = await shellFixture(t, { wrongHash: true });
  const result = fixture.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /SHA-256|校验/);
  await assert.rejects(readFile(path.join(fixture.root, '.runtime/node/bin/node')), { code: 'ENOENT' });
});

test('unsupported POSIX bootstrap architectures stop before any download', async t => {
  if (process.platform === 'win32') { t.skip('POSIX bootstrap is covered on macOS and Linux CI'); return; }
  const fixture = await shellFixture(t, { arch: 'riscv64' });
  const result = fixture.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /不支持/);
  await assert.rejects(readFile(path.join(fixture.root, 'download.log')), { code: 'ENOENT' });
});

test('portable shell setup does not overwrite an existing incomplete runtime', async t => {
  if (process.platform === 'win32') { t.skip('POSIX bootstrap is covered on macOS and Linux CI'); return; }
  const fixture = await shellFixture(t);
  await mkdir(path.join(fixture.root, '.runtime/node'), { recursive: true }); await writeFile(path.join(fixture.root, '.runtime/node/keep.txt'), 'keep');
  const result = fixture.run(); assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(fixture.root, '.runtime/node/keep.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(path.join(fixture.root, 'download.log')), { code: 'ENOENT' });
});

test('install and launch entrypoints preserve a project path and arguments with spaces without accessing user data', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'scripts'));
  const names = process.platform === 'win32' ? ['start.cmd', 'install.cmd'] : ['start.sh', 'install.sh'];
  for (const name of names) await copyFile(path.join(import.meta.dirname, '..', name), path.join(root, name));
  if (process.platform === 'win32') {
    await writeFile(path.join(root, 'scripts/install-node.ps1'), 'Write-Output $env:FIXTURE_NODE\n');
  } else {
    await writeFile(path.join(root, 'scripts/install-node.sh'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_NODE"\n');
  }
  await writeFile(path.join(root, 'scripts/install.js'), 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n');
  const env = { ...process.env, FIXTURE_NODE: process.execPath };
  const argument = 'argument with spaces 中文 & literal';
  const run = name => process.platform === 'win32'
    // The /c command already uses cmd.exe quoting. Node's default Windows
    // argument escaping is for executable argv and would escape these quotes
    // again, so cmd.exe never reaches the actual batch file.
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.join(root, name)}" "${argument}" --no-autorun"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 15_000 })
    : spawnSync('/bin/sh', [path.join(root, name), argument, '--no-autorun'], { env, encoding: 'utf8', timeout: 15_000 });
  for (const name of names) {
    const result = run(name);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(await realpath(observed.cwd), await realpath(root));
    assert.deepEqual(observed.args, name.startsWith('install.') ? ['--open-chrome-download', argument, '--no-autorun'] : [argument, '--no-autorun']);
  }
  await assert.rejects(readFile(path.join(root, 'data/config.json')), { code: 'ENOENT' });
});
