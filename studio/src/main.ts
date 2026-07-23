import 'katex/dist/katex.min.css';
import './studio.css';

type article_metadata = {
  title: string;
  description: string;
  date: string;
  updated?: string;
  tags: string[];
  language: 'zh' | 'en';
  translation?: string;
  featured: boolean;
  draft: boolean;
  slug: string;
  assets: studio_asset[];
  social: { zhihu: boolean; wechat: boolean; xiaohongshu: boolean };
};

type studio_asset = { source_path: string; object_key: string; public_url: string };
type preview_request = { markdown: string; metadata: article_metadata };
type preview_response = { preview_html: string; metadata: Partial<article_metadata>; unresolved_images: string[]; publish_configured?: boolean };
type image_intent = 'photo' | 'screenshot' | 'diagram';
type publish_error = { code: string; field?: string; message: string };
type publish_result = { kind: 'published'; public_url: string; commit_sha: string } | { kind: 'committed_local'; commit_sha: string; recovery: string } | { kind: 'failed'; errors: publish_error[] } | { kind: 'recovery_required'; errors: publish_error[] };
type studio_limits = { image_max_bytes: number; request_max_bytes: number; max_images: number };
type studio_draft = { markdown: string; metadata: article_metadata; image_urls: Record<string, string> };
type storage_adapter = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void };

