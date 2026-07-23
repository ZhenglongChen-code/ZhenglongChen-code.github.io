import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { render_markdown_preview } from '../src/lib/markdown_preview';
import { discover_local_images, parse_studio_article } from '../src/lib/studio_article';
import { feedback_should_focus, is_current_import, is_latest_preview, next_import_sequence, next_tab_index, normalize_article_metadata, publication_feedback, publication_intent_key, publication_request_for_intent, reconcile_image_pairs, safe_storage_get, safe_storage_remove, safe_storage_set } from '../studio/src/main';
import { create_attention_map } from './fixtures/studio/create_attention_map';

const read_source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('local markdown studio UI contract', () => {
  test('provides an accessible Markdown import and editing workbench', () => {
    const html = read_source('studio/index.html');

    expect(html).toMatch(/<input[^>]+type="file"[^>]+accept="\.md,text\/markdown,text\/plain"[^>]+aria-label="Import Markdown file"/);
    expect(html).toContain('aria-label="Markdown source"');
    expect(html).toContain('id="article-slug"');
    expect(html).toContain('English slug');
    for (const field of ['title', 'description', 'date', 'updated', 'tags', 'language', 'translation', 'featured', 'draft', 'assets', 'zhihu', 'wechat', 'xiaohongshu']) {
      expect(html).toContain(`article-${field}`);
    }
    expect(html).toMatch(/<section[^>]+id="preview-panel"[^>]+role="tabpanel"/);
    expect(html).toContain('id="unresolved-images"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Publish new article');
    expect(html).toContain('Update existing article');
  });

  test('uses the exact Paper Index design tokens and keeps code monospace scoped', () => {
    const global_css = read_source('src/styles/global.css');
    const studio_css = read_source('studio/src/studio.css');

    for (const token of ['--paper: #f3efe6', '--ink: #181815', '--muted: #6c6962', '--rule: rgba(24, 24, 21, .18)', '--cobalt: #1649c2', '--vermilion: #b53325', '--serif: Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif', '--sans: Avenir Next, Avenir, Helvetica Neue, sans-serif', '--mono: SFMono-Regular, Consolas, Liberation Mono, monospace']) {
      expect(global_css).toContain(token);
      expect(studio_css).toContain(token);
    }
    expect(studio_css).toMatch(/body[^}]+font-family: var\(--sans\)/);
    expect(studio_css).toMatch(/#markdown-source[^}]+font-family: var\(--mono\)/);
  });

  test('visually hides each native image chooser while retaining its custom control', () => {
    const main = read_source('studio/src/main.ts');
    const studio_css = read_source('studio/src/studio.css');

    expect(main).toContain("image_input.type = 'file'");
    expect(main).toContain("select_image.addEventListener('click', () => image_input.click())");
    expect(studio_css).toContain('.image-item input[type="file"] { clip: rect(0 0 0 0); height: 1px; overflow: hidden; position: absolute; width: 1px; }');
  });

  test('uses roving tab logic and ignores stale preview responses', () => {
    expect(next_tab_index(0, 'ArrowRight', 2)).toBe(1);
    expect(next_tab_index(0, 'ArrowLeft', 2)).toBe(1);
    expect(next_tab_index(1, 'ArrowRight', 2)).toBe(0);
    expect(next_tab_index(0, 'Enter', 2)).toBe(0);
    expect(is_latest_preview(2, 1)).toBe(false);
    expect(is_latest_preview(2, 2)).toBe(true);
  });

  test('keeps Studio local-only and excludes generated artifacts', () => {
    const main = read_source('studio/src/main.ts');
    const vite = read_source('studio/vite.config.ts');
    const package_json = read_source('package.json');
    const gitignore = read_source('.gitignore');

    expect(main).toContain("latent_field_studio_draft_v1");
    expect(main).toContain("'/api/preview'");
    expect(main).toContain('server-sanitized');
    expect(main).toContain('new Map<string, File>()');
    expect(main).toContain("image_input.accept = 'image/jpeg,image/png'");
    expect(main).toContain("row.dataset.sourcePath = source_path");
    expect(main).toContain("row.addEventListener('drop'");
    expect(main).toContain('AbortController');
    expect(main).toContain('preview_sequence');
    expect(main).toContain('image_files');
    expect(main).toContain('image_files.clear()');
    expect(main).toContain('import_sequence');
    expect(main).not.toContain("./studio_logic");
    expect(vite).toContain("root: 'studio'");
    expect(vite).toContain("outDir: 'dist'");
    expect(vite).toContain('emptyOutDir: true');
    expect(package_json).toContain('vite build --config studio/vite.config.ts');
    expect(package_json).toContain('vite --config studio/vite.config.ts --host 127.0.0.1 --port 4317');
    expect(gitignore).toContain('studio/dist/');
    expect(gitignore).toContain('.studio/');
    expect(gitignore).toContain('.env.studio.local');
    expect(existsSync(resolve(process.cwd(), 'src/pages/studio.astro'))).toBe(false);
    expect(existsSync(resolve(process.cwd(), 'src/pages/studio/index.astro'))).toBe(false);
  });

  test('keeps the session token in memory and wires protocol publication requests', () => {
    const main = read_source('studio/src/main.ts');

    expect(main).toContain("fetch('/api/session'");
    expect(main).toContain("fetch('/api/config'");
    expect(main).toContain('crypto.randomUUID().toLowerCase()');
    expect(main).toContain("'x-studio-token': session_token");
    expect(main).toContain("fetch('/api/publish'");
    expect(main).toContain('bytes_base64');
    expect(main).toContain('expected_source_hash');
    expect(main).toContain('publish_update.disabled = !publish_is_configured || !expected_source_hash || publish_in_flight');
    const draft_type = main.slice(main.indexOf('type studio_draft'), main.indexOf('type storage_adapter'));
    expect(draft_type).not.toContain('session_token');
    expect(main).not.toContain("safe_storage_set(get_storage(), 'session_token'");
  });

  test('reuses a pending publication request ID only for the identical publication intent', () => {
    const metadata = normalize_article_metadata({ title: 'Stable request', date: '2026-07-23', slug: 'stable-request' });
    const intent = { mode: 'new' as const, markdown: '# Stable request', metadata, expected_source_hash: undefined, images: [{ source_path: './diagram.png', file_name: 'diagram.png', file_size: 42, file_last_modified: 1, file_type: 'image/png', intent: 'diagram' as const }] };
    let created = 0;
    const create_request_id = (): string => `request-${++created}`;

    const first_request = publication_request_for_intent(undefined, publication_intent_key(intent), create_request_id);
    const retry_request = publication_request_for_intent(first_request, publication_intent_key(intent), create_request_id);
    const changed_markdown = publication_request_for_intent(first_request, publication_intent_key({ ...intent, markdown: '# Edited request' }), create_request_id);
    const changed_metadata = publication_request_for_intent(first_request, publication_intent_key({ ...intent, metadata: { ...metadata, title: 'Edited request' } }), create_request_id);
    const changed_image = publication_request_for_intent(first_request, publication_intent_key({ ...intent, images: [{ ...intent.images[0]!, file_last_modified: 2 }] }), create_request_id);
    const changed_mode = publication_request_for_intent(first_request, publication_intent_key({ ...intent, mode: 'update', expected_source_hash: 'a'.repeat(64) }), create_request_id);

    expect(first_request.request_id).toBe('request-1');
    expect(retry_request).toEqual(first_request);
    expect(changed_markdown.request_id).toBe('request-2');
    expect(changed_metadata.request_id).toBe('request-3');
    expect(changed_image.request_id).toBe('request-4');
    expect(changed_mode.request_id).toBe('request-5');
  });

  test('keeps an unresolved publication transaction only in memory and invalidates it for editor changes', () => {
    const main = read_source('studio/src/main.ts');
    const draft_type = main.slice(main.indexOf('type studio_draft'), main.indexOf('type storage_adapter'));
    const schedule_start = main.indexOf('const schedule_preview');
    const pair_image_start = main.indexOf('const pair_image_file');
    const publish_start = main.indexOf('const publish');

    expect(draft_type).not.toContain('request_id');
    expect(main).toContain('let pending_publication');
    expect(main).toContain('const clear_pending_publication_request');
    expect(main.indexOf('clear_pending_publication_request();', schedule_start)).toBeGreaterThan(schedule_start);
    expect(main.indexOf('clear_pending_publication_request();', pair_image_start)).toBeGreaterThan(pair_image_start);
    expect(main.indexOf('publication_request_for_intent(', publish_start)).toBeGreaterThan(publish_start);
    expect(main.indexOf('clear_pending_publication_request();', publish_start)).toBeGreaterThan(publish_start);
  });

  test('drops stale image pairings and keeps only currently referenced images in source order', () => {
    const files = new Map<string, File>([['old.png', new File(['a'], 'old.png', { type: 'image/png' })], ['current.jpg', new File(['b'], 'current.jpg', { type: 'image/jpeg' })]]);
    const intents = new Map<string, 'photo' | 'screenshot' | 'diagram'>([['old.png', 'diagram'], ['current.jpg', 'photo']]);
    const urls = { 'old.png': 'https://assets.example/old.png', 'current.jpg': 'https://assets.example/current.jpg' };
    const result = reconcile_image_pairs(['current.jpg'], files, intents, urls);
    expect([...result.files.keys()]).toEqual(['current.jpg']);
    expect([...result.intents.entries()]).toEqual([['current.jpg', 'photo']]);
    expect(result.urls).toEqual({ 'current.jpg': 'https://assets.example/current.jpg' });
  });

  test('maps structured publication errors to actionable fixed text', () => {
    expect(publication_feedback({ kind: 'failed', errors: [{ code: 'stale_source', field: 'slug', message: 'secret path' }] })).toContain('changed since it was loaded');
    expect(publication_feedback({ kind: 'recovery_required', errors: [{ code: 'git_ambiguous', message: 'secret path' }] })).toContain('Git: inspect the local Git state');
  });

  test('classifies every safe publication recovery category without reflecting server text', () => {
    const feedback = publication_feedback({ kind: 'failed', errors: [
      { code: 'invalid_metadata', field: 'metadata.title', message: 'secret validation' },
      { code: 'image_collision', message: 'secret image path' },
      { code: 'target_dirty', message: 'secret git state' },
      { code: 'wrong_branch', message: 'secret branch' },
      { code: 'request_claimed', message: 'secret journal' },
      { code: 'unknown_code', field: '<script>', message: 'secret fallback' },
    ] });
    for (const phrase of ['Validation', 'Image upload', 'local modifications', 'Git', 'Transaction recovery', 'local review']) expect(feedback).toContain(phrase);
    expect(feedback).toContain('metadata.title');
    expect(feedback).not.toContain('secret');
    expect(feedback).not.toContain('<script>');
  });

  test('invalidates an in-flight preview before the next debounce window', () => {
    const main = read_source('studio/src/main.ts');
    const schedule_start = main.indexOf('const schedule_preview');
    const abort_position = main.indexOf('preview_controller?.abort()', schedule_start);
    const timeout_position = main.indexOf('window.setTimeout', schedule_start);

    expect(abort_position).toBeGreaterThan(schedule_start);
    expect(timeout_position).toBeGreaterThan(abort_position);
    expect(is_latest_preview(4, 3)).toBe(false);
  });

  test('keeps routine preview failures in the live region without stealing editor focus', () => {
    const main = read_source('studio/src/main.ts');

    expect(feedback_should_focus('preview_failure')).toBe(false);
    expect(feedback_should_focus('import')).toBe(true);
    expect(main).toContain("announce('Preview unavailable. Your local draft remains intact.');");
  });

  test('normalizes a fresh document and accepts only the newest import', () => {
    expect(next_import_sequence(4)).toBe(5);
    expect(is_current_import(5, 4)).toBe(false);
    expect(is_current_import(5, 5)).toBe(true);
    expect(normalize_article_metadata({ title: 'Fresh', date: '2026-07-23' })).toMatchObject({ title: 'Fresh', date: '2026-07-23', updated: '', translation: '', assets: [], draft: false });
  });

  test('contains storage adapter failures without interrupting Studio initialization', () => {
    const denied_storage = {
      getItem: (): string => { throw new Error('denied'); },
      setItem: (): void => { throw new Error('denied'); },
      removeItem: (): void => { throw new Error('denied'); },
    };

    expect(safe_storage_get(denied_storage, 'draft')).toBeNull();
    expect(safe_storage_set(denied_storage, 'draft', 'value')).toBe(false);
    expect(safe_storage_remove(denied_storage, 'draft')).toBe(false);
  });

  test('keeps the 320px layout within its viewport', () => {
    const studio_css = read_source('studio/src/studio.css');

    expect(studio_css).toContain('.studio-grid, .metadata-rail, .workbench, .workspace-panels, .editor-panel, .preview-panel { min-width: 0; max-width: 100%; }');
    expect(studio_css).toContain('.workbench { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr);');
    expect(studio_css).toContain('.workbench-topline { align-items: flex-start; flex-wrap: wrap;');
    expect(studio_css).toContain('.quiet-feedback { min-width: 0; overflow-wrap: anywhere;');
  });

  test('bundles KaTeX and bounds rendered math or code without external favicon requests', () => {
    const main = read_source('studio/src/main.ts');
    const studio_css = read_source('studio/src/studio.css');
    const studio_html = read_source('studio/index.html');
    const base_layout = read_source('src/layouts/base_layout.astro');

    expect(main).toContain("import 'katex/dist/katex.min.css';");
    expect(studio_css).toContain('.markdown-preview .katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; }');
    expect(studio_css).toContain('.markdown-preview pre { max-width: 100%; overflow-x: auto; }');
    expect(studio_html).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(base_layout).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
  });

  test('clears prior proof only when a newest import is ready to apply', () => {
    const main = read_source('studio/src/main.ts');
    const reset_start = main.indexOf('const reset_document_state');
    const preview_clear = main.indexOf("preview_container.replaceChildren()", reset_start);
    const import_start = main.indexOf('const import_file');
    const current_import_check = main.indexOf('if (!is_current_import(import_sequence, file_sequence)) return;', import_start);
    const reset_call = main.indexOf('reset_document_state();', import_start);

    expect(preview_clear).toBeGreaterThan(reset_start);
    expect(current_import_check).toBeGreaterThan(import_start);
    expect(reset_call).toBeGreaterThan(current_import_check);
  });

  test('creates a deterministic attention-map fixture only inside the caller temporary root', async () => {
    const fixture_root = await mkdtemp(join(tmpdir(), 'latent-field-studio-fixture-'));
    const outside_root = await mkdtemp(join(tmpdir(), 'latent-field-studio-outside-'));
    try {
      const first_path = await create_attention_map(fixture_root);
      const first_bytes = await readFile(first_path);
      const second_path = await create_attention_map(fixture_root, join(fixture_root, 'second.png'));
      const second_bytes = await readFile(second_path);

      expect(first_path).toBe(join(fixture_root, 'attention-map.png'));
      expect(first_bytes).toEqual(second_bytes);
      await expect(create_attention_map(fixture_root, join(outside_root, 'escaped.png'))).rejects.toThrow(/temporary root/i);

      const linked_directory = join(fixture_root, 'linked');
      await symlink(outside_root, linked_directory);
      await expect(create_attention_map(fixture_root, join(linked_directory, 'escaped.png'))).rejects.toThrow(/symbolic link/i);
    } finally {
      await rm(fixture_root, { recursive: true, force: true });
      await rm(outside_root, { recursive: true, force: true });
    }
  });

  test('checks generated public artifacts for Studio and source-map leakage', () => {
    const checker = read_source('scripts/check_site.mjs');

    for (const forbidden_artifact of ['.env.studio.local', '.studio/transactions', 'session_token', '/api/', 'source map']) {
      expect(checker).toContain(forbidden_artifact);
    }
  });

  test('ships the importable Markdown fixture with formulas, escaped currency, code, and a local image', async () => {
    const fixture = read_source('tests/fixtures/studio/article-with-math.md');
    const article = parse_studio_article(fixture, 'attention-map-preview');
    const preview_html = await render_markdown_preview(article.body);

    expect(fixture).toContain('$p(y \\mid x)$');
    expect(fixture).toContain('\\$5.00');
    expect(fixture).toContain('![注意力图](./attention-map.png)');
    expect(article.metadata.title).toBe('注意力图的本地预览');
    expect(discover_local_images(article.body)).toEqual(['./attention-map.png']);
    expect(preview_html).toContain('class="katex"');
    expect(preview_html).toContain('formula_like = $not_rendered_inside_a_fence$');
    expect(preview_html).not.toContain('<script>');
  });
});
