import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

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

  test('keeps Studio local-only and excludes generated artifacts', () => {
    const main = read_source('studio/src/main.ts');
    const vite = read_source('studio/vite.config.ts');
    const package_json = read_source('package.json');
    const gitignore = read_source('.gitignore');

    expect(main).toContain("latent_field_studio_draft_v1");
    expect(main).toContain("'/api/preview'");
    expect(main).toContain('server-sanitized');
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
});
