import { readFile as read_file } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMarkdownProcessor as create_markdown_processor } from '@astrojs/markdown-remark';
import { markdown_processor_options } from '../src/lib/markdown_preview';

const project_root = new URL('..', import.meta.url);

async function read_source_file(relative_path: string): Promise<string> {
  return read_file(new URL(relative_path, project_root), 'utf8');
}

describe('article reading experience', () => {
  it('emits stable heading IDs and source language metadata before browser enhancement', async () => {
    const renderer = await create_markdown_processor(markdown_processor_options);
    const rendered_article = await renderer.render('## Stable Heading\n\n```ts\nconst field = 1;\n```');

    expect(rendered_article.code).toContain('<h2 id="stable-heading">Stable Heading</h2>');
    expect(rendered_article.code).toContain('data-language="ts"');
  });

  it('keeps the static article structure usable while enhancing headings, code, and reading progress', async () => {
    const [article_layout_source, article_page_source, english_article_page_source, css_source] = await Promise.all([
      read_source_file('src/layouts/article_layout.astro'),
      read_source_file('src/pages/articles/[...slug].astro'),
      read_source_file('src/pages/en/articles/[...slug].astro'),
      read_source_file('src/styles/global.css'),
    ]);

    expect(article_page_source).toContain('const { Content, headings } = await render(writing_entry);');
    expect(english_article_page_source).toContain('const { Content, headings } = await render(writing_entry);');
    expect(article_layout_source).toContain('class="article_toc"');
    expect(article_layout_source).toContain('href={`#${heading.slug}`}');
    expect(article_layout_source).toContain('class="reading_progress"');
    expect(article_layout_source).toContain('navigator.clipboard.writeText');
    expect(article_layout_source).toContain('button.type = \'button\';');
    expect(article_layout_source).toContain("copy_button.dataset.copyButton = '';");
    expect(css_source).toContain('.article_body pre[data-language]::before');
    expect(css_source).toContain('.article_body pre {');
    expect(css_source).toContain('overflow-x: auto;');
    expect(css_source).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('defines a deterministic reading-time helper that excludes fenced code', async () => {
    const reading_time_source = await read_source_file('src/lib/reading_time.ts');

    expect(reading_time_source).toContain('export const calculate_reading_time');
    expect(reading_time_source).toContain('replace(/```[\\s\\S]*?```/gu');
    expect(reading_time_source).toContain("label: `${minutes} min read`");
    expect(reading_time_source).toContain("label: `预计 ${minutes} 分钟阅读`");
  });

  it('makes featured article metadata include the deterministic reading time and a technical formula fragment', async () => {
    const home_source = await read_source_file('src/pages/index.astro');

    expect(home_source).toContain("import { calculate_reading_time } from '../lib/reading_time';");
    expect(home_source).toContain('const featured_reading_time = featured_post');
    expect(home_source).toContain("calculate_reading_time(featured_post.body ?? '', featured_post.data.language)");
    expect(home_source).toContain('{featured_reading_time.label}');
    expect(home_source).toContain('class="featured_formula"');
    expect(home_source).toContain('p(y | x, I)');
  });
});
