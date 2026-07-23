import { createHash } from 'node:crypto';
import { execFile as exec_file } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { local_git_adapter, type git_publish_result } from '../src/lib/studio_git';

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
    expect(result).toMatchObject({ ok: true, push_status: 'failed' });
    if (result.ok) expect(result.recovery).toMatch(/pull|rebase|resolve/i);
    expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('src/content/writing/local.md');
  });
});
