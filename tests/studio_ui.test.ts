import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { feedback_should_focus, is_current_import, is_latest_preview, next_import_sequence, next_tab_index, normalize_article_metadata, safe_storage_get, safe_storage_remove, safe_storage_set } from '../studio/src/main';

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
    expect(main).toContain("image_input.accept = 'image/*'");
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
    expect(read_source('studio/src/studio.css')).toContain('.studio-grid, .metadata-rail, .workbench, .workspace-panels, .editor-panel, .preview-panel { min-width: 0; max-width: 100%; }');
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
});
