import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse_studio_article, serialize_studio_article, discover_local_images } from './studio_article';
import { render_markdown_preview, studio_validation_error } from './markdown_preview';
import { prepare_article_images, rewrite_markdown_images, studio_image_publish_error, type cleanup_result, type cos_adapter, type image_preparation_options, type prepared_image } from './studio_images';
import type { git_adapter, git_publish_result, git_transaction_inspection, git_transaction_inspection_input } from './studio_git';
import { is_studio_response, studio_protocol_error, validate_studio_request, type studio_error, type studio_request, type studio_response } from './studio_protocol';

type deployment_adapter = { report(input: { public_url: string; commit_sha: string }): Promise<void> };
type transaction_phase = 'pre_commit' | 'git_pending' | 'ambiguous' | 'committed' | 'pushed';
type transaction_status = 'in_progress' | 'completed' | 'recovery_required';
type owned_object = { object_key: string; version_id: string; sha256: string };
type pending_upload = { object_key: string; sha256: string };
type studio_claim = { token: string; pid: number; created_at: string; payload_hash: string };
type journal = { protocol_version: 1; request_id: string; payload_hash: string; status: transaction_status; phase: transaction_phase; target_path: string; target_sha256?: string; owned: owned_object[]; pending_upload?: pending_upload; commit_sha?: string; result?: studio_response };
type journal_event = 'before_write' | 'before_file_sync' | 'before_rename' | 'before_directory_sync';
type process_state = 'active' | 'dead' | 'unknown';

export type studio_publish_runtime = { now?: () => Date; process_id?: () => number; random_token?: () => string; probe_process?: (pid: number) => process_state; on_journal_event?: (event: journal_event, path: string) => void | Promise<void> };
export type studio_claim_recovery_options = Pick<studio_publish_runtime, 'probe_process'>;
export type studio_git_recovery_state = git_transaction_inspection;
export type studio_git_recovery_adapter = { inspect(input: git_transaction_inspection_input): Promise<studio_git_recovery_state> };
export type studio_git_recovery_dependencies = { inspect?: studio_git_recovery_adapter['inspect']; git?: Pick<git_adapter, 'inspect_studio_transaction'>; public_site_url?: string; runtime?: studio_publish_runtime };
export type studio_publish_dependencies = { journal_root: string; public_site_url?: string; image_options?: Omit<image_preparation_options, 'year' | 'slug'>; cos?: cos_adapter; git?: git_adapter; deployment?: deployment_adapter; prepare_images?: (sources: studio_request['images'], options: image_preparation_options) => Promise<prepared_image[]>; runtime?: studio_publish_runtime };

const queues = new Map<string, Promise<void>>();
const request_id_pattern = /^(?:[a-f0-9]{32}|[a-f0-9]{64}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;
const sha256_pattern = /^[a-f0-9]{64}$/;
const commit_sha_pattern = /^[a-f0-9]{40}$/;
const target_path_pattern = /^src\/content\/writing\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Produces a stable SHA-256 identity without retaining draft contents in the journal. */
const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

/** Produces a structured Studio response error. */
const issue = (code: string, message: string, field?: string): studio_error => ({ code, message, ...(field === undefined ? {} : { field }) });

/** Produces a failed response with an optional exact-version cleanup report. */
const failed = (errors: studio_error[], cleanup?: cleanup_result): studio_response => ({ protocol_version: 1, kind: 'failed', errors, ...(cleanup === undefined ? {} : { cleanup }) });

/** Ensures an item resolves under, rather than to, a root directory. */
const inside = (root: string, value: string): boolean => { const item = relative(root, value); return item !== '' && !item.startsWith('..') && !isAbsolute(item); };

/** Computes the replay identity while replacing binary image bytes with their digest. */
const payload_hash = (request: studio_request): string => sha256(JSON.stringify({ ...request, images: (request.images ?? []).map((image) => ({ ...image, bytes: sha256(image.bytes) })) }));

/** Returns the only permitted journal pathname for a validated request identifier. */
const journal_path = (root: string, request_id: string): string => join(root, '.studio', 'transactions', `${request_id}.json`);

/** Returns the lock path paired with a journal path. */
const claim_path = (path: string): string => `${path}.lock`;

/** Treats only regular records as runtime JSON objects. */
const is_record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks that a journal-owned object carries exact, safe deletion identity. */
const is_owned_object = (value: unknown): value is owned_object => is_record(value) && Object.keys(value).every((key) => ['object_key', 'version_id', 'sha256'].includes(key)) && typeof value.object_key === 'string' && value.object_key.length > 0 && typeof value.version_id === 'string' && value.version_id.length > 0 && typeof value.sha256 === 'string' && sha256_pattern.test(value.sha256);

/** Checks the crash marker written and fsynced before one COS PUT. */
const is_pending_upload = (value: unknown): value is pending_upload => is_record(value) && Object.keys(value).every((key) => ['object_key', 'sha256'].includes(key)) && typeof value.object_key === 'string' && value.object_key.length > 0 && typeof value.sha256 === 'string' && sha256_pattern.test(value.sha256);

/** Checks complete lock contents before relying on another process's claim. */
const is_studio_claim = (value: unknown): value is studio_claim => is_record(value) && Object.keys(value).every((key) => ['token', 'pid', 'created_at', 'payload_hash'].includes(key)) && typeof value.token === 'string' && sha256_pattern.test(value.token) && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)) && typeof value.payload_hash === 'string' && sha256_pattern.test(value.payload_hash);

