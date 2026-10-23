import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/build.yml', import.meta.url);
const backfillWorkflowUrl = new URL('../.github/workflows/backfill-macos-intel.yml', import.meta.url);

function jobBlock(workflow, jobName) {
  const jobsStart = workflow.indexOf('\njobs:');
  assert.notEqual(jobsStart, -1, '工作流应声明 jobs');
  const jobs = workflow.slice(jobsStart);
  const start = jobs.indexOf(`\n  ${jobName}:`);
  assert.notEqual(start, -1, `应存在 ${jobName} job`);
  const next = jobs.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next);
}

function namedStepBlock(job, stepName) {
  const marker = `      - name: ${stepName}`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `应存在步骤 ${stepName}`);
  const next = job.slice(start + marker.length).search(/\n      - name:/);
  return next === -1 ? job.slice(start) : job.slice(start, start + marker.length + next);
}

function runScriptFromStep(step) {
  const match = step.match(/\n        run: \|\n((?:          .*\n)+)/);
  assert.ok(match, '步骤应包含多行 run 脚本');
  return match[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

test('发布工作流构建并上传四个平台的正确产物', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const platforms = [
    ['build-macos-arm64', 'aarch64-apple-darwin', [
      'src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg',
    ]],
    ['build-macos-x64', 'x86_64-apple-darwin', [
      'src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/*.dmg',
    ]],
    ['build-windows-x64', 'x86_64-pc-windows-msvc', [
      'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe',
      'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi',
    ]],
    ['build-windows-arm64', 'aarch64-pc-windows-msvc', [
      'src-tauri/target/aarch64-pc-windows-msvc/release/bundle/nsis/*.exe',
      'src-tauri/target/aarch64-pc-windows-msvc/release/bundle/msi/*.msi',
    ]],
  ];

  for (const [jobName, target, artifactPaths] of platforms) {
    const job = jobBlock(workflow, jobName);
    assert.match(job, new RegExp(`needs: create-release`), `${jobName} 应依赖 release 初始化`);
    assert.ok(job.includes(target), `${jobName} 应使用 ${target}`);
    for (const artifactPath of artifactPaths) {
      assert.ok(job.includes(artifactPath), `${jobName} 应上传 ${artifactPath}`);
    }
    assert.match(job, /tag_name:\s*\$\{\{ github\.ref_name \}\}/, `${jobName} 应上传到当前 tag`);
  }

  const releaseJob = jobBlock(workflow, 'create-release');
  assert.match(releaseJob, /body_path:\s*RELEASE_NOTES\.md/);
  assert.equal((workflow.match(/body_path:\s*RELEASE_NOTES\.md/g) ?? []).length, 1,
    'Release 正文只由初始化 job 写入，平台 job 不应覆盖');
});

test('Intel Mac DMG 在 Intel runner 上构建、验签并拒绝缺失产物', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const job = jobBlock(workflow, 'build-macos-x64');

  assert.match(job, /runs-on:\s*macos-15-intel/);
  assert.match(job, /targets:\s*x86_64-apple-darwin/);
  assert.match(job, /key:\s*macos-x86_64/);
  assert.match(job, /pnpm install --frozen-lockfile/);
  assert.match(job, /pnpm tauri build --target x86_64-apple-darwin --ci/);
  assert.match(
    job,
    /lipo src-tauri\/target\/x86_64-apple-darwin\/release\/bundle\/macos\/Roster\.app\/Contents\/MacOS\/roster -verify_arch x86_64/,
    'lipo 应先接收二进制路径，再接收架构校验参数',
  );
  assert.match(job, /codesign --verify --deep --strict/);
  assert.match(job, /hdiutil verify src-tauri\/target\/x86_64-apple-darwin\/release\/bundle\/dmg\/\*\.dmg/);
  const upload = namedStepBlock(job, 'Upload Intel macOS artifact');
  assert.match(upload, /src-tauri\/target\/x86_64-apple-darwin\/release\/bundle\/dmg\/\*\.dmg/);
  assert.match(upload, /fail_on_unmatched_files:\s*true/);
  assert.match(upload, /tag_name:\s*\$\{\{ github\.ref_name \}\}/);
  assert.ok(
    job.indexOf('Verify Intel app and DMG') < job.indexOf('Upload Intel macOS artifact'),
    '上传前应完成 app 架构、签名和 DMG 校验',
  );
});