/** Returns the next roving-tab stop for horizontal arrow navigation. */
export const next_tab_index = (current_index: number, key: string, tab_count: number): number => {
  if (tab_count < 1 || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return current_index;
  return key === 'ArrowRight' ? (current_index + 1) % tab_count : (current_index - 1 + tab_count) % tab_count;
};

/** Ensures a delayed response cannot overwrite a newer preview. */
export const is_latest_preview = (latest_sequence: number, response_sequence: number): boolean => latest_sequence === response_sequence;

/** Keeps focus for explicit actions while routine background updates stay non-disruptive. */
export const feedback_should_focus = (kind: 'import' | 'publish' | 'validation' | 'preview_failure'): boolean => kind !== 'preview_failure';

/** Creates the next monotonic generation for an imported document. */
export const next_import_sequence = (current_sequence: number): number => current_sequence + 1;

/** Prevents a slower File.text call from overwriting the latest chosen document. */
export const is_current_import = (current_sequence: number, candidate_sequence: number): boolean => current_sequence === candidate_sequence;

/** Supplies complete form values so omitted optional metadata clears deterministically. */
export const normalize_article_metadata = (metadata: Partial<article_metadata>): article_metadata => ({
  title: metadata.title ?? '', description: metadata.description ?? '', date: metadata.date ?? '', updated: metadata.updated ?? '', tags: metadata.tags ?? [], language: metadata.language ?? 'zh', translation: metadata.translation ?? '', featured: metadata.featured ?? false, draft: metadata.draft ?? false, slug: metadata.slug ?? '', assets: metadata.assets ?? [], social: { zhihu: metadata.social?.zhihu ?? true, wechat: metadata.social?.wechat ?? true, xiaohongshu: metadata.social?.xiaohongshu ?? true },
});

/** Reads local storage without letting privacy settings interrupt Studio startup. */
export const safe_storage_get = (storage: storage_adapter | undefined, key: string): string | null => { try { return storage?.getItem(key) ?? null; } catch { return null; } };

/** Writes local storage only when the browser permits it. */
export const safe_storage_set = (storage: storage_adapter | undefined, key: string, value: string): boolean => { try { storage?.setItem(key, value); return storage !== undefined; } catch { return false; } };

/** Removes invalid local state without surfacing storage permission failures. */
export const safe_storage_remove = (storage: storage_adapter | undefined, key: string): boolean => { try { storage?.removeItem(key); return storage !== undefined; } catch { return false; } };

/** Retains only image pairings still referenced by current Markdown, in source order. */
export const reconcile_image_pairs = (sources: readonly string[], files: ReadonlyMap<string, File>, intents: ReadonlyMap<string, image_intent>, urls: Readonly<Record<string, string>>): { files: Map<string, File>; intents: Map<string, image_intent>; urls: Record<string, string> } => {
  const next_files = new Map<string, File>(); const next_intents = new Map<string, image_intent>(); const next_urls: Record<string, string> = {};
  for (const source of sources) { const file = files.get(source); if (file) next_files.set(source, file); const intent = intents.get(source); if (intent) next_intents.set(source, intent); if (urls[source]) next_urls[source] = urls[source]!; }
  return { files: next_files, intents: next_intents, urls: next_urls };
};

/** Maps server-controlled result codes to fixed browser-safe recovery guidance. */
export const publication_feedback = (result: Extract<publish_result, { kind: 'failed' | 'recovery_required' }>): string => {
  const safe_field = (field: string | undefined): string => field !== undefined && /^[A-Za-z][A-Za-z0-9_.[\]-]{0,99}$/.test(field) ? field : 'the highlighted fields';
  const messages = result.errors.map((error) => {
    const code = error.code;
    if (code === 'validation' || code === 'image_pairing' || code === 'image_validation' || code === 'not_publishable' || code.startsWith('invalid_')) return `Validation: correct ${safe_field(error.field)} and retry.`;
    if (code.includes('image') || code === 'collision' || code === 'pending_upload') return 'Image upload: check image pairing and local image recovery before retrying.';
    if (code === 'stale_source') return 'The article changed since it was loaded; re-import it before updating.';
    if (code === 'baseline_changed') return 'The publication branch advanced; refresh the local branch and re-import before retrying.';
    if (code === 'target_dirty') return 'Resolve local modifications to the target article before retrying.';
    if (code === 'article_exists') return 'This article already exists; choose Update instead of New.';
    if (code === 'article_missing') return 'This article does not exist; choose New instead of Update.';
    if (code === 'wrong_branch') return 'Git: switch to the configured publication branch before retrying.';
    if (code === 'repository_busy') return 'Git: finish or abort the active Git operation before retrying.';
    if (code === 'unsafe_path') return 'Git: review the local repository configuration before retrying.';
    if (code === 'git_failed' || code === 'push_failed' || code.includes('critical') || code.includes('git')) return 'Git: inspect the local Git state and push normally without force.';
    if (code === 'request_id_conflict' || code === 'request_claimed' || code.includes('journal') || code.includes('corrupt') || code.includes('recovery') || code.includes('claim')) return 'Transaction recovery: inspect the local transaction before retrying; do not blindly retry.';
    return 'Publication needs local review before retrying.';
  });
  return [...new Set(messages)].join(' ');
};

const initialize_studio = (): void => {

const draft_key = 'latent_field_studio_draft_v1';
const preview_delay_ms = 450;

const by_id = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Studio element "${id}" is missing.`);
  return element as T;
};

const source_input = by_id<HTMLTextAreaElement>('markdown-source');
const file_input = by_id<HTMLInputElement>('markdown-file');
const metadata_form = by_id<HTMLFormElement>('metadata-form');
const preview_container = by_id<HTMLDivElement>('markdown-preview');
const preview_marker = by_id<HTMLElement>('preview-marker');
const unresolved_images = by_id<HTMLDivElement>('unresolved-images');
const status_message = by_id<HTMLElement>('studio-status');
const import_feedback = by_id<HTMLElement>('import-feedback');
const workspace = by_id<HTMLElement>('drop-zone');
const editor_tab = by_id<HTMLButtonElement>('editor-tab');
const preview_tab = by_id<HTMLButtonElement>('preview-tab');
const editor_panel = by_id<HTMLElement>('editor-panel');
const preview_panel = by_id<HTMLElement>('preview-panel');
const publish_configuration = by_id<HTMLElement>('publish-configuration');
const publish_new = by_id<HTMLButtonElement>('publish-new');
const publish_update = by_id<HTMLButtonElement>('publish-update');

let preview_timeout: number | undefined;
let image_urls: Record<string, string> = {};
let asset_manifest: studio_asset[] = [];
const image_files = new Map<string, File>();
const image_intents = new Map<string, image_intent>();
let unresolved_sources: string[] = [];
let publish_is_configured = false;
let preview_controller: AbortController | undefined;
let preview_sequence = 0;
let import_sequence = 0;
let session_token: string | undefined;
let expected_source_hash: string | undefined;
let publish_in_flight = false;
let studio_limits: studio_limits = { image_max_bytes: 20_000_000, request_max_bytes: 25_000_000, max_images: 20 };

const get_storage = (): storage_adapter | undefined => { try { return window.localStorage; } catch { return undefined; } };

const get_field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(name: string): T => {
  const field = metadata_form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) throw new Error(`Metadata field "${name}" is missing.`);
  return field as T;
};

const read_metadata = (): article_metadata => ({
  title: get_field<HTMLInputElement>('title').value.trim(),
  description: get_field<HTMLTextAreaElement>('description').value.trim(),
  date: get_field<HTMLInputElement>('date').value,
  updated: get_field<HTMLInputElement>('updated').value || undefined,
  tags: get_field<HTMLInputElement>('tags').value.split(',').map((tag) => tag.trim()).filter(Boolean),
  language: get_field<HTMLSelectElement>('language').value === 'en' ? 'en' : 'zh',
  translation: get_field<HTMLInputElement>('translation').value.trim() || undefined,
  featured: get_field<HTMLInputElement>('featured').checked,
  draft: get_field<HTMLInputElement>('draft').checked,
  slug: get_field<HTMLInputElement>('slug').value.trim(),
  assets: asset_manifest.map((asset) => ({ ...asset })),
  social: { zhihu: get_field<HTMLInputElement>('zhihu').checked, wechat: get_field<HTMLInputElement>('wechat').checked, xiaohongshu: get_field<HTMLInputElement>('xiaohongshu').checked },
});

const write_metadata = (metadata: Partial<article_metadata>): void => {
  const normalized = normalize_article_metadata(metadata);
  asset_manifest = normalized.assets.map((asset) => ({ ...asset }));
  get_field<HTMLInputElement>('title').value = normalized.title;
  get_field<HTMLTextAreaElement>('description').value = normalized.description;
  get_field<HTMLInputElement>('date').value = normalized.date;
  get_field<HTMLInputElement>('updated').value = normalized.updated ?? '';
  get_field<HTMLInputElement>('tags').value = normalized.tags.join(', ');
  get_field<HTMLSelectElement>('language').value = normalized.language;
  get_field<HTMLInputElement>('translation').value = normalized.translation ?? '';
  get_field<HTMLInputElement>('slug').value = normalized.slug;
  get_field<HTMLInputElement>('featured').checked = normalized.featured;
  get_field<HTMLInputElement>('draft').checked = normalized.draft;
  get_field<HTMLInputElement>('assets').value = `${normalized.assets.length} paired asset${normalized.assets.length === 1 ? '' : 's'}`;
  get_field<HTMLInputElement>('zhihu').checked = normalized.social.zhihu;
  get_field<HTMLInputElement>('wechat').checked = normalized.social.wechat;
  get_field<HTMLInputElement>('xiaohongshu').checked = normalized.social.xiaohongshu;
};

const announce = (message: string, kind?: 'import' | 'publish' | 'validation' | 'preview_failure'): void => {
  status_message.textContent = message;
  if (kind && feedback_should_focus(kind)) status_message.focus();
};

const persist_draft = (): void => {
  const draft: studio_draft = { markdown: source_input.value, metadata: read_metadata(), image_urls };
  if (!safe_storage_set(get_storage(), draft_key, JSON.stringify(draft))) announce('Draft could not be saved in this browser.');
};

const restore_draft = (): void => {
  const storage = get_storage();
  try {
    const stored_draft = safe_storage_get(storage, draft_key);
    if (!stored_draft) return;
    const draft = JSON.parse(stored_draft) as Partial<studio_draft>;
    if (typeof draft.markdown === 'string' && draft.metadata && typeof draft.metadata === 'object') {
      source_input.value = draft.markdown;
      write_metadata(draft.metadata);
      image_urls = draft.image_urls && typeof draft.image_urls === 'object' ? draft.image_urls : {};
      announce('Local draft restored.');
    }
  } catch { safe_storage_remove(storage, draft_key); announce('A corrupt local draft was safely ignored.'); }
};

const reset_document_state = (): void => {
  image_files.clear();
  image_intents.clear();
  image_urls = {};
  unresolved_sources = [];
  expected_source_hash = undefined;
  write_metadata({});
  render_images([]);
  preview_container.replaceChildren();
  preview_marker.textContent = 'Awaiting source';
  update_publish_state(false);
  announce('New document ready for preview.');
};

const pair_image_file = (source_path: string, file: File | undefined): void => {
  if (!file) return;
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') { announce(`Select a JPEG or PNG image for ${source_path}.`, 'validation'); return; }
  image_files.set(source_path, file);
  if (!image_intents.has(source_path)) image_intents.set(source_path, file.type === 'image/jpeg' ? 'photo' : 'diagram');
  render_images(unresolved_sources);
  persist_draft();
  announce(`${file.name} selected for ${source_path}.`);
};

const render_images = (images: string[]): void => {
  const pairs = reconcile_image_pairs(images, image_files, image_intents, image_urls);
  image_files.clear(); pairs.files.forEach((file, source) => image_files.set(source, file));
  image_intents.clear(); pairs.intents.forEach((intent, source) => image_intents.set(source, intent));
  image_urls = pairs.urls;
  unresolved_sources = images;
  unresolved_images.replaceChildren();
  if (images.length === 0) { unresolved_images.textContent = 'No local image references detected.'; return; }
  for (const source_path of images) {
    const row = document.createElement('div');
    row.className = 'image-item';
    row.dataset.sourcePath = source_path;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `Image pairing target for ${source_path}. Drop one image file here or use Select image.`);
    const label = document.createElement('strong'); label.textContent = source_path;
    const image_input = document.createElement('input'); image_input.type = 'file'; image_input.accept = 'image/jpeg,image/png'; image_input.setAttribute('aria-label', `Select local image for ${source_path}`);
    const select_image = document.createElement('button'); select_image.type = 'button'; select_image.textContent = 'Select image'; select_image.setAttribute('aria-label', `Select local image for ${source_path}`);
    const selected = document.createElement('span'); selected.textContent = image_files.get(source_path) ? `Selected file: ${image_files.get(source_path)?.name}` : 'No local image selected.';
    const intent = document.createElement('select'); intent.setAttribute('aria-label', `Image intent for ${source_path}`); for (const value of ['photo', 'screenshot', 'diagram'] as const) { const option = document.createElement('option'); option.value = value; option.textContent = value; intent.append(option); } intent.value = image_intents.get(source_path) ?? (image_files.get(source_path)?.type === 'image/jpeg' ? 'photo' : 'diagram');
    const url = document.createElement('input'); url.type = 'url'; url.value = image_urls[source_path] ?? ''; url.placeholder = 'Final https:// image URL'; url.setAttribute('aria-label', `Final URL placeholder for ${source_path}`);
    const final_url = document.createElement('span'); final_url.textContent = url.value ? `Final URL: ${url.value}` : 'Final URL placeholder — supplied after upload.';
    const save_url = (): void => { image_urls = { ...image_urls, [source_path]: url.value.trim() }; final_url.textContent = url.value ? `Final URL: ${url.value}` : 'Final URL placeholder — supplied after upload.'; persist_draft(); };
    image_input.addEventListener('change', () => pair_image_file(source_path, image_input.files?.[0]));
    intent.addEventListener('change', () => { image_intents.set(source_path, intent.value as image_intent); persist_draft(); });
    select_image.addEventListener('click', () => image_input.click());
    url.addEventListener('input', save_url);
    row.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); });
    row.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); const image_file = [...(event.dataTransfer?.files ?? [])].find((file) => file.type === 'image/jpeg' || file.type === 'image/png'); if (!image_file) { announce(`Drop one JPEG or PNG image for ${source_path}.`, 'validation'); return; } pair_image_file(source_path, image_file); announce(`${image_file.name} paired with ${source_path}.`); });
    row.append(label, image_input, select_image, selected, intent, url, final_url); unresolved_images.append(row);
  }
};

const update_publish_state = (configured: boolean): void => {
  publish_is_configured = configured && session_token !== undefined;
  publish_new.disabled = !publish_is_configured || publish_in_flight;
  publish_update.disabled = !publish_is_configured || !expected_source_hash || publish_in_flight;
  publish_configuration.textContent = !publish_is_configured ? 'Preview only — publishing is not configured.' : expected_source_hash ? 'Publishing configuration detected.' : 'Publishing configuration detected. Import an article file before updating an existing article.';
};

/** Computes the original imported article revision required for safe update publication. */
const source_hash = async (source: string): Promise<string | undefined> => {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Encodes one paired local image for the bounded JSON Studio protocol. */
const image_base64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  return btoa(binary);
};

/** Estimates encoded image size without reading file bytes into browser memory. */
const base64_size = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/** Returns a protocol-safe semantic image name from its paired Markdown source. */
const semantic_image_name = (source_path: string): string => {
  const normalized = source_path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'image';
};

const request_preview = async (): Promise<void> => {
  const request_sequence = preview_sequence;
  const request_controller = new AbortController();
  preview_controller = request_controller;
  const request: preview_request = { markdown: source_input.value, metadata: read_metadata() };
  preview_marker.textContent = 'Rendering…';
  try {
    const response = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: request_controller.signal });
    if (!response.ok) throw new Error('Preview request failed.');
    const preview = await response.json() as preview_response;
    if (!is_latest_preview(preview_sequence, request_sequence)) return;
    // server-sanitized preview HTML is assigned only to this dedicated preview container.
    preview_container.innerHTML = preview.preview_html;
    write_metadata(preview.metadata);
    render_images(preview.unresolved_images);
    update_publish_state(preview.publish_configured === true);
    preview_marker.textContent = 'Current proof';
    announce('Preview refreshed.');
  } catch (error) {
    if ((error instanceof DOMException && error.name === 'AbortError') || !is_latest_preview(preview_sequence, request_sequence)) return;
    preview_marker.textContent = 'Preview unavailable';
    announce('Preview unavailable. Your local draft remains intact.');
  }
};

const schedule_preview = (): void => {
  preview_sequence += 1;
  preview_controller?.abort();
  preview_controller = undefined;
  persist_draft();
  if (preview_timeout !== undefined) window.clearTimeout(preview_timeout);
  preview_timeout = window.setTimeout(() => { void request_preview(); }, preview_delay_ms);
};

const import_file = async (file: File | undefined): Promise<void> => {
  if (!file) return;
  const file_sequence = import_sequence = next_import_sequence(import_sequence);
  if (!(/\.md$/i.test(file.name) || ['text/markdown', 'text/plain'].includes(file.type))) { import_feedback.textContent = 'Please choose a Markdown (.md) file.'; import_feedback.focus(); return; }
  let markdown: string;
  try { markdown = await file.text(); } catch { if (is_current_import(import_sequence, file_sequence)) { import_feedback.textContent = `Unable to read ${file.name}.`; import_feedback.focus(); } return; }
  const imported_hash = await source_hash(markdown);
  if (!is_current_import(import_sequence, file_sequence)) return;
  reset_document_state();
  source_input.value = markdown;
  expected_source_hash = imported_hash;
  import_feedback.textContent = `Imported ${file.name}.`;
  import_feedback.focus();
  source_input.focus();
  schedule_preview();
};

const select_tab = (selected_index: number, should_focus = false): void => {
  const editor_selected = selected_index === 0;
  editor_tab.setAttribute('aria-selected', String(editor_selected)); editor_tab.tabIndex = editor_selected ? 0 : -1;
  preview_tab.setAttribute('aria-selected', String(!editor_selected)); preview_tab.tabIndex = editor_selected ? -1 : 0;
  editor_panel.hidden = !editor_selected; preview_panel.hidden = editor_selected;
  if (should_focus) (editor_selected ? editor_tab : preview_tab).focus();
};

const sync_workspace_mode = (): void => {
  if (window.matchMedia('(min-width: 900px)').matches) {
    editor_panel.hidden = false;
    preview_panel.hidden = false;
    return;
  }
  select_tab(editor_tab.getAttribute('aria-selected') === 'false' ? 1 : 0);
};

/** Publishes one protocol request while retaining the in-memory session boundary. */
const publish = async (mode: 'new' | 'update'): Promise<void> => {
  if (!publish_is_configured || !session_token || publish_in_flight) { announce('Publishing is disabled until a local publisher is configured.', 'publish'); return; }
  if (mode === 'update' && !expected_source_hash) { announce('Update requires an imported article revision.', 'validation'); return; }
  const metadata = read_metadata();
  const year = Number(metadata.date.slice(0, 4));
  if (!Number.isInteger(year)) { announce('Enter a valid publication date before publishing.', 'validation'); return; }
  const source_paths = [...unresolved_sources];
  const image_snapshot = source_paths.map((source_path) => ({ source_path, file: image_files.get(source_path), intent: image_intents.get(source_path) }));
  if (image_snapshot.some((image) => !image.file)) { announce('Pair every referenced local image before publishing.', 'validation'); return; }
  if (image_snapshot.length > studio_limits.max_images || image_snapshot.some((image) => image.file!.size > studio_limits.image_max_bytes)) { announce('One or more images exceed the local publishing limit.', 'validation'); return; }
  const metadata_snapshot = { ...metadata, tags: [...metadata.tags], social: { ...metadata.social } };
  const snapshot = { request_id: crypto.randomUUID().toLowerCase(), markdown: source_input.value, metadata: metadata_snapshot, slug: metadata.slug, year, expected_source_hash, images: image_snapshot.map((image) => ({ source_path: image.source_path, file: image.file!, intent: image.intent ?? (image.file!.type === 'image/jpeg' ? 'photo' : 'diagram'), semantic_name: semantic_image_name(image.source_path) })) };
  const { slug: _estimated_slug, assets: _estimated_assets, ...estimated_metadata } = snapshot.metadata;
  const image_descriptors = snapshot.images.map((image) => ({ source_path: image.source_path, bytes_base64: '', claimed_content_type: image.file.type === 'image/jpeg' ? 'image/jpeg' as const : 'image/png' as const, intent: image.intent, semantic_name: image.semantic_name }));
  const request_skeleton = { protocol_version: 1 as const, kind: mode === 'new' ? 'publish_new' as const : 'publish_update' as const, request_id: snapshot.request_id, slug: snapshot.slug, year: snapshot.year, markdown: snapshot.markdown, metadata: estimated_metadata, ...(image_descriptors.length ? { images: image_descriptors } : {}), commit_message: `content: publish ${snapshot.slug}`, ...(mode === 'update' ? { expected_source_hash: snapshot.expected_source_hash } : {}) };
  const estimated_bytes = new TextEncoder().encode(JSON.stringify(request_skeleton)).byteLength + snapshot.images.reduce((total, image) => total + base64_size(image.file.size), 0);
  if (estimated_bytes > studio_limits.request_max_bytes) { announce('This publication request exceeds the local request limit.', 'validation'); return; }
  publish_in_flight = true;
  update_publish_state(publish_is_configured);
  try {
    const images: { source_path: string; bytes_base64: string; claimed_content_type: 'image/jpeg' | 'image/png'; intent: image_intent; semantic_name: string }[] = [];
    for (const image of snapshot.images) images.push({ source_path: image.source_path, bytes_base64: await image_base64(image.file), claimed_content_type: image.file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', intent: image.intent, semantic_name: semantic_image_name(image.source_path) });
    const { slug, assets: _assets, ...protocol_metadata } = snapshot.metadata;
    const request = { protocol_version: 1 as const, kind: mode === 'new' ? 'publish_new' as const : 'publish_update' as const, request_id: snapshot.request_id, slug: snapshot.slug, year: snapshot.year, markdown: snapshot.markdown, metadata: protocol_metadata, ...(images.length ? { images } : {}), commit_message: `content: publish ${snapshot.slug}`, ...(mode === 'update' ? { expected_source_hash: snapshot.expected_source_hash } : {}) };
    const request_body = JSON.stringify(request);
    if (new TextEncoder().encode(request_body).byteLength > studio_limits.request_max_bytes) { announce('This publication request exceeds the local request limit.', 'validation'); return; }
    const response = await fetch('/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studio-token': session_token }, body: request_body });
    const result = await response.json() as publish_result;
    if (result.kind === 'failed' || result.kind === 'recovery_required') { announce(publication_feedback(result), 'publish'); return; }
    if (!response.ok) throw new Error('Publication failed.');
    if (result.kind === 'published') announce(`Published ${result.commit_sha}. ${result.public_url}`, 'publish');
    else announce(`Committed locally: ${result.commit_sha}. Push or recover it manually before retrying.`, 'publish');
  } catch {
    announce('Publication could not be completed. Your draft remains local.', 'publish');
  } finally {
    publish_in_flight = false;
    update_publish_state(publish_is_configured);
  }
};

/** Gets the local session and publication mode without persisting the bearer token. */
const initialize_local_api = async (): Promise<void> => {
  try {
    const [session_response, config_response] = await Promise.all([fetch('/api/session'), fetch('/api/config')]);
    if (!session_response.ok || !config_response.ok) throw new Error('Local session unavailable.');
    const session = await session_response.json() as { token?: unknown };
    const config = await config_response.json() as { preview_only?: unknown; image_max_bytes?: unknown; request_max_bytes?: unknown; max_images?: unknown };
    if (typeof session.token !== 'string' || !/^[a-f0-9]{64}$/.test(session.token)) throw new Error('Local session unavailable.');
    session_token = session.token;
    if (typeof config.image_max_bytes === 'number' && typeof config.request_max_bytes === 'number' && typeof config.max_images === 'number' && Number.isSafeInteger(config.image_max_bytes) && Number.isSafeInteger(config.request_max_bytes) && Number.isSafeInteger(config.max_images) && config.image_max_bytes > 0 && config.request_max_bytes > 0 && config.max_images > 0) studio_limits = { image_max_bytes: config.image_max_bytes, request_max_bytes: config.request_max_bytes, max_images: config.max_images };
    update_publish_state(config.preview_only !== true);
  } catch {
    session_token = undefined;
    update_publish_state(false);
  }
};

file_input.addEventListener('change', () => { void import_file(file_input.files?.[0]); });
source_input.addEventListener('input', schedule_preview);
metadata_form.addEventListener('input', schedule_preview);
workspace.addEventListener('dragover', (event) => { event.preventDefault(); workspace.classList.add('is-dropping'); });
workspace.addEventListener('dragleave', () => workspace.classList.remove('is-dropping'));
workspace.addEventListener('drop', (event) => { event.preventDefault(); workspace.classList.remove('is-dropping'); void import_file(event.dataTransfer?.files[0]); });
unresolved_images.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); });
unresolved_images.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); const image_file = [...(event.dataTransfer?.files ?? [])].find((file) => file.type === 'image/jpeg' || file.type === 'image/png'); if (!image_file) { announce('Drop a JPEG or PNG image to pair it with a local image reference.', 'validation'); return; } if (unresolved_sources.length !== 1) { announce('Choose the unresolved image target before dropping a file.', 'validation'); return; } pair_image_file(unresolved_sources[0] as string, image_file); });
editor_tab.addEventListener('click', () => select_tab(0));
preview_tab.addEventListener('click', () => select_tab(1));
[editor_tab, preview_tab].forEach((tab, current_index) => tab.addEventListener('keydown', (event) => { const selected_index = next_tab_index(current_index, event.key, 2); if (selected_index !== current_index) { event.preventDefault(); select_tab(selected_index, true); } }));
publish_new.addEventListener('click', () => { void publish('new'); });
publish_update.addEventListener('click', () => { void publish('update'); });
window.addEventListener('resize', sync_workspace_mode);
restore_draft();
update_publish_state(false);
void initialize_local_api();
sync_workspace_mode();
if (source_input.value) schedule_preview();
};

if (typeof document !== 'undefined') initialize_studio();