/** Checks phase-specific journal state so malformed completed records cannot trigger cleanup. */
const is_journal = (value: unknown, expected_request_id?: string): value is journal => {
  if (!is_record(value) || value.protocol_version !== 1 || typeof value.request_id !== 'string' || !request_id_pattern.test(value.request_id) || (expected_request_id !== undefined && value.request_id !== expected_request_id) || typeof value.payload_hash !== 'string' || !sha256_pattern.test(value.payload_hash) || (value.status !== 'in_progress' && value.status !== 'completed' && value.status !== 'recovery_required') || (value.phase !== 'pre_commit' && value.phase !== 'git_pending' && value.phase !== 'ambiguous' && value.phase !== 'committed' && value.phase !== 'pushed') || typeof value.target_path !== 'string' || !target_path_pattern.test(value.target_path) || !Array.isArray(value.owned) || !value.owned.every(is_owned_object) || new Set(value.owned.map((item) => item.object_key)).size !== value.owned.length) return false;
  if (value.pending_upload !== undefined && !is_pending_upload(value.pending_upload)) return false;
  if (value.target_sha256 !== undefined && (typeof value.target_sha256 !== 'string' || !sha256_pattern.test(value.target_sha256))) return false;
  if (value.commit_sha !== undefined && (typeof value.commit_sha !== 'string' || !commit_sha_pattern.test(value.commit_sha))) return false;
  if (value.result !== undefined && !is_studio_response(value.result)) return false;
  if (value.status === 'completed' && value.result === undefined) return false;
  if (value.status !== 'completed' && value.result !== undefined) return false;
  if (value.phase === 'pre_commit') return value.target_sha256 === undefined && value.commit_sha === undefined && (value.status !== 'completed' || value.result?.kind === 'failed') && (value.pending_upload === undefined || value.status === 'in_progress');
  if (value.phase === 'git_pending') return value.status === 'in_progress' && value.target_sha256 !== undefined && value.commit_sha === undefined && value.pending_upload === undefined;
  if (value.phase === 'ambiguous') return value.status === 'recovery_required' && value.target_sha256 !== undefined && value.commit_sha === undefined && value.pending_upload === undefined;
  if (value.phase === 'committed') return value.target_sha256 !== undefined && value.commit_sha !== undefined && value.pending_upload === undefined && ((value.status === 'completed' && value.result?.kind === 'committed_local' && value.result.commit_sha === value.commit_sha) || value.status === 'in_progress');
  return value.target_sha256 !== undefined && value.commit_sha !== undefined && value.pending_upload === undefined && value.status === 'completed' && value.result?.kind === 'published' && value.result.commit_sha === value.commit_sha;
};

/** Reads and fully validates a journal before it can influence recovery decisions. */
const read_journal = async (path: string, expected_request_id?: string): Promise<journal | undefined> => {
  const raw = await readFile(path, 'utf8').catch((cause: unknown) => {
    if (is_record(cause) && cause.code === 'ENOENT') return undefined;
    throw cause;
  });
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('corrupt journal'); }
  if (!is_journal(value, expected_request_id)) throw new Error('corrupt journal');
  return value;
};

