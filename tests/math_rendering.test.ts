import { readFile as read_file } from 'node:fs/promises';
import { resolve as resolve_path } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { createMarkdownProcessor as create_markdown_processor } from '@astrojs/markdown-remark';
import { markdown_processor_options } from '../src/lib/markdown_preview';
import { get_public_posts } from '../src/lib/content';

const math_fixture = [
  'Inline math: $p(y \\mid x, I)$.',
  '',
  '$$',
  'p(y_{1:n} \\mid x, I) = \\prod_{t=1}^{n} p(y_t \\mid y_{<t}, x, I)',
  '$$',
].join('\n');

const read_source = async (relative_path: string): Promise<string> => (
  read_file(resolve_path(process.cwd(), relative_path), 'utf8')
);

describe('Markdown math rendering', () => {
  it('renders an isolated formula fixture with the configured Astro processor', async () => {
    const [astro_config_source, article_layout, global_css, package_json] = await Promise.all([
      read_source('astro.config.mjs'),
      read_source('src/layouts/article_layout.astro'),
      read_source('src/styles/global.css'),
      read_source('package.json'),
    ]);
    const renderer = await create_markdown_processor(markdown_processor_options);
    const rendered_fixture = await renderer.render(math_fixture);
    const dependencies = JSON.parse(package_json) as { dependencies: Record<string, string> };

    expect(astro_config_source).toContain("import { markdown_processor_options } from './src/lib/markdown_preview';");
    expect(astro_config_source).toContain('markdown: markdown_processor_options');
    expect(article_layout).toContain("import 'katex/dist/katex.min.css';");
    expect(global_css).not.toContain("katex/dist/katex.min.css");
    expect(dependencies.dependencies.katex).toBe('0.16.47');
    expect(math_fixture).toContain('$p(y \\mid x, I)$');
    expect(math_fixture).toMatch(/\$\$[\s\S]*?\$\$/);
    expect(rendered_fixture.code).toContain('class="katex"');
    expect(rendered_fixture.code).toContain('<math');
    expect(rendered_fixture.code).not.toContain('$$');
  });

  it('keeps the diagnostic formula article out of public collections', async () => {
    const fixture = await read_source('src/content/writing/math-rendering-check.md');
    const parsed_fixture = matter(fixture);
    const public_posts = get_public_posts([
      {
        id: 'math-rendering-check',
        data: { date: new Date('2026-07-23'), draft: parsed_fixture.data.draft === true },
      },
    ]);

    expect(parsed_fixture.data.draft).toBe(true);
    expect(public_posts).toEqual([]);
  });
});
