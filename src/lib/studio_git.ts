import { createHash } from 'node:crypto';
import { execFile as exec_file } from 'node:child_process';
import { constants as fs_constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, unlink, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec_file_async = promisify(exec_file);
const slug_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const token_pattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const remote_pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const commit_message_pattern = /^[^\x00-\x1f\x7f-][^\x00-\x1f\x7f]{0,199}$/;
const writing_directory_pattern = /^src\/content\/writing(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const safe_branch_token = (value: string): boolean => token_pattern.test(value) && !value.includes('//') && !value.includes('..') && !value.endsWith('.lock') && !value.startsWith('-');
const safe_remote_token = (value: string): boolean => remote_pattern.test(value) && !value.endsWith('.lock') && !value.startsWith('-');

export type git_publish_input = {
  operation: 'publish_new' | 'publish_update';
  slug: string;
  source: Uint8Array;
  expected_source_hash?: string;
  commit_message: string;
};

export type git_publish_failure_code = 'validation' | 'unsafe_path' | 'article_exists' | 'article_missing' | 'stale_source' | 'target_dirty' | 'repository_busy' | 'wrong_branch' | 'integrity_failed' | 'critical_recovery_failed' | 'git_failed';
export type git_publish_failure = { ok: false; code: git_publish_failure_code; message: string };
export type git_push_failed = { ok: false; code: 'push_failed'; message: string; commit_sha: string; committed_paths: string[]; recovery: string };
export type git_publish_success = { ok: true; path: string; commit_sha: string; push_status: 'pushed' };
export type git_publish_result = git_publish_failure | git_push_failed | git_publish_success;

export interface git_adapter { publish(input: git_publish_input): Promise<git_publish_result>; }
export type git_command_runner = (file: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
export type local_git_adapter_options = { repository_root: string; publication_branch: string; remote_name: string; writing_directory: string; command_runner?: git_command_runner };

const default_runner: git_command_runner = async (file, args, cwd) => {
  const output = await exec_file_async(file, [...args], { cwd, encoding: 'utf8' });
  return { stdout: output.stdout, stderr: output.stderr };
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const is_inside = (root: string, value: string): boolean => { const value_relative = relative(root, value); return value_relative !== '' && !value_relative.startsWith('..') && !isAbsolute(value_relative); };

/** Publishes one verified Markdown article without changing unrelated Git state. */
export class local_git_adapter implements git_adapter {
  private static readonly repository_queues = new Map<string, Promise<void>>();
  private readonly repository_root: string;
  private readonly publication_branch: string;
  private readonly remote_name: string;
  private readonly writing_directory: string;
  private readonly command_runner: git_command_runner;

  constructor(options: local_git_adapter_options) {
    this.repository_root = resolve(options.repository_root);
    this.publication_branch = options.publication_branch;
    this.remote_name = options.remote_name;
    this.writing_directory = options.writing_directory;
    this.command_runner = options.command_runner ?? default_runner;
  }

  async publish(input: git_publish_input): Promise<git_publish_result> {
    if (input.operation !== 'publish_new' && input.operation !== 'publish_update') return { ok: false, code: 'validation', message: 'Invalid publication operation.' };
    const source = new Uint8Array(input.source);
    const snapshot = { ...input, source, commit_message: `${input.commit_message}`, slug: `${input.slug}`, expected_source_hash: input.expected_source_hash === undefined ? undefined : `${input.expected_source_hash}` };
    let canonical_root: string;
    try { canonical_root = await realpath(this.repository_root); } catch { return { ok: false, code: 'git_failed', message: 'Git publication failed; inspect the local repository state and retry.' }; }
    const previous = local_git_adapter.repository_queues.get(canonical_root) ?? Promise.resolve();
    const queued = previous.then(() => this.publish_locked(snapshot, canonical_root));
    local_git_adapter.repository_queues.set(canonical_root, queued.then(() => undefined, () => undefined));
    return queued;
  }

  private async run_git(...args: string[]): Promise<string> {
    const output = await this.command_runner('git', args, this.repository_root);
    return output.stdout.trim();
  }

  private async publish_locked(input: git_publish_input, canonical_root: string): Promise<git_publish_result> {
    if (!slug_pattern.test(input.slug) || !commit_message_pattern.test(input.commit_message) || input.commit_message.startsWith('-') || !safe_branch_token(this.publication_branch) || !safe_remote_token(this.remote_name) || !writing_directory_pattern.test(this.writing_directory)) return { ok: false, code: 'validation', message: 'Invalid publication input or configuration.' };
    if (input.operation === 'publish_update' && (!input.expected_source_hash || !/^[a-f0-9]{64}$/.test(input.expected_source_hash))) return { ok: false, code: 'validation', message: 'An update requires a SHA-256 expected_source_hash.' };
    try {
      const configured_root = canonical_root;
      const git_root = await realpath(await this.run_git('rev-parse', '--show-toplevel'));
      if (configured_root !== git_root) return { ok: false, code: 'unsafe_path', message: 'Configured repository root does not match Git root.' };
      try { await this.run_git('check-ref-format', '--branch', this.publication_branch); }
      catch { return { ok: false, code: 'validation', message: 'Invalid publication branch configuration.' }; }
      const branch = await this.run_git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
      if (branch !== this.publication_branch) return { ok: false, code: 'wrong_branch', message: 'Repository is not on the configured publication branch.' };
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'rebase-merge']) {
        const marker_path = await this.run_git('rev-parse', '--git-path', marker);
        if (await this.exists(resolve(configured_root, marker_path))) return { ok: false, code: 'repository_busy', message: 'Repository has an unfinished Git operation.' };
      }
      if ((await this.run_git('ls-files', '-u')).trim()) return { ok: false, code: 'repository_busy', message: 'Repository has unresolved paths.' };

      const writing_root = resolve(configured_root, this.writing_directory);
      const writing_real = await realpath(writing_root);
      if (!is_inside(configured_root, writing_root) || writing_real !== writing_root) return { ok: false, code: 'unsafe_path', message: 'Writing directory is unsafe.' };
      const relative_path = `${this.writing_directory}/${input.slug}.md`;
      const target = resolve(configured_root, relative_path);
      if (!is_inside(writing_real, target) || basename(target) !== `${input.slug}.md`) return { ok: false, code: 'unsafe_path', message: 'Article path is unsafe.' };
      const target_stat = await lstat(target).catch(() => undefined);
      if (target_stat?.isSymbolicLink()) return { ok: false, code: 'unsafe_path', message: 'Article path must not be a symbolic link.' };
      const exists = target_stat !== undefined;
      if (input.operation === 'publish_new' && exists) return { ok: false, code: 'article_exists', message: 'Article already exists.' };
      if (exists && (await this.path_dirty(relative_path))) return { ok: false, code: 'target_dirty', message: 'Target article has uncommitted changes.' };
      if (input.operation === 'publish_update' && !exists) return { ok: false, code: 'article_missing', message: 'Article does not exist.' };
      if (exists) {
        const current = await readFile(target);
        if (sha256(current) !== input.expected_source_hash) return { ok: false, code: 'stale_source', message: 'Target article changed since it was read.' };
      }
      const old_head = await this.run_git('rev-parse', 'HEAD');
      await this.atomic_write(target, input.source);
      await this.run_git('add', '--', relative_path);
      await this.run_git('commit', '--only', '-m', input.commit_message, '--', relative_path);
      const commit_sha = await this.run_git('rev-parse', 'HEAD');
      const changed = (await this.run_git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n').filter(Boolean);
      if (changed.length !== 1 || changed[0] !== relative_path || !this.bytes_equal(await this.committed_bytes(commit_sha, relative_path), input.source)) {
        try {
          await this.run_git('update-ref', `refs/heads/${this.publication_branch}`, old_head, commit_sha);
          return { ok: false, code: 'integrity_failed', message: 'Committed article integrity verification failed; the unpublished branch ref was restored.' };
        } catch { return { ok: false, code: 'critical_recovery_failed', message: 'Committed article integrity failed; do not push. Manually inspect and restore the publication branch ref.' }; }
      }
      try {
        const remote_ref = `refs/heads/${this.publication_branch}`;
        await this.run_git('push', this.remote_name, `${commit_sha}:${remote_ref}`);
        const remote_sha = (await this.run_git('ls-remote', this.remote_name, remote_ref)).split(/\s+/)[0];
        if (remote_sha !== commit_sha) return { ok: false, code: 'push_failed', message: 'Remote did not confirm the verified article commit.', commit_sha, committed_paths: [relative_path], recovery: 'Inspect the remote branch before retrying; do not force-push.' };
        return { ok: true, path: relative_path, commit_sha, push_status: 'pushed' };
      }
      catch { return { ok: false, code: 'push_failed', message: 'Push failed after the local article commit was created.', commit_sha, committed_paths: [relative_path], recovery: 'Local commit was kept. Fetch the remote branch, resolve divergence, then push normally without force.' }; }
    } catch { return { ok: false, code: 'git_failed', message: 'Git publication failed; inspect the local repository state and retry.' }; }
  }

  private async path_dirty(relative_path: string): Promise<boolean> {
    try {
      if (await this.run_git('status', '--porcelain=v1', '--untracked-files=all', '--', relative_path)) return true;
      await this.run_git('diff', '--quiet', '--', relative_path);
      await this.run_git('diff', '--cached', '--quiet', '--', relative_path);
      return false;
    } catch { return true; }
  }

  private async exists(path: string): Promise<boolean> { try { await access(path, fs_constants.F_OK); return true; } catch { return false; } }

  private async committed_bytes(commit_sha: string, relative_path: string): Promise<Uint8Array> {
    const object_name = `${commit_sha}:${relative_path}`;
    const output = await exec_file_async('git', ['show', '--no-textconv', '--format=', object_name], { cwd: this.repository_root, encoding: 'buffer', maxBuffer: 10_000_000 });
    return new Uint8Array(output.stdout);
  }

  private bytes_equal(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  private async atomic_write(target: string, source: Uint8Array): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
}
