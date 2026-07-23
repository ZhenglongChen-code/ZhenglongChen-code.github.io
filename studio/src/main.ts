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
const image_files = new Map<string, File>();
let unresolved_sources: string[] = [];
let publish_is_configured = false;
let preview_controller: AbortController | undefined;
let preview_sequence = 0;
let import_sequence = 0;

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
  assets: [],
  social: { zhihu: get_field<HTMLInputElement>('zhihu').checked, wechat: get_field<HTMLInputElement>('wechat').checked, xiaohongshu: get_field<HTMLInputElement>('xiaohongshu').checked },
});

const write_metadata = (metadata: Partial<article_metadata>): void => {
  const normalized = normalize_article_metadata(metadata);
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
  image_urls = {};
  unresolved_sources = [];
  write_metadata({});
  render_images([]);
  preview_container.replaceChildren();
  preview_marker.textContent = 'Awaiting source';
  update_publish_state(false);
  announce('New document ready for preview.');
};

const pair_image_file = (source_path: string, file: File | undefined): void => {
  if (!file) return;
  if (!file.type.startsWith('image/')) { announce(`Select an image file for ${source_path}.`, 'validation'); return; }
  image_files.set(source_path, file);
  render_images(unresolved_sources);
  persist_draft();
  announce(`${file.name} selected for ${source_path}.`);
};

const render_images = (images: string[]): void => {
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
    const image_input = document.createElement('input'); image_input.type = 'file'; image_input.accept = 'image/*'; image_input.setAttribute('aria-label', `Select local image for ${source_path}`);
    const select_image = document.createElement('button'); select_image.type = 'button'; select_image.textContent = 'Select image'; select_image.setAttribute('aria-label', `Select local image for ${source_path}`);
    const selected = document.createElement('span'); selected.textContent = image_files.get(source_path) ? `Selected file: ${image_files.get(source_path)?.name}` : 'No local image selected.';
    const url = document.createElement('input'); url.type = 'url'; url.value = image_urls[source_path] ?? ''; url.placeholder = 'Final https:// image URL'; url.setAttribute('aria-label', `Final URL placeholder for ${source_path}`);
    const final_url = document.createElement('span'); final_url.textContent = url.value ? `Final URL: ${url.value}` : 'Final URL placeholder — supplied after upload.';
    const save_url = (): void => { image_urls = { ...image_urls, [source_path]: url.value.trim() }; final_url.textContent = url.value ? `Final URL: ${url.value}` : 'Final URL placeholder — supplied after upload.'; persist_draft(); };
    image_input.addEventListener('change', () => pair_image_file(source_path, image_input.files?.[0]));
    select_image.addEventListener('click', () => image_input.click());
    url.addEventListener('input', save_url);
    row.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); });
    row.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); const image_file = [...(event.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/')); if (!image_file) { announce(`Drop one image file for ${source_path}.`, 'validation'); return; } pair_image_file(source_path, image_file); announce(`${image_file.name} paired with ${source_path}.`); });
    row.append(label, image_input, select_image, selected, url, final_url); unresolved_images.append(row);
  }
};

const update_publish_state = (configured: boolean): void => {
  publish_is_configured = configured;
  publish_new.disabled = !configured;
  publish_update.disabled = !configured;
  publish_configuration.textContent = configured ? 'Publishing configuration detected.' : 'Preview only — publishing is not configured.';
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
  if (!is_current_import(import_sequence, file_sequence)) return;
  reset_document_state();
  source_input.value = markdown;
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

const publish = (mode: 'new' | 'update'): void => { announce(publish_is_configured ? `${mode === 'new' ? 'New article publication' : 'Article update'} is ready for the configured publisher.` : 'Publishing is disabled until a local publisher is configured.', 'publish'); };

file_input.addEventListener('change', () => { void import_file(file_input.files?.[0]); });
source_input.addEventListener('input', schedule_preview);
metadata_form.addEventListener('input', schedule_preview);
workspace.addEventListener('dragover', (event) => { event.preventDefault(); workspace.classList.add('is-dropping'); });
workspace.addEventListener('dragleave', () => workspace.classList.remove('is-dropping'));
workspace.addEventListener('drop', (event) => { event.preventDefault(); workspace.classList.remove('is-dropping'); void import_file(event.dataTransfer?.files[0]); });
unresolved_images.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); });
unresolved_images.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); const image_file = [...(event.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/')); if (!image_file) { announce('Drop an image file to pair it with a local image reference.', 'validation'); return; } if (unresolved_sources.length !== 1) { announce('Choose the unresolved image target before dropping a file.', 'validation'); return; } pair_image_file(unresolved_sources[0] as string, image_file); });
editor_tab.addEventListener('click', () => select_tab(0));
preview_tab.addEventListener('click', () => select_tab(1));
[editor_tab, preview_tab].forEach((tab, current_index) => tab.addEventListener('keydown', (event) => { const selected_index = next_tab_index(current_index, event.key, 2); if (selected_index !== current_index) { event.preventDefault(); select_tab(selected_index, true); } }));
publish_new.addEventListener('click', () => publish('new'));
publish_update.addEventListener('click', () => publish('update'));
window.addEventListener('resize', sync_workspace_mode);
restore_draft();
update_publish_state(false);
sync_workspace_mode();
if (source_input.value) schedule_preview();
};

if (typeof document !== 'undefined') initialize_studio();
