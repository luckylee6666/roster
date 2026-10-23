import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/build.yml', import.meta.url);

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
  assert.match(job, /lipo -verify_arch x86_64/);
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
