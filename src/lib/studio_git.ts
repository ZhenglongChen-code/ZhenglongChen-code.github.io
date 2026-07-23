import { createHash } from 'node:crypto';
import { execFile as exec_file } from 'node:child_process';
import { constants as fs_constants } from 'node:fs';
import { access, lstat, open, realpath, rename, unlink, readFile, stat } from 'node:fs/promises';
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
  expected_baseline_sha?: string;
  commit_message: string;
};

export type git_publish_failure_code = 'validation' | 'unsafe_path' | 'article_exists' | 'article_missing' | 'stale_source' | 'baseline_changed' | 'target_dirty' | 'repository_busy' | 'wrong_branch' | 'integrity_failed' | 'critical_recovery_failed' | 'git_failed';
export type git_publish_failure = { ok: false; code: Exclude<git_publish_failure_code, 'critical_recovery_failed'>; message: string; commit_retained?: false } | { ok: false; code: 'critical_recovery_failed'; message: string; commit_retained: true; commit_sha?: string };
export type git_push_failed = { ok: false; code: 'push_failed'; message: string; commit_retained: true; commit_sha: string; committed_paths: string[]; recovery: string };
export type git_publish_success = { ok: true; path: string; commit_retained?: true; commit_sha: string; push_status: 'pushed' };
export type git_publish_result = git_publish_failure | git_push_failed | git_publish_success;
export type git_transaction_baseline = { pre_git_head: string; baseline_sha: string };
export type git_transaction_inspection_input = { target_path: string; target_sha256: string; phase: 'git_pending' | 'ambiguous'; pre_git_head: string; baseline_sha: string };
export type git_transaction_inspection = { state: 'not_committed' } | { state: 'committed_local'; commit_sha: string } | { state: 'pushed'; commit_sha: string } | { state: 'unknown' };