test('Intel 补包只使用已发布 tag 的固定源码，并只上传缺失的 Intel DMG', async () => {
  const workflow = await readFile(backfillWorkflowUrl, 'utf8');
  const job = jobBlock(workflow, 'backfill-intel');
  const source = namedStepBlock(job, 'Validate release and resolve original source');
  const validationScript = runScriptFromStep(source);
  const checkout = job.slice(job.indexOf('- uses: actions/checkout@v4'));
  const versions = namedStepBlock(job, 'Check source version against release tag');
  const upload = namedStepBlock(job, 'Upload missing Intel DMG only');

  assert.match(workflow, /workflow_dispatch:[\s\S]*release_tag:[\s\S]*required: true[\s\S]*type: string/);
  assert.match(job, /RELEASE_TAG:\s*\$\{\{ inputs\.release_tag \}\}/);
  assert.match(validationScript, /\[\[ "\$RELEASE_TAG" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/);
  assert.doesNotMatch(validationScript, /\$\{\{\s*inputs\.release_tag\s*\}\}/,
    '用户输入不能直接插入 shell 脚本');
  assert.match(validationScript, /gh release view "\$RELEASE_TAG"/);
  assert.match(validationScript, /isDraft,isPrerelease/);
  assert.match(validationScript, /Intel DMG already exists; refusing to overwrite/);
  assert.match(validationScript, /git ls-remote --tags/);
  assert.match(validationScript, /refs\/tags\/\$\{RELEASE_TAG\}\^\{\}/);
  assert.match(validationScript, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(checkout, /ref:\s*\$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(checkout, /persist-credentials:\s*false/,
    'checkout 回填源码后不应保留可写仓库凭据');
  assert.match(versions, /RELEASE_TAG\.slice\(1\)/);
  for (const versionSource of [
    "JSON.parse(fs.readFileSync('package.json', 'utf8')).version",
    "JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).version",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    assert.ok(versions.includes(versionSource), `版本校验应覆盖 ${versionSource}`);
  }
  assert.match(versions, /versions\.every\(version => version === expected\)/);
  assert.match(upload, /gh release upload "\$RELEASE_TAG" "src-tauri\/target\/x86_64-apple-darwin\/release\/bundle\/dmg\/Roster_\$\{RELEASE_TAG#v\}_x64\.dmg"/);
  assert.doesNotMatch(upload, /--clobber/);
  assert.doesNotMatch(workflow, /gh release (?:edit|create)|body_path:/);
  assert.equal((workflow.match(/gh release upload/g) ?? []).length, 1,
    '回填工作流只能上传一个 Intel DMG');
  assert.equal((workflow.match(/GH_TOKEN:/g) ?? []).length, 2,
    'GH_TOKEN 只应出现在 tag 校验和资产上传步骤');
  assert.match(source, /GH_TOKEN:/);
  assert.match(upload, /GH_TOKEN:/);
});

test('Intel 补包 tag 校验拒绝非法输入和已存在资产', { skip: process.platform === 'win32' }, async () => {
  const workflow = await readFile(backfillWorkflowUrl, 'utf8');
  const source = namedStepBlock(jobBlock(workflow, 'backfill-intel'), 'Validate release and resolve original source');
  const validationScript = runScriptFromStep(source);
  const mocks = [
    'gh() {',
    "  printf 'MOCK_GH_CALLED\\n' >&2",
    '  if [[ "$5" == "isDraft,isPrerelease" ]]; then',
    '    printf "%s\\n" "${MOCK_RELEASE_FLAGS:-false}"',
    '  elif [[ "$5" == "assets" ]]; then',
    '    printf "%s\\n" "${MOCK_ASSET:-}"',
    '  else',
    '    return 90',
    '  fi',
    '}',
    'git() {',
    "  printf 'MOCK_GIT_CALLED\\n' >&2",
    '  printf "%s refs/tags/%s\\n" "${MOCK_TAG_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" "$RELEASE_TAG"',
    '  printf "%s refs/tags/%s^{}\\n" "${MOCK_PEELED_SHA:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}" "$RELEASE_TAG"',
    '}',
  ].join('\n');
  const runValidation = (releaseTag, extraEnv = {}) => spawnSync(
    '/bin/bash',
    ['-c', `${mocks}\n${validationScript}`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_TAG: releaseTag,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_OUTPUT: '/dev/stdout',
        ...extraEnv,
      },
    },
  );

  const valid = runValidation('v1.9.5');
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/,
    '带注释 tag 应固定到解引用后的 commit SHA');

  const injection = runValidation('v1.9.5; echo INJECTED');
  assert.notEqual(injection.status, 0);
  assert.doesNotMatch(injection.stderr, /MOCK_GH_CALLED|MOCK_GIT_CALLED|INJECTED/);

  const prerelease = runValidation('v1.9.5', { MOCK_RELEASE_FLAGS: 'true' });
  assert.notEqual(prerelease.status, 0);
  assert.doesNotMatch(prerelease.stderr, /MOCK_GIT_CALLED/);

  const duplicate = runValidation('v1.9.5', {
    MOCK_ASSET: 'Roster_1.9.5_x64.dmg',
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Intel DMG already exists; refusing to overwrite/);
  assert.doesNotMatch(duplicate.stderr, /MOCK_GIT_CALLED/);
});
