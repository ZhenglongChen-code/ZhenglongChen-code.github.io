import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const project_root = new URL('..', import.meta.url);

async function read_source_file(relative_path: string): Promise<string> {
  return readFile(new URL(relative_path, project_root), 'utf8');
}

describe('Latent Field brand contract', () => {
  test('defines the masthead and public identity', async () => {
    const [header_source, home_source] = await Promise.all([
      read_source_file('src/components/site_header.astro'),
      read_source_file('src/pages/index.astro'),
    ]);

    expect(header_source).toContain('LATENT FIELD');
    expect(header_source).toContain('ZHENGLONG CHEN · RESEARCH NOTES');
    expect(home_source).toContain('Zhenglong Chen');
    expect(home_source).toContain('VLM Algorithm Engineer');
  });

  test('sets the exact approved Paper Index palette and type stacks', async () => {
    const css_source = await read_source_file('src/styles/global.css');

    expect(css_source).toContain('--paper: #f3efe6');
    expect(css_source).toContain('--ink: #181815');
    expect(css_source).toContain('--muted: #6c6962');
    expect(css_source).toContain('--rule: rgba(24, 24, 21, .18)');
    expect(css_source).toContain('--cobalt: #1649c2');
    expect(css_source).toContain('--vermilion: #b53325');
    expect(css_source).toContain('--serif: Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif');
    expect(css_source).toContain('--sans: Avenir Next, Avenir, Helvetica Neue, sans-serif');
  });

  test('uses the Paper Index document frame', async () => {
    const base_layout_source = await read_source_file('src/layouts/base_layout.astro');

    expect(base_layout_source).toContain('class="paper_index"');
    expect(base_layout_source).toContain('Latent Field | Zhenglong Chen');
  });
});