export interface git_adapter { capture_baseline(input: { target_path: string }): Promise<git_transaction_baseline>; publish(input: git_publish_input): Promise<git_publish_result>; inspect_studio_transaction?(input: git_transaction_inspection_input): Promise<git_transaction_inspection>; }
export type git_command_runner = (file: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
export type local_git_adapter_options = { repository_root: string; publication_branch: string; remote_name: string; writing_directory: string; command_runner?: git_command_runner };

const default_runner: git_command_runner = async (file, args, cwd) => {
  const output = await exec_file_async(file, [...args], { cwd, encoding: 'utf8' });
  return { stdout: output.stdout, stderr: output.stderr };
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const is_inside = (root: string, value: string): boolean => { const value_relative = relative(root, value); return value_relative !== '' && !value_relative.startsWith('..') && !isAbsolute(value_relative); };
type directory_identity = { path: string; dev: number; ino: number };

/** Identifies an expected Git command exit status without trusting arbitrary thrown values. */
const is_git_exit_status = (cause: unknown, expected_status: number): boolean => typeof cause === 'object' && cause !== null && 'code' in cause && (cause as { code?: unknown }).code === expected_status;

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

  /** Captures a stable publication-branch HEAD for durable use before a Studio Git call. */
  async capture_baseline(input: { target_path: string }): Promise<git_transaction_baseline> {
    if (!this.safe_transaction_target(input.target_path)) throw new Error('Unsafe Studio transaction target.');
    const canonical_root = await realpath(this.repository_root);
    const git_root = await realpath(await this.run_git('rev-parse', '--show-toplevel'));
    if (canonical_root !== git_root || !safe_branch_token(this.publication_branch) || !safe_remote_token(this.remote_name)) throw new Error('Studio Git configuration is not safe.');
    const branch = await this.run_git('symbolic-ref', '--quiet', '--short', 'HEAD');
    if (branch !== this.publication_branch || await this.is_shallow_repository()) throw new Error('Publication branch cannot provide a complete baseline.');
    const pre_git_head = await this.run_git('rev-parse', 'HEAD');
    const baseline_sha = await this.run_git('rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(pre_git_head) || pre_git_head !== baseline_sha) throw new Error('Publication HEAD changed while capturing baseline.');
    return { pre_git_head, baseline_sha };
  }

  async publish(input: git_publish_input): Promise<git_publish_result> {
    if (input.operation !== 'publish_new' && input.operation !== 'publish_update') return { ok: false, code: 'validation', message: 'Invalid publication operation.' };
    const source = new Uint8Array(input.source);
    const snapshot = { ...input, source, commit_message: `${input.commit_message}`, slug: `${input.slug}`, expected_source_hash: input.expected_source_hash === undefined ? undefined : `${input.expected_source_hash}`, expected_baseline_sha: input.expected_baseline_sha === undefined ? undefined : `${input.expected_baseline_sha}` };
    let canonical_root: string;
    try { canonical_root = await realpath(this.repository_root); } catch { return { ok: false, code: 'git_failed', message: 'Git publication failed; inspect the local repository state and retry.' }; }
    let queue_key = canonical_root;
    try { queue_key = await realpath(resolve(canonical_root, await this.run_git('rev-parse', '--git-common-dir'))); } catch { /* publish_locked reports the Git failure */ }
    const previous = local_git_adapter.repository_queues.get(queue_key) ?? Promise.resolve();
    const queued = previous.then(() => this.publish_locked(snapshot, canonical_root));
    const tail = queued.then(() => undefined, () => undefined);
    local_git_adapter.repository_queues.set(queue_key, tail);
    void tail.finally(() => { if (local_git_adapter.repository_queues.get(queue_key) === tail) local_git_adapter.repository_queues.delete(queue_key); });
    return queued;
  }

  /** Inspects only local and remote Git state for a journaled transaction; it never mutates either repository. */
  async inspect_studio_transaction(input: git_transaction_inspection_input): Promise<git_transaction_inspection> {
    if ((input.phase !== 'git_pending' && input.phase !== 'ambiguous') || !/^[a-f0-9]{64}$/.test(input.target_sha256) || !/^[a-f0-9]{40}$/.test(input.pre_git_head) || !/^[a-f0-9]{40}$/.test(input.baseline_sha) || input.pre_git_head !== input.baseline_sha || !this.safe_transaction_target(input.target_path)) return { state: 'unknown' };
    try {
      const canonical_root = await realpath(this.repository_root);
      const git_root = await realpath(await this.run_git('rev-parse', '--show-toplevel'));
      if (canonical_root !== git_root) return { state: 'unknown' };
      const branch = await this.run_git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
      if (branch !== this.publication_branch || !safe_branch_token(this.publication_branch) || !safe_remote_token(this.remote_name)) return { state: 'unknown' };
      if (await this.is_shallow_repository()) return { state: 'unknown' };
      if (await this.path_dirty(input.target_path)) return { state: 'unknown' };
      const current_head = await this.run_git('rev-parse', 'HEAD');
      if (!/^[a-f0-9]{40}$/.test(current_head)) return { state: 'unknown' };
      await this.run_git('rev-parse', '--verify', `${input.baseline_sha}^{commit}`);
      try { await this.run_git('merge-base', '--is-ancestor', input.baseline_sha, current_head); }
      catch { return { state: 'unknown' }; }
      const transaction_commits = (await this.run_git('rev-list', '--topo-order', `${input.baseline_sha}..${current_head}`, '--', input.target_path)).split('\n').filter((commit_sha) => /^[a-f0-9]{40}$/.test(commit_sha));
      if (transaction_commits.length === 0) return { state: 'not_committed' };
      let commit_sha: string | undefined;
      for (const candidate_sha of transaction_commits) {
        const committed = await this.committed_bytes(candidate_sha, input.target_path).catch(() => undefined);
        if (committed && sha256(committed) === input.target_sha256) { commit_sha = candidate_sha; break; }
      }
      if (!commit_sha) return { state: 'unknown' };
      const [remote_sha] = (await this.run_git('ls-remote', this.remote_name, `refs/heads/${this.publication_branch}`)).split(/\s+/);
      if (remote_sha === undefined || !/^[a-f0-9]{40}$/.test(remote_sha)) return { state: 'unknown' };
      if (remote_sha === commit_sha) return { state: 'pushed', commit_sha };
      try { await this.run_git('cat-file', '-e', `${remote_sha}^{commit}`); }
      catch { return { state: 'unknown' }; }
      try {
        await this.run_git('merge-base', '--is-ancestor', commit_sha, remote_sha);
        return { state: 'pushed', commit_sha };
      } catch (cause: unknown) {
        return is_git_exit_status(cause, 1) ? { state: 'committed_local', commit_sha } : { state: 'unknown' };
      }
    } catch { return { state: 'unknown' }; }
  }

  private async run_git(...args: string[]): Promise<string> {
    const output = await this.command_runner('git', args, this.repository_root);
    return output.stdout.trim();
  }

  /** Reports whether this clone explicitly advertises incomplete shallow history. */
  private async is_shallow_repository(): Promise<boolean> {
    return (await this.run_git('rev-parse', '--is-shallow-repository')) === 'true';
  }

  private async publish_locked(input: git_publish_input, canonical_root: string): Promise<git_publish_result> {
    if (!slug_pattern.test(input.slug) || !commit_message_pattern.test(input.commit_message) || input.commit_message.startsWith('-') || !safe_branch_token(this.publication_branch) || !safe_remote_token(this.remote_name) || !writing_directory_pattern.test(this.writing_directory)) return { ok: false, code: 'validation', message: 'Invalid publication input or configuration.' };
    if (input.operation === 'publish_update' && (!input.expected_source_hash || !/^[a-f0-9]{64}$/.test(input.expected_source_hash))) return { ok: false, code: 'validation', message: 'An update requires a SHA-256 expected_source_hash.' };
    if (input.expected_baseline_sha !== undefined && !/^[a-f0-9]{40}$/.test(input.expected_baseline_sha)) return { ok: false, code: 'validation', message: 'The expected Git baseline is invalid.' };
    let mutation_started = false; let commit_created = false; let retained_sha: string | undefined;
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
      const writing_stat = await stat(writing_real);
      if (!writing_stat.isDirectory()) return { ok: false, code: 'unsafe_path', message: 'Writing directory is unsafe.' };
      const writing_identity = { path: writing_real, dev: writing_stat.dev, ino: writing_stat.ino };
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
      if (input.expected_baseline_sha !== undefined && old_head !== input.expected_baseline_sha) return { ok: false, code: 'baseline_changed', message: 'Publication branch advanced after the Studio baseline was captured; no Git changes were made.' };
      mutation_started = true;
      await this.atomic_write(target, input.source, writing_identity, target_stat?.mode);
      await this.run_git('add', '--', relative_path);
      await this.run_git('commit', '--only', '-m', input.commit_message, '--', relative_path); commit_created = true;
      const commit_sha = await this.run_git('rev-parse', 'HEAD').catch(async () => this.run_git('show', '-s', '--format=%H', 'HEAD')); retained_sha = commit_sha;
      if (input.expected_baseline_sha !== undefined && (await this.run_git('show', '-s', '--format=%P', commit_sha)) !== input.expected_baseline_sha) return { ok: false, code: 'critical_recovery_failed', commit_retained: true, commit_sha, message: 'The Studio commit parent changed after its baseline check; the local commit was retained and was not pushed.' };
      const changed = (await this.run_git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n').filter(Boolean);
      if (changed.length !== 1 || changed[0] !== relative_path || !this.bytes_equal(await this.committed_bytes(commit_sha, relative_path), input.source)) {
        return { ok: false, code: 'critical_recovery_failed', commit_retained: true, commit_sha, message: 'Committed article integrity failed; the local commit was retained and was not pushed.' };
      }
      try {
        const remote_ref = `refs/heads/${this.publication_branch}`;
        await this.run_git('push', this.remote_name, `${commit_sha}:${remote_ref}`);
        const remote_sha = (await this.run_git('ls-remote', this.remote_name, remote_ref)).split(/\s+/)[0];
        if (remote_sha !== commit_sha) return { ok: false, code: 'push_failed', message: 'Remote did not confirm the verified article commit.', commit_retained: true, commit_sha, committed_paths: [relative_path], recovery: 'Inspect the remote branch before retrying; do not force-push.' };
        return { ok: true, path: relative_path, commit_retained: true, commit_sha, push_status: 'pushed' };
      }
      catch { return { ok: false, code: 'push_failed', message: 'Push failed after the local article commit was created.', commit_retained: true, commit_sha, committed_paths: [relative_path], recovery: 'Local commit was kept. Fetch the remote branch, resolve divergence, then push normally without force.' }; }
    } catch { return mutation_started || commit_created ? { ok: false, code: 'critical_recovery_failed', commit_retained: true, ...(retained_sha === undefined ? {} : { commit_sha: retained_sha }), message: 'Studio may have left Markdown or index changes after Git verification failed; do not clean images or push until inspected.' } : { ok: false, code: 'git_failed', message: 'Git publication failed; inspect the local repository state and retry.' }; }
  }

  private async path_dirty(relative_path: string): Promise<boolean> {
    try {
      if (await this.run_git('status', '--porcelain=v1', '--untracked-files=all', '--', relative_path)) return true;
      await this.run_git('diff', '--quiet', '--', relative_path);
      await this.run_git('diff', '--cached', '--quiet', '--', relative_path);
      return false;
    } catch { return true; }
  }

  /** Confines a journal target to this adapter's configured writing directory and one Markdown file. */
  private safe_transaction_target(target_path: string): boolean {
    const expected_prefix = `${this.writing_directory}/`;
    if (!writing_directory_pattern.test(this.writing_directory) || !target_path.startsWith(expected_prefix) || !target_path.endsWith('.md') || target_path.includes('\\') || target_path.includes('..') || target_path.slice(expected_prefix.length, -3).includes('/')) return false;
    const target = resolve(this.repository_root, target_path);
    return is_inside(resolve(this.repository_root, this.writing_directory), target);
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

  private async atomic_write(target: string, source: Uint8Array, identity: directory_identity, existing_mode: number | undefined): Promise<void> {
    const current_real = await realpath(identity.path); const current_stat = await lstat(identity.path);
    if (current_real !== identity.path || current_stat.isSymbolicLink() || current_stat.dev !== identity.dev || current_stat.ino !== identity.ino) throw new Error('Writing directory changed.');
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', existing_mode === undefined ? 0o644 : existing_mode & 0o777);
      await handle.chmod(existing_mode === undefined ? 0o644 : existing_mode & 0o777);
      await handle.writeFile(source); await handle.sync(); await handle.close(); handle = undefined;
      const final_stat = await lstat(identity.path); if (final_stat.isSymbolicLink() || final_stat.dev !== identity.dev || final_stat.ino !== identity.ino) throw new Error('Writing directory changed.');
      await rename(temporary, target);
      const parent_handle = await open(identity.path, 'r'); try { await parent_handle.sync(); } finally { await parent_handle.close(); }
    } finally { if (handle) await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
}
