import { createHash } from 'node:crypto';
import { execFile as exec_file } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { local_git_adapter, type git_command_runner, type git_publish_result } from '../src/lib/studio_git';

const exec_file_async = promisify(exec_file);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec_file_async('git', args, { cwd })).stdout.trim();

const make_repository = async (): Promise<{ root: string; remote: string; adapter: local_git_adapter }> => {
  const root = await mkdtemp(join(tmpdir(), 'studio-git-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const working = join(root, 'working');
  await git(root, 'init', '--bare', remote);
  await git(root, 'clone', remote, working);
  await git(working, 'config', 'user.email', 'test@example.com');
  await git(working, 'config', 'user.name', 'Studio Test');
  await git(working, 'checkout', '-b', 'main');
  await mkdir(join(working, 'src/content/writing'), { recursive: true });
  await writeFile(join(working, 'README.md'), 'seed\n');
  await git(working, 'add', '--', 'README.md');
  await git(working, 'commit', '-m', 'seed');
  await git(working, 'push', 'origin', 'main');
  return { root: working, remote, adapter: new local_git_adapter({ repository_root: working, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing' }) };
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('local_git_adapter', () => {
  it('preserves article modes despite restrictive umask', async () => {
    const { root, adapter } = await make_repository(); const original_umask = process.umask(0o077);
    try {
      const existing = join(root, 'src/content/writing/mode.md'); await writeFile(existing, 'old'); await chmod(existing, 0o664); await git(root, 'add', '--', 'src/content/writing/mode.md'); await git(root, 'commit', '-m', 'mode');
      await expect(adapter.publish({ operation: 'publish_update', slug: 'mode', source: new Uint8Array([110, 101, 119]), expected_source_hash: sha256(await readFile(existing)), commit_message: 'Update mode' })).resolves.toMatchObject({ ok: true }); expect((await stat(existing)).mode & 0o777).toBe(0o664);
      await expect(adapter.publish({ operation: 'publish_new', slug: 'new-mode', source: new Uint8Array([110]), commit_message: 'New mode' })).resolves.toMatchObject({ ok: true }); expect((await stat(join(root, 'src/content/writing/new-mode.md'))).mode & 0o777).toBe(0o644);
    } finally { process.umask(original_umask); }
  });
  it('rejects unknown operations before mutating repository state', async () => {
    const { root, adapter } = await make_repository(); const before = await git(root, 'rev-parse', 'HEAD');
    await expect(adapter.publish({ operation: 'unknown' as unknown as 'publish_new', slug: 'bad', source: new Uint8Array([1]), commit_message: 'Bad operation' })).resolves.toMatchObject({ ok: false, code: 'validation' });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before); expect(await git(root, 'status', '--porcelain')).toBe('');
  });
  it('publishes a new article, commits exactly that path, and pushes it', async () => {
    const { root, adapter } = await make_repository();
    const source = new TextEncoder().encode('title: New\r\n\r\nbody\r\n');
    const result = await adapter.publish({ operation: 'publish_new', slug: 'new-post', source, commit_message: 'Publish new post' });
    expect(result).toMatchObject({ ok: true, path: 'src/content/writing/new-post.md', push_status: 'pushed' });
    expect(await readFile(join(root, 'src/content/writing/new-post.md'))).toEqual(Buffer.from(source));
    expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('src/content/writing/new-post.md');
  });

  it('updates only with the matching exact-byte SHA-256 and preserves unrelated index/worktree state', async () => {
    const { root, adapter } = await make_repository();
    const target = join(root, 'src/content/writing/post.md');
    await writeFile(target, 'old\r\n'); await git(root, 'add', '--', 'src/content/writing/post.md'); await git(root, 'commit', '-m', 'old');
    await writeFile(join(root, 'README.md'), 'changed\n'); await writeFile(join(root, 'untracked.txt'), 'keep\n'); await git(root, 'add', '--', 'README.md');
    const old = await readFile(target);
    const updated = new TextEncoder().encode('new\r\n');
    const result = await adapter.publish({ operation: 'publish_update', slug: 'post', source: updated, expected_source_hash: sha256(old), commit_message: 'Update post' });
    expect(result).toMatchObject({ ok: true, push_status: 'pushed' });
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('README.md');
    expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('keep\n');
    await expect(adapter.publish({ operation: 'publish_update', slug: 'post', source: updated, expected_source_hash: '0'.repeat(64), commit_message: 'Update post' })).resolves.toMatchObject({ ok: false, code: 'stale_source' });
  });

  it('rejects wrong article existence, unsafe paths, dirty target, and repository operations', async () => {
    const { root, adapter } = await make_repository();
    await writeFile(join(root, 'src/content/writing/existing.md'), 'x');
    await expect(adapter.publish({ operation: 'publish_new', slug: 'existing', source: new Uint8Array([1]), commit_message: 'Publish existing' })).resolves.toMatchObject({ ok: false, code: 'article_exists' });
    await expect(adapter.publish({ operation: 'publish_update', slug: 'missing', source: new Uint8Array([1]), expected_source_hash: '0'.repeat(64), commit_message: 'Update missing' })).resolves.toMatchObject({ ok: false, code: 'article_missing' });
    await writeFile(join(root, 'src/content/writing/existing.md'), 'dirty');
    await expect(adapter.publish({ operation: 'publish_update', slug: 'existing', source: new Uint8Array([1]), expected_source_hash: sha256(new TextEncoder().encode('dirty')), commit_message: 'Update existing' })).resolves.toMatchObject({ ok: false, code: 'target_dirty' });
    for (const slug of ['../x', '%2e%2e', 'a\\b', '/x', 'a%2fb']) await expect(adapter.publish({ operation: 'publish_new', slug, source: new Uint8Array([1]), commit_message: 'Publish safe' })).resolves.toMatchObject({ ok: false, code: 'validation' });
    await mkdir(join(root, '.git', 'rebase-merge')); await expect(adapter.publish({ operation: 'publish_new', slug: 'blocked', source: new Uint8Array([1]), commit_message: 'Publish blocked' })).resolves.toMatchObject({ ok: false, code: 'repository_busy' });
  });

  it('never follows a target symlink and validates branch/message tokens', async () => {
    const { root, adapter } = await make_repository();
    const outside = join(root, 'outside.md'); await writeFile(outside, 'safe');
    await symlink(outside, join(root, 'src/content/writing/link.md'));
    await expect(adapter.publish({ operation: 'publish_new', slug: 'link', source: new Uint8Array([1]), commit_message: 'Publish link' })).resolves.toMatchObject({ ok: false, code: 'unsafe_path' });
    await expect(adapter.publish({ operation: 'publish_new', slug: 'message', source: new Uint8Array([1]), commit_message: '-bad\nmessage' })).resolves.toMatchObject({ ok: false, code: 'validation' });
    await git(root, 'checkout', '--detach');
    await expect(adapter.publish({ operation: 'publish_new', slug: 'detached', source: new Uint8Array([1]), commit_message: 'Publish detached' })).resolves.toMatchObject({ ok: false, code: 'wrong_branch' });
  });

  it('keeps the local commit and reports recovery guidance when a non-fast-forward push fails', async () => {
    const { root, remote, adapter } = await make_repository();
    const other = join(root, '..', 'other'); await git(root, 'clone', remote, other); await git(other, 'config', 'user.email', 'test@example.com'); await git(other, 'config', 'user.name', 'Other'); await git(other, 'checkout', 'main'); await writeFile(join(other, 'other.md'), 'other'); await git(other, 'add', '--', 'other.md'); await git(other, 'commit', '-m', 'other'); await git(other, 'push', 'origin', 'main');
    const result: git_publish_result = await adapter.publish({ operation: 'publish_new', slug: 'local', source: new Uint8Array([1]), commit_message: 'Publish local' });
    expect(result).toMatchObject({ ok: false, code: 'push_failed', committed_paths: ['src/content/writing/local.md'] });
    if (!result.ok && result.code === 'push_failed') expect(result.recovery).toMatch(/fetch|resolve|push/i);
    expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('src/content/writing/local.md');
  });

  it('serializes separate adapters for one repository and reports generic rejected pushes without source content', async () => {
    const { root, remote } = await make_repository();
    let active_adds = 0;
    let maximum_adds = 0;
    const runner: git_command_runner = async (file, args, cwd) => {
      if (args[0] === 'push') throw new Error('remote rejected secret article content');
      if (args[0] === 'add') { active_adds += 1; maximum_adds = Math.max(maximum_adds, active_adds); await new Promise<void>((resolve_delay) => setTimeout(resolve_delay, 30)); active_adds -= 1; }
      const output = await exec_file_async(file, [...args], { cwd });
      return { stdout: output.stdout, stderr: output.stderr };
    };
    const first = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing', command_runner: runner });
    const second = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing', command_runner: runner });
    const source = new TextEncoder().encode('private article body');
    const [one, two] = await Promise.all([first.publish({ operation: 'publish_new', slug: 'one', source, commit_message: 'Publish one' }), second.publish({ operation: 'publish_new', slug: 'two', source, commit_message: 'Publish two' })]);
    expect(maximum_adds).toBe(1);
    for (const result of [one, two]) {
      expect(result).toMatchObject({ ok: false, code: 'push_failed' });
      if (!result.ok && result.code === 'push_failed') expect(result.message).not.toContain('private article body');
    }
    expect(await git(root, 'log', '--format=%s', '-2')).toContain('Publish one');
    expect(source).toEqual(new TextEncoder().encode('private article body'));
  });

  it('rejects every Git operation marker through Git paths and invalid branch/remote configuration', async () => {
    const { root } = await make_repository();
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'rebase-merge']) {
      const marker_path = await git(root, 'rev-parse', '--git-path', marker);
      await mkdir(marker.includes('rebase') ? join(root, marker_path) : dirname(join(root, marker_path)), { recursive: true });
      if (!marker.includes('rebase')) await writeFile(join(root, marker_path), 'x');
      const adapter = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing' });
      await expect(adapter.publish({ operation: 'publish_new', slug: `marker-${marker.toLowerCase().replaceAll('_', '-')}`, source: new Uint8Array([1]), commit_message: 'Publish marker' })).resolves.toMatchObject({ ok: false, code: 'repository_busy' });
      await rm(join(root, marker_path), { recursive: true, force: true });
    }
    const invalid_configurations: ReadonlyArray<readonly [string, string]> = [['foo//bar', 'origin'], ['foo/', 'origin'], ['foo.', 'origin'], ['foo/.bar', 'origin'], ['foo.lock', 'origin'], ['main', 'origin.lock'], ['-main', 'origin']];
    for (const [publication_branch, remote_name] of invalid_configurations) {
      const adapter = new local_git_adapter({ repository_root: root, publication_branch, remote_name, writing_directory: 'src/content/writing' });
      await expect(adapter.publish({ operation: 'publish_new', slug: 'invalid-config', source: new Uint8Array([1]), commit_message: 'Publish config' })).resolves.toMatchObject({ ok: false, code: 'validation' });
    }
  });

  it('rejects top-level mismatch and every unsafe writing-directory configuration', async () => {
    const { root } = await make_repository();
    await mkdir(join(root, 'nested'));
    const nested = new local_git_adapter({ repository_root: join(root, 'nested'), publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing' });
    await expect(nested.publish({ operation: 'publish_new', slug: 'x', source: new Uint8Array([1]), commit_message: 'Publish x' })).resolves.toMatchObject({ ok: false, code: 'unsafe_path' });
    for (const writing_directory of ['../src/content/writing', '/tmp/writing', 'src\\content\\writing']) {
      const adapter = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory });
      await expect(adapter.publish({ operation: 'publish_new', slug: 'safe', source: new Uint8Array([1]), commit_message: 'Publish safe' })).resolves.toMatchObject({ ok: false, code: 'validation' });
    }
    const outside = join(root, 'outside'); await mkdir(outside); await rm(join(root, 'src/content/writing'), { recursive: true }); await symlink(outside, join(root, 'src/content/writing'));
    const escaped = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing' });
    await expect(escaped.publish({ operation: 'publish_new', slug: 'safe', source: new Uint8Array([1]), commit_message: 'Publish safe' })).resolves.toMatchObject({ ok: false, code: 'unsafe_path' });
  });

  it('detects common-dir markers in a real linked worktree and real unmerged index entries', async () => {
    const { root } = await make_repository();
    const linked = join(root, '..', 'linked'); await git(root, 'worktree', 'add', '-b', 'linked-branch', linked);
    const marker = await git(linked, 'rev-parse', '--git-path', 'MERGE_HEAD'); const marker_file = marker.startsWith('/') ? marker : join(linked, marker); await mkdir(dirname(marker_file), { recursive: true }); await writeFile(marker_file, 'x');
    const linked_adapter = new local_git_adapter({ repository_root: linked, publication_branch: 'linked-branch', remote_name: 'origin', writing_directory: 'src/content/writing' });
    await expect(linked_adapter.publish({ operation: 'publish_new', slug: 'linked', source: new Uint8Array([1]), commit_message: 'Publish linked' })).resolves.toMatchObject({ ok: false, code: 'repository_busy' });
    await rm(marker_file);
    await writeFile(join(root, 'src/content/writing/conflict.md'), 'base\n'); await git(root, 'add', '--', 'src/content/writing/conflict.md'); await git(root, 'commit', '-m', 'conflict base');
    await git(root, 'checkout', '-b', 'conflict-side'); await writeFile(join(root, 'src/content/writing/conflict.md'), 'side\n'); await git(root, 'commit', '-am', 'side'); await git(root, 'checkout', 'main'); await writeFile(join(root, 'src/content/writing/conflict.md'), 'main\n'); await git(root, 'commit', '-am', 'main');
    await exec_file_async('git', ['merge', 'conflict-side'], { cwd: root }).catch(() => undefined);
    const merge_marker = await git(root, 'rev-parse', '--git-path', 'MERGE_HEAD'); await rm(merge_marker.startsWith('/') ? merge_marker : join(root, merge_marker));
    expect(await git(root, 'ls-files', '-u')).not.toBe('');
    const adapter = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing' });
    await expect(adapter.publish({ operation: 'publish_new', slug: 'conflict', source: new Uint8Array([1]), commit_message: 'Publish conflict' })).resolves.toMatchObject({ ok: false, code: 'repository_busy' });
    expect(await git(root, 'ls-files', '-u')).not.toBe('');
  });

  it('detects a hook-mutated committed blob and snapshots caller bytes before delayed commands', async () => {
    const { root, remote } = await make_repository();
    const hook = join(root, '.git/hooks/pre-commit'); await writeFile(hook, '#!/bin/sh\nprintf changed > src/content/writing/hooked.md\ngit add -- src/content/writing/hooked.md\n'); await (await import('node:fs/promises')).chmod(hook, 0o755);
    const adapter = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing' }); const before = await git(root, 'rev-parse', 'HEAD'); const remote_before = await git(remote, 'rev-parse', 'main');
    await expect(adapter.publish({ operation: 'publish_new', slug: 'hooked', source: new TextEncoder().encode('original'), commit_message: 'Publish hooked' })).resolves.toMatchObject({ ok: false, code: 'integrity_failed' });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before); expect(await git(remote, 'rev-parse', 'main')).toBe(remote_before); expect(await git(root, 'status', '--porcelain', '--', 'src/content/writing/hooked.md')).not.toBe('');
    await expect(adapter.publish({ operation: 'publish_update', slug: 'hooked', source: new TextEncoder().encode('retry'), expected_source_hash: '0'.repeat(64), commit_message: 'Retry hooked' })).resolves.toMatchObject({ ok: false, code: 'target_dirty' }); expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
    await rm(hook);
    let delayed = false;
    const runner: git_command_runner = async (file, args, cwd) => { if (args[0] === 'rev-parse' && !delayed) { delayed = true; await new Promise<void>((resolve_delay) => setTimeout(resolve_delay, 25)); } const output = await exec_file_async(file, [...args], { cwd }); return { stdout: output.stdout, stderr: output.stderr }; };
    const snap_adapter = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing', command_runner: runner });
    const source = new Uint8Array(new TextEncoder().encode('snapshot'));
    const pending = snap_adapter.publish({ operation: 'publish_new', slug: 'snapshot', source, commit_message: 'Publish snapshot' }); source.fill(120);
    await expect(pending).resolves.toMatchObject({ ok: true }); expect(await readFile(join(root, 'src/content/writing/snapshot.md'), 'utf8')).toBe('snapshot');
  });

  it('preserves unrelated unstaged, staged, and untracked state while committing only target', async () => {
    const { root, adapter } = await make_repository();
    await writeFile(join(root, 'README.md'), 'unstaged\n'); await writeFile(join(root, 'staged.md'), 'staged\n'); await writeFile(join(root, 'untracked.md'), 'untracked\n'); await git(root, 'add', '--', 'staged.md');
    await expect(adapter.publish({ operation: 'publish_new', slug: 'only', source: new Uint8Array([111, 110, 108, 121]), commit_message: 'Publish only' })).resolves.toMatchObject({ ok: true });
    expect(await git(root, 'diff', '--name-only')).toBe('README.md'); expect(await git(root, 'diff', '--cached', '--name-only')).toBe('staged.md'); expect(await readFile(join(root, 'untracked.md'), 'utf8')).toBe('untracked\n'); expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('src/content/writing/only.md');
  });

  it('returns critical recovery failure without push when conditional ref quarantine fails', async () => {
    const { root, remote } = await make_repository(); const remote_before = await git(remote, 'rev-parse', 'main');
    const hook = join(root, '.git/hooks/pre-commit'); await writeFile(hook, '#!/bin/sh\nprintf leaked-content > src/content/writing/critical.md\ngit add -- src/content/writing/critical.md\n'); await (await import('node:fs/promises')).chmod(hook, 0o755);
    const runner: git_command_runner = async (file, args, cwd) => { if (args[0] === 'update-ref') throw new Error('ref failure leaked-content'); const output = await exec_file_async(file, [...args], { cwd }); return { stdout: output.stdout, stderr: output.stderr }; };
    const adapter = new local_git_adapter({ repository_root: root, publication_branch: 'main', remote_name: 'origin', writing_directory: 'src/content/writing', command_runner: runner });
    const result = await adapter.publish({ operation: 'publish_new', slug: 'critical', source: new TextEncoder().encode('safe'), commit_message: 'Publish critical' });
    expect(result).toMatchObject({ ok: false, code: 'critical_recovery_failed' }); if (!result.ok) expect(result.message).not.toContain('leaked-content'); expect(await git(remote, 'rev-parse', 'main')).toBe(remote_before);
  });
});
