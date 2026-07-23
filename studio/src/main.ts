import './studio.css';
import { is_latest_preview, next_tab_index } from './studio_logic';

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
  if (metadata.title !== undefined) get_field<HTMLInputElement>('title').value = metadata.title;
  if (metadata.description !== undefined) get_field<HTMLTextAreaElement>('description').value = metadata.description;
  if (metadata.date !== undefined) get_field<HTMLInputElement>('date').value = metadata.date;
  if (metadata.updated !== undefined) get_field<HTMLInputElement>('updated').value = metadata.updated;
  if (metadata.tags !== undefined) get_field<HTMLInputElement>('tags').value = metadata.tags.join(', ');
  if (metadata.language !== undefined) get_field<HTMLSelectElement>('language').value = metadata.language;
  if (metadata.translation !== undefined) get_field<HTMLInputElement>('translation').value = metadata.translation;
  if (metadata.slug !== undefined) get_field<HTMLInputElement>('slug').value = metadata.slug;
  if (metadata.featured !== undefined) get_field<HTMLInputElement>('featured').checked = metadata.featured;
  if (metadata.draft !== undefined) get_field<HTMLInputElement>('draft').checked = metadata.draft;
  if (metadata.assets !== undefined) get_field<HTMLInputElement>('assets').value = `${metadata.assets.length} paired asset${metadata.assets.length === 1 ? '' : 's'}`;
  if (metadata.social !== undefined) {
    get_field<HTMLInputElement>('zhihu').checked = metadata.social.zhihu;
    get_field<HTMLInputElement>('wechat').checked = metadata.social.wechat;
    get_field<HTMLInputElement>('xiaohongshu').checked = metadata.social.xiaohongshu;
  }
};

const announce = (message: string, focus = false): void => {
  status_message.textContent = message;
  if (focus) status_message.focus();
};

const persist_draft = (): void => {
  const draft: studio_draft = { markdown: source_input.value, metadata: read_metadata(), image_urls };
  try { localStorage.setItem(draft_key, JSON.stringify(draft)); } catch { announce('Draft could not be saved in this browser.'); }
};

const restore_draft = (): void => {
  try {
    const stored_draft = localStorage.getItem(draft_key);
    if (!stored_draft) return;
    const draft = JSON.parse(stored_draft) as Partial<studio_draft>;
    if (typeof draft.markdown === 'string' && draft.metadata && typeof draft.metadata === 'object') {
      source_input.value = draft.markdown;
      write_metadata(draft.metadata);
      image_urls = draft.image_urls && typeof draft.image_urls === 'object' ? draft.image_urls : {};
      announce('Local draft restored.');
    }
  } catch { localStorage.removeItem(draft_key); announce('A corrupt local draft was safely ignored.'); }
};

const pair_image_file = (source_path: string, file: File | undefined): void => {
  if (!file) return;
  if (!file.type.startsWith('image/')) { announce(`Select an image file for ${source_path}.`, true); return; }
  image_files.set(source_path, file);
  render_images(unresolved_sources);
  persist_draft();
  announce(`${file.name} selected for ${source_path}.`);
};

const render_images = (images: string[]): void => {
  unresolved_sources = images;
  unresolved_images.replaceChildren();
  if (images.length === 0) { unresolved_images.textContent = 'No local image references detected.'; return; }
  for (const filename of images) {
    const row = document.createElement('div');
    row.className = 'image-item';
    const label = document.createElement('strong'); label.textContent = filename;
    const image_input = document.createElement('input'); image_input.type = 'file'; image_input.accept = 'image/*'; image_input.setAttribute('aria-label', `Select local image for ${filename}`);
    const select_image = document.createElement('button'); select_image.type = 'button'; select_image.textContent = 'Select image'; select_image.setAttribute('aria-label', `Select local image for ${filename}`);
    const selected = document.createElement('span'); selected.textContent = image_files.get(filename) ? `Selected file: ${image_files.get(filename)?.name}` : 'No local image selected.';
    const url = document.createElement('input'); url.type = 'url'; url.value = image_urls[filename] ?? ''; url.placeholder = 'Final https:// image URL'; url.setAttribute('aria-label', `Final URL placeholder for ${filename}`);
    const final_url = document.createElement('span'); final_url.textContent = url.value ? `Final URL: ${url.value}` : 'Final URL placeholder — supplied after upload.';
    const save_url = (): void => { image_urls = { ...image_urls, [filename]: url.value.trim() }; final_url.textContent = url.value ? `Final URL: ${url.value}` : 'Final URL placeholder — supplied after upload.'; persist_draft(); };
    image_input.addEventListener('change', () => pair_image_file(filename, image_input.files?.[0]));
    select_image.addEventListener('click', () => image_input.click());
    url.addEventListener('input', save_url);
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
  preview_controller?.abort();
  preview_controller = new AbortController();
  const request_sequence = ++preview_sequence;
  const request: preview_request = { markdown: source_input.value, metadata: read_metadata() };
  preview_marker.textContent = 'Rendering…';
  try {
    const response = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: preview_controller.signal });
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
    announce('Preview unavailable. Your local draft remains intact.', true);
  }
};

const schedule_preview = (): void => {
  persist_draft();
  if (preview_timeout !== undefined) window.clearTimeout(preview_timeout);
  preview_timeout = window.setTimeout(() => { void request_preview(); }, preview_delay_ms);
};

const import_file = async (file: File | undefined): Promise<void> => {
  if (!file) return;
  if (!(/\.md$/i.test(file.name) || ['text/markdown', 'text/plain'].includes(file.type))) { import_feedback.textContent = 'Please choose a Markdown (.md) file.'; import_feedback.focus(); return; }
  source_input.value = await file.text();
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

const publish = (mode: 'new' | 'update'): void => { announce(publish_is_configured ? `${mode === 'new' ? 'New article publication' : 'Article update'} is ready for the configured publisher.` : 'Publishing is disabled until a local publisher is configured.', true); };

file_input.addEventListener('change', () => { void import_file(file_input.files?.[0]); });
source_input.addEventListener('input', schedule_preview);
metadata_form.addEventListener('input', schedule_preview);
workspace.addEventListener('dragover', (event) => { event.preventDefault(); workspace.classList.add('is-dropping'); });
workspace.addEventListener('dragleave', () => workspace.classList.remove('is-dropping'));
workspace.addEventListener('drop', (event) => { event.preventDefault(); workspace.classList.remove('is-dropping'); void import_file(event.dataTransfer?.files[0]); });
unresolved_images.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); });
unresolved_images.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); const image_file = [...(event.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/')); if (!image_file) { announce('Drop an image file to pair it with a local image reference.', true); return; } if (unresolved_sources.length !== 1) { announce('Choose the unresolved image target before dropping a file.', true); return; } pair_image_file(unresolved_sources[0] as string, image_file); });
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