/** Writes a journal atomically and fsyncs both file and containing directory. */
const write_journal = async (path: string, value: journal, runtime?: studio_publish_runtime): Promise<void> => {
  if (!is_journal(value, value.request_id)) throw new Error('invalid journal state');
  const process_id = runtime?.process_id?.() ?? process.pid;
  const temporary = `${path}.${process_id}.${runtime?.now?.().getTime() ?? Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await runtime?.on_journal_event?.('before_write', path);
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value));
    await runtime?.on_journal_event?.('before_file_sync', path);
    await file.sync();
    await file.close(); file = undefined;
    await runtime?.on_journal_event?.('before_rename', path);
    await rename(temporary, path);
    await runtime?.on_journal_event?.('before_directory_sync', path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
};

/** Reads and validates a claim without deleting or modifying it. */
const read_claim = async (path: string): Promise<studio_claim | undefined> => {
  const raw = await readFile(path, 'utf8').catch((cause: unknown) => {
    if (is_record(cause) && cause.code === 'ENOENT') return undefined;
    throw cause;
  });
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('corrupt claim'); }
  if (!is_studio_claim(value)) throw new Error('corrupt claim');
  return value;
};

/** Probes a process conservatively: permissions and PID reuse both remain active/unknown. */
const probe_process = (pid: number, runtime?: Pick<studio_publish_runtime, 'probe_process'>): process_state => {
  if (runtime?.probe_process) return runtime.probe_process(pid);
  try { process.kill(pid, 0); return 'active'; } catch (cause: unknown) { return is_record(cause) && cause.code === 'ESRCH' ? 'dead' : 'unknown'; }
};

/** Writes a tokenized, fsynced claim and never treats an existing claim as disposable. */
const acquire_claim = async (path: string, payload: string, runtime?: studio_publish_runtime): Promise<{ acquired: true; claim: studio_claim } | { acquired: false; claim?: studio_claim }> => {
  const token = runtime?.random_token?.() ?? randomBytes(32).toString('hex');
  const pid = runtime?.process_id?.() ?? process.pid;
  if (!sha256_pattern.test(token) || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid claim runtime');
  const claim: studio_claim = { token, pid, created_at: (runtime?.now?.() ?? new Date()).toISOString(), payload_hash: payload };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(claim));
    await handle.sync();
    await handle.close(); handle = undefined;
    return { acquired: true, claim };
  } catch (cause: unknown) {
    await handle?.close().catch(() => undefined);
    if (!is_record(cause) || cause.code !== 'EEXIST') throw cause;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe claim');
    const existing = await read_claim(path);
    return { acquired: false, ...(existing === undefined ? {} : { claim: existing }) };
  }
};

/** Removes a claim only after proving the lock is still owned by this exact token. */
const release_claim = async (path: string, token: string): Promise<void> => {
  const current = await read_claim(path).catch(() => undefined);
  if (current?.token === token) await unlink(path);
};

/** Validates the request document and enforces one supplied local file per Markdown reference. */
const validate = async (request: studio_request): Promise<ReturnType<typeof parse_studio_article>> => {
  await render_markdown_preview(request.markdown);
  const article = parse_studio_article(request.markdown, request.slug);
  const supplied = new Set((request.images ?? []).map((image) => image.source_path.replace(/^\.\//, '')));
  const referenced = discover_local_images(request.markdown).map((item) => item.replace(/^\.\//, ''));
  if (referenced.some((item) => !supplied.has(item)) || [...supplied].some((item) => !referenced.includes(item))) throw new studio_protocol_error([issue('image_pairing', 'Every local Markdown image must have exactly one supplied image.', 'images')]);
  return article;
};

/** Copies mutable request values before queueing to prevent caller mutation from changing effects. */
const snapshot_request = (request: studio_request): studio_request => ({ ...request, metadata: { ...request.metadata, ...(request.metadata.tags ? { tags: [...request.metadata.tags] } : {}), ...(request.metadata.social ? { social: { ...request.metadata.social } } : {}) }, ...(request.images ? { images: request.images.map((image) => ({ ...image, bytes: new Uint8Array(image.bytes) })) } : {}) });

/** Produces a safe recovery response for opaque filesystem or side-effect ambiguity. */
const recovery = (code: string, message: string): studio_response => ({ protocol_version: 1, kind: 'recovery_required', errors: [issue(code, message)] });

/** Resolves a pending remote upload after a restart without claiming another request's object. */
const reconcile_pending_upload = async (path: string, current: journal, prepared: ReadonlyMap<string, prepared_image>, adapter: cos_adapter, runtime?: studio_publish_runtime): Promise<{ journal: journal; reused: Set<string> }> => {
  const pending = current.pending_upload;
  if (!pending) return { journal: current, reused: new Set<string>() };
  const image = prepared.get(pending.object_key);
  if (!image || image.sha256 !== pending.sha256) throw new Error('pending upload does not match request images');
  const remote = await adapter.inspect_object(pending.object_key);
  if (!remote) {
    const next: journal = { ...current, pending_upload: undefined };
    await write_journal(path, next, runtime);
    return { journal: next, reused: new Set<string>() };
  }
  if (remote.sha256 !== pending.sha256) throw new studio_image_publish_error('collision', [], `Object collision: ${pending.object_key}`);
  if (remote.studio_request_id === current.request_id) {
    if (!remote.version_id) throw new Error('matching remote upload lacks exact version id');
    const owned = [...current.owned, { object_key: pending.object_key, version_id: remote.version_id, sha256: pending.sha256 }];
    const next: journal = { ...current, owned, pending_upload: undefined };
    await write_journal(path, next, runtime);
    return { journal: next, reused: new Set<string>() };
  }
  const next: journal = { ...current, pending_upload: undefined };
  await write_journal(path, next, runtime);
  return { journal: next, reused: new Set([pending.object_key]) };
};

/** Removes only exact owned versions and never touches reused or pending objects. */
const cleanup_owned = async (owned: readonly owned_object[], adapter: cos_adapter): Promise<cleanup_result> => {
  const deleted: string[] = []; const failures: string[] = [];
  for (const object of owned) try { await adapter.delete_object(object.object_key, object.version_id); deleted.push(object.object_key); } catch { failures.push(object.object_key); }
  return { deleted, failures };
};

/** Finishes a proven pre-Git failure with exact-version cleanup when its journal remains writable. */
const finish_precommit_failure = async (path: string, current: journal, adapter: cos_adapter, code: string, message: string, runtime?: studio_publish_runtime): Promise<studio_response> => {
  if (current.pending_upload !== undefined) return recovery('pending_upload', 'An upload outcome is not yet known; inspect the transaction before cleanup.');
  const cleanup = await cleanup_owned(current.owned, adapter);
  const result = failed([issue(code, message)], cleanup);
  const failed_keys = new Set(cleanup.failures);
  const next: journal = cleanup.failures.length ? { ...current, owned: current.owned.filter((object) => failed_keys.has(object.object_key)), status: 'recovery_required' } : { ...current, owned: [], status: 'completed', result };
  try { await write_journal(path, next, runtime); } catch { return recovery('journal_failure', 'Cleanup completed or may need reconciliation; no further automatic deletion was attempted.'); }
  return result;
};

/** Marks a Git call as ambiguous before returning, preserving all owned images. */
const mark_git_ambiguous = async (path: string, current: journal, runtime?: studio_publish_runtime): Promise<void> => {
  await write_journal(path, { ...current, phase: 'ambiguous', status: 'recovery_required', pending_upload: undefined }, runtime);
};

/** Resolves a durable Git-pending journal through a read-only local/remote Git inspection adapter. */
export const reconcile_studio_git_transaction = async (journal_root: string, request_id: string, dependencies: studio_git_recovery_dependencies): Promise<studio_response> => {
  if (!request_id_pattern.test(request_id)) return recovery('invalid_request_id', 'The transaction request id is invalid.');
  let held_claim: studio_claim | undefined; let path = '';
  try {
    const root = resolve(journal_root); path = resolve(journal_path(root, request_id));
    if (!inside(root, path)) return recovery('unsafe_journal', 'Journal path is unsafe.');
    const existing = await read_journal(path, request_id);
    if (!existing) return recovery('missing_journal', 'No transaction journal exists.');
    if (existing.status === 'completed') return existing.result!;
    if ((existing.phase !== 'git_pending' && existing.phase !== 'ambiguous') || !existing.target_sha256) return recovery('not_git_pending', 'Only an ambiguous Git transaction can be reconciled here.');
    const acquired = await acquire_claim(claim_path(path), existing.payload_hash, dependencies.runtime);
    if (!acquired.acquired) return recovery('request_claimed', 'Transaction is actively claimed or needs explicit stale-claim recovery.');
    held_claim = acquired.claim;
    const current = await read_journal(path, request_id);
    if (!current || current.payload_hash !== existing.payload_hash || (current.phase !== 'git_pending' && current.phase !== 'ambiguous') || !current.target_sha256) return recovery('journal_changed', 'Transaction state changed while claiming it.');
    const inspect = dependencies.inspect ?? dependencies.git?.inspect_studio_transaction;
    if (!inspect) return recovery('git_inspector_unavailable', 'No read-only Git transaction inspector is configured.');
    let inspected: studio_git_recovery_state;
    try { inspected = await inspect({ target_path: current.target_path, target_sha256: current.target_sha256, phase: current.phase }); }
    catch { try { await mark_git_ambiguous(path, current, dependencies.runtime); } catch { /* durable git_pending still prohibits cleanup */ } return recovery('git_ambiguous', 'Git inspection failed; images were retained.'); }
    if (inspected.state === 'not_committed') {
      await write_journal(path, { ...current, phase: 'pre_commit', status: 'in_progress', target_sha256: undefined }, dependencies.runtime);
      return recovery('git_not_committed', 'Git confirmed no commit and unchanged target; exact pre-commit cleanup or retry is available.');
    }
    if (inspected.state === 'committed_local') {
      if (!commit_sha_pattern.test(inspected.commit_sha)) return recovery('git_ambiguous', 'Git inspection returned an invalid local commit identity.');
      const result: studio_response = { protocol_version: 1, kind: 'committed_local', commit_sha: inspected.commit_sha, recovery: 'Local commit is retained; inspect Git state before retrying.' };
      await write_journal(path, { ...current, phase: 'committed', status: 'completed', commit_sha: inspected.commit_sha, result }, dependencies.runtime);
      return result;
    }
    if (inspected.state === 'pushed') {
      if (!commit_sha_pattern.test(inspected.commit_sha) || !dependencies.public_site_url) return recovery('git_ambiguous', 'Git inspection could not produce a publishable commit and site URL.');
      const public_url = new URL(`/articles/${target_path_pattern.exec(current.target_path)?.[1] ?? ''}/`, dependencies.public_site_url).toString();
      const result: studio_response = { protocol_version: 1, kind: 'published', public_url, commit_sha: inspected.commit_sha };
      await write_journal(path, { ...current, phase: 'pushed', status: 'completed', commit_sha: inspected.commit_sha, result }, dependencies.runtime);
      return result;
    }
    try { await mark_git_ambiguous(path, current, dependencies.runtime); } catch { /* durable git_pending still prohibits cleanup */ }
    return recovery('git_ambiguous', 'Git inspection could not determine commit state; images were retained.');
  } catch (cause: unknown) { return recovery(cause instanceof Error && cause.message === 'corrupt journal' ? 'corrupt_journal' : 'git_reconciliation_failed', 'Git transaction reconciliation could not be completed safely.');
  } finally { if (held_claim && path) await release_claim(claim_path(path), held_claim.token).catch(() => undefined); }
};

/** Explicitly releases a dead process's claim through tokenized quarantine verification. */
export const recover_stale_studio_claim = async (journal_root: string, request_id: string, options?: studio_claim_recovery_options): Promise<studio_response> => {
  if (!request_id_pattern.test(request_id)) return recovery('invalid_request_id', 'The claim request id is invalid.');
  try {
    const root = resolve(journal_root); const path = resolve(claim_path(journal_path(root, request_id)));
    if (!inside(root, path)) return recovery('unsafe_claim', 'Claim path is unsafe.');
    const claim = await read_claim(path);
    if (!claim) return recovery('missing_claim', 'No claim exists to recover.');
    if (probe_process(claim.pid, options) !== 'dead') return recovery('claim_active', 'The claim PID is active, inaccessible, or may have been reused.');
    const quarantine = `${path}.${claim.token}.quarantine`;
    if (await lstat(quarantine).then(() => true).catch(() => false)) return recovery('claim_quarantine_exists', 'A prior claim quarantine needs manual inspection.');
    await rename(path, quarantine);
    const verified = await read_claim(quarantine);
    if (!verified || verified.token !== claim.token || verified.pid !== claim.pid || verified.created_at !== claim.created_at || verified.payload_hash !== claim.payload_hash) return recovery('claim_quarantine_mismatch', 'Claim quarantine could not be verified.');
    await unlink(quarantine);
    return { protocol_version: 1, kind: 'recovered_stale_claim', errors: [] };
  } catch { return recovery('claim_recovery_failed', 'The stale claim could not be safely released.'); }
};

/** Reconciles a failed pre-commit transaction under the same durable claim protocol as publishing. */
export const cleanup_studio_transaction = async (journal_root: string, request_id: string, adapter: cos_adapter, runtime?: studio_publish_runtime): Promise<studio_response> => {
  if (!request_id_pattern.test(request_id)) return recovery('invalid_request_id', 'The transaction request id is invalid.');
  let held_claim: studio_claim | undefined;
  let path = '';
  try {
    const root = resolve(journal_root); path = resolve(journal_path(root, request_id));
    if (!inside(root, path)) return recovery('unsafe_journal', 'Journal path is unsafe.');
    const existing = await read_journal(path, request_id);
    if (!existing) return recovery('missing_journal', 'No transaction journal exists.');
    if (existing.status === 'completed') return existing.result!;
    if (existing.phase !== 'pre_commit' || (existing.status !== 'in_progress' && existing.status !== 'recovery_required') || existing.pending_upload !== undefined) return recovery('commit_retained', 'This transaction has an ambiguous or post-Git state and retains its images.');
    const acquired = await acquire_claim(claim_path(path), existing.payload_hash, runtime);
    if (!acquired.acquired) return recovery('request_claimed', 'Transaction is actively claimed or needs explicit stale-claim recovery.');
    held_claim = acquired.claim;
    const current = await read_journal(path, request_id);
    if (!current || current.payload_hash !== existing.payload_hash || current.phase !== 'pre_commit' || (current.status !== 'in_progress' && current.status !== 'recovery_required') || current.pending_upload !== undefined) return recovery('journal_changed', 'Transaction state changed while claiming it.');
    return finish_precommit_failure(path, current, adapter, 'reconciled', 'Owned versions were reconciled.', runtime);
  } catch { return recovery('corrupt_journal', 'Journal or claim is corrupt or unavailable; no objects were deleted.');
  } finally { if (held_claim && path) await release_claim(claim_path(path), held_claim.token).catch(() => undefined); }
};

/** Publishes one snapshot with durable per-object ownership and conservative Git recovery. */
export const publish_article = async (input: unknown, dependencies: studio_publish_dependencies): Promise<studio_response> => {
  let request: studio_request;
  try { request = validate_studio_request(input); } catch (cause: unknown) { return failed(cause instanceof studio_protocol_error ? cause.errors : [issue('invalid_request', 'Request is invalid.')]); }
  if (request.kind === 'preview') {
    try { await validate(request); return { protocol_version: 1, kind: 'preview', publishable: false, errors: [issue('preview_only', 'Preview requests are not publishable.')] }; }
    catch (cause: unknown) { return { protocol_version: 1, kind: 'preview', publishable: false, errors: cause instanceof studio_protocol_error ? cause.errors : [issue('validation', 'Preview validation failed.')] }; }
  }
  if (!dependencies.image_options || !dependencies.git || !dependencies.public_site_url || !dependencies.cos) return failed([issue('not_publishable', 'Publishing is not configured locally.')]);
  const snapshot = snapshot_request(request);
  if (snapshot.kind === 'preview') return recovery('invalid_request', 'Preview requests cannot enter publication flow.');
  const hash = payload_hash(snapshot); const root = resolve(dependencies.journal_root); const queue_key = `${root}:${snapshot.request_id}`;
  const previous = queues.get(queue_key) ?? Promise.resolve(); let release_queue: (() => void) | undefined;
  const gate = new Promise<void>((resolve_gate) => { release_queue = resolve_gate; }); const tail = previous.then(() => gate); queues.set(queue_key, tail); await previous;
  let held_claim: studio_claim | undefined; let path = '';
  try {
    path = resolve(journal_path(root, snapshot.request_id));
    if (!inside(root, path)) return recovery('unsafe_journal', 'Journal path is unsafe.');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(path)); const journal_file = await lstat(path).catch(() => undefined);
    if (!directory.isDirectory() || directory.isSymbolicLink() || journal_file?.isSymbolicLink()) return recovery('unsafe_journal', 'Journal path is unsafe.');
    const acquired = await acquire_claim(claim_path(path), hash, dependencies.runtime);
    if (!acquired.acquired) {
      if (acquired.claim?.payload_hash !== undefined && acquired.claim.payload_hash !== hash) return failed([issue('request_id_conflict', 'request_id is claimed for another payload.', 'request_id')]);
      return recovery('request_claimed', 'Another process owns this request or a crashed claim needs explicit reconciliation.');
    }
    held_claim = acquired.claim;
    let current = await read_journal(path, snapshot.request_id);
    if (current) {
      if (current.payload_hash !== hash) return failed([issue('request_id_conflict', 'request_id was already used for a different payload.', 'request_id')]);
      if (current.target_path !== `src/content/writing/${snapshot.slug}.md`) return recovery('corrupt_journal', 'Journal target does not match this publication request.');
      if (current.status === 'completed') return current.result!;
      if (current.status !== 'in_progress' || current.phase !== 'pre_commit') return recovery('recovery_required', 'An earlier publication has an ambiguous or post-Git state.');
    }
    let article: ReturnType<typeof parse_studio_article>;
    try { article = await validate(snapshot); } catch (cause: unknown) { return failed(cause instanceof studio_protocol_error ? cause.errors : cause instanceof studio_validation_error ? cause.issues : [issue('validation', 'Article validation failed.')]); }
    let prepared: prepared_image[];
    try {
      const image_options: image_preparation_options = { ...dependencies.image_options, year: snapshot.year, slug: snapshot.slug };
      prepared = dependencies.prepare_images ? await dependencies.prepare_images(snapshot.images, image_options) : (await prepare_article_images(snapshot.images ?? [], image_options)).images;
    } catch (cause: unknown) { return failed([issue('image_validation', cause instanceof Error ? cause.message.replace(/[\r\n].*/s, '') : 'Image validation failed.')]); }
    const prepared_by_key = new Map(prepared.map((image) => [image.object_key, image]));
    if (prepared_by_key.size !== prepared.length || prepared.some((image) => !sha256_pattern.test(image.sha256) || sha256(image.bytes) !== image.sha256)) return failed([issue('image_validation', 'Prepared images have invalid deterministic identity.')]);
    if (current?.owned.some((object) => prepared_by_key.get(object.object_key)?.sha256 !== object.sha256)) return recovery('corrupt_journal', 'Journal-owned objects do not match this publication request.');
    if (!current) {
      current = { protocol_version: 1, request_id: snapshot.request_id, payload_hash: hash, status: 'in_progress', phase: 'pre_commit', target_path: `src/content/writing/${snapshot.slug}.md`, owned: [] };
      try { await write_journal(path, current, dependencies.runtime); } catch { return recovery('journal_failure', 'Transaction journal could not be initialized before upload.'); }
    }
    let reused = new Set<string>();
    try {
      const reconciled = await reconcile_pending_upload(path, current, prepared_by_key, dependencies.cos, dependencies.runtime); current = reconciled.journal; reused = reconciled.reused;
    } catch (cause: unknown) { return recovery(cause instanceof studio_image_publish_error ? 'image_collision' : 'reconcile_failed', 'Pending upload could not be safely reconciled.'); }
    const owned_keys = new Set(current.owned.map((object) => object.object_key));
    try {
      await dependencies.cos.verify_versioning();
      for (const image of prepared) {
        if (owned_keys.has(image.object_key) || reused.has(image.object_key)) continue;
        const remote = await dependencies.cos.inspect_object(image.object_key);
        if (remote) {
          if (remote.sha256 !== image.sha256) throw new studio_image_publish_error('collision', [], `Object collision: ${image.object_key}`);
          reused.add(image.object_key); continue;
        }
        const pending: journal = { ...current, pending_upload: { object_key: image.object_key, sha256: image.sha256 } };
        await write_journal(path, pending, dependencies.runtime); current = pending;
        let created: { version_id: string };
        try { created = await dependencies.cos.upload_object(image, snapshot.request_id); }
        catch (cause: unknown) {
          const raced = await dependencies.cos.inspect_object(image.object_key).catch(() => undefined);
          if (!raced) throw cause;
          if (raced.sha256 !== image.sha256) throw new studio_image_publish_error('collision', [], `Object collision: ${image.object_key}`);
          if (raced.studio_request_id === snapshot.request_id) {
            if (!raced.version_id) throw new Error('matching remote upload lacks exact version id');
            created = { version_id: raced.version_id };
          } else { reused.add(image.object_key); const cleared: journal = { ...current, pending_upload: undefined }; await write_journal(path, cleared, dependencies.runtime); current = cleared; continue; }
        }
        if (!created.version_id) throw new Error('created object lacks exact version id');
        const owned = [...current.owned, { object_key: image.object_key, version_id: created.version_id, sha256: image.sha256 }];
        const recorded: journal = { ...current, owned, pending_upload: undefined };
        await write_journal(path, recorded, dependencies.runtime); current = recorded; owned_keys.add(image.object_key);
      }
    } catch (cause: unknown) {
      if (current.pending_upload !== undefined && cause instanceof studio_image_publish_error && cause.code === 'collision') {
        const cleared: journal = { ...current, pending_upload: undefined };
        try { await write_journal(path, cleared, dependencies.runtime); } catch { return recovery('journal_failure', 'Collision was detected but its pending upload marker could not be finalized.'); }
        return finish_precommit_failure(path, cleared, dependencies.cos, 'image_collision', cause.message, dependencies.runtime);
      }
      if (current.pending_upload !== undefined) return recovery('pending_upload', 'Image upload outcome is not safely known; resources were retained.');
      return finish_precommit_failure(path, current, dependencies.cos, cause instanceof studio_image_publish_error ? 'image_collision' : 'image_upload_failed', cause instanceof Error ? cause.message.replace(/[\r\n].*/s, '') : 'Image upload failed.', dependencies.runtime);
    }
    const urls = new Map(prepared.map((image) => [image.source_path, image.public_url]));
    let source: Uint8Array;
    try { source = new TextEncoder().encode(serialize_studio_article({ ...article, body: rewrite_markdown_images(article.body, urls), metadata: { ...article.metadata, ...snapshot.metadata, slug: snapshot.slug, assets: prepared.map(({ source_path, object_key, public_url }) => ({ source_path, object_key, public_url })) } })); }
    catch (cause: unknown) { return finish_precommit_failure(path, current, dependencies.cos, 'serialization_failed', cause instanceof Error ? cause.message.replace(/[\r\n].*/s, '') : 'Article serialization failed.', dependencies.runtime); }
    const git_pending: journal = { ...current, phase: 'git_pending', pending_upload: undefined, target_sha256: sha256(source) };
    try { await write_journal(path, git_pending, dependencies.runtime); current = git_pending; }
    catch { return recovery('journal_failure', 'Git was not called because its durable pending marker could not be written.'); }
    let git_result: git_publish_result;
    try { git_result = await dependencies.git.publish({ operation: snapshot.kind, slug: snapshot.slug, source, commit_message: snapshot.commit_message, ...(snapshot.kind === 'publish_update' ? { expected_source_hash: snapshot.expected_source_hash } : {}) }); }
    catch { try { await mark_git_ambiguous(path, current, dependencies.runtime); } catch { /* git_pending itself prohibits cleanup */ } return recovery('git_ambiguous', 'Git threw after its durable pending marker; images were retained.'); }
    if (!git_result.ok && git_result.commit_retained === true) {
      if (!git_result.commit_sha) { try { await mark_git_ambiguous(path, current, dependencies.runtime); } catch { /* git_pending itself prohibits cleanup */ } return recovery('git_ambiguous', 'Git may have retained a commit; images were retained.'); }
      const result: studio_response = { protocol_version: 1, kind: 'committed_local', commit_sha: git_result.commit_sha, recovery: git_result.code === 'push_failed' ? git_result.recovery : 'Local commit is retained; inspect Git state before retrying.' };
      try { await write_journal(path, { ...current, phase: 'committed', status: 'completed', commit_sha: git_result.commit_sha, result }, dependencies.runtime); }
      catch { return recovery('journal_failure', 'Git retained a commit and images were retained because its result was not journaled.'); }
      return result;
    }
    if (!git_result.ok) return finish_precommit_failure(path, { ...current, phase: 'pre_commit', target_sha256: undefined }, dependencies.cos, git_result.code, git_result.message, dependencies.runtime);
    const committed: journal = { ...current, phase: 'committed', commit_sha: git_result.commit_sha };
    try { await write_journal(path, committed, dependencies.runtime); }
    catch { return { protocol_version: 1, kind: 'committed_local', commit_sha: git_result.commit_sha, recovery: 'Git succeeded but transaction finalization was not durable; inspect the journal before retrying.' }; }
    const public_url = new URL(`/articles/${snapshot.slug}/`, dependencies.public_site_url).toString(); let deployment_advisory: string | undefined;
    try { await dependencies.deployment?.report({ public_url, commit_sha: git_result.commit_sha }); } catch { deployment_advisory = 'Deployment status could not be confirmed.'; }
    const result: studio_response = { protocol_version: 1, kind: 'published', public_url, commit_sha: git_result.commit_sha, ...(deployment_advisory === undefined ? {} : { deployment_advisory }) };
    try { await write_journal(path, { ...committed, phase: 'pushed', status: 'completed', result }, dependencies.runtime); }
    catch { return { protocol_version: 1, kind: 'committed_local', commit_sha: git_result.commit_sha, recovery: 'Git succeeded but the pushed result was not journaled; retain resources and inspect the journal.' }; }
    return result;
  } catch (cause: unknown) { return recovery(cause instanceof Error && cause.message === 'corrupt journal' ? 'corrupt_journal' : 'journal_failure', 'Publication journal is unavailable; no automatic cleanup was attempted.');
  } finally {
    if (held_claim && path) await release_claim(claim_path(path), held_claim.token).catch(() => undefined);
    release_queue?.(); if (queues.get(queue_key) === tail) queues.delete(queue_key);
  }
};
