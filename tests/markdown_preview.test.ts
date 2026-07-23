import { describe, expect, it } from 'vitest';
import { createMarkdownProcessor as create_markdown_processor } from '@astrojs/markdown-remark';
import { markdown_processor_options, render_markdown_preview } from '../src/lib/markdown_preview';

describe('render_markdown_preview', () => {
  it('renders inline and display math with emphasis adjacent to math', async () => {
    const html = await render_markdown_preview('**belief**$p(y \\mid x)$ and $$_{ }E = mc^2$$');

    expect(html).toContain('<strong>belief</strong>');
    expect(html).toContain('class="katex"');
  });

  it('preserves escaped dollar signs as text', async () => {
    const html = await render_markdown_preview('Price: \\$5, formula: $x$.');

    expect(html).toContain('Price: $5');
    expect(html).toContain('class="katex"');
  });

  it('preserves formula-like HTML inside code fences', async () => {
    const html = await render_markdown_preview('```html\n<span onclick="alert(1)">$x$</span>\n```');

    expect(html).toContain('onclick');
    expect(html).not.toContain('<span onclick=');
  });

  it('rejects malformed LaTeX with a typed validation issue', async () => {
    await expect(render_markdown_preview('$\\frac{1}{$')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'invalid_math', field: 'markdown' }],
    });
  });

  it('rejects an unterminated display math delimiter without leaking its formula', async () => {
    await expect(render_markdown_preview('$$\\frac{1}{2}')).rejects.toMatchObject({
      name: 'studio_validation_error',
      message: 'Markdown contains invalid LaTeX.',
      issues: [{ code: 'invalid_math', field: 'markdown' }],
    });
  });

  it('rejects unmatched inline markers while leaving escaped dollars and code inert', async () => {
    await expect(render_markdown_preview('$x')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'invalid_math', field: 'markdown' }],
    });
    await expect(render_markdown_preview('$')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'invalid_math', field: 'markdown' }],
    });
    await expect(render_markdown_preview('Price: \\$5.')).resolves.toContain('Price: $5.');
    await expect(render_markdown_preview('`$x`\n\n```tex\n$$\\frac{1}{2}\n```')).resolves.toContain('<code');
  });

  it('rejects executable raw HTML instead of silently removing it', async () => {
    await expect(render_markdown_preview('<img src=x onerror="alert(1)">')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
  });

  it('rejects raw HTML styles outside the KaTeX renderer output', async () => {
    await expect(render_markdown_preview('<div style="background-image:url(javascript:alert(1))">x</div>')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
  });

  it('rejects entity-obfuscated executable URLs instead of stripping them', async () => {
    await expect(render_markdown_preview('<a href="jav&#x61;script:alert(1)">x</a>')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
  });

  it('preserves complex KaTeX MathML and SVG output', async () => {
    const html = await render_markdown_preview('$$\\sqrt{x}+\\overline{y}+\\underbrace{z}_{q}$$');

    expect(html).toContain('<msqrt>');
    expect(html).toContain('<mover');
    expect(html).toContain('<munder');
    expect(html).toContain('<svg');
    expect(html).toContain('<path');
  });

  it('rejects bare unsafe HTML attributes and whitespace-obfuscated executable URLs', async () => {
    await expect(render_markdown_preview('<img src=x onerror>')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
    await expect(render_markdown_preview('<a href="java\tscript:alert(1)">x</a>')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
  });

  it('keeps tilde and longer indented backtick fences inert', async () => {
    const html = await render_markdown_preview('   ~~~~html\n<img src=x onerror>\n   ~~~~\n\n   ````html\n<a href="javascript:alert(1)">x</a>\n   ````');

    expect(html).toContain('onerror');
    expect(html).toContain('javascript:alert(1)');
  });

  it('preserves cancel, boxed, and uncommon KaTeX MathML/SVG output', async () => {
    const html = await render_markdown_preview('$\\cancel{x}+\\boxed{y}+\\color{red}{z}$');

    expect(html).toContain('<menclose');
    expect(html).toContain('<svg');
    expect(html).toContain('<line');
    expect(html).toContain('mathcolor');
  });

  it('rejects executable Markdown links before rendering', async () => {
    await expect(render_markdown_preview('[unsafe](javascript:alert(1))')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
  });

  it('rejects unsafe reference-style link and image destinations', async () => {
    await expect(render_markdown_preview('[unsafe][target]\n\n[target]: javascript:alert(1)')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
    await expect(render_markdown_preview('![unsafe][image]\n\n[image]: data:image/svg+xml,evil')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
    await expect(render_markdown_preview('[safe][]\n\n[safe]: /articles/safe')).resolves.toContain('href="/articles/safe"');
  });

  it('rejects raw HTML declarations and orphan closing tags without rewriting them', async () => {
    await expect(render_markdown_preview('<!doctype html>')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
    await expect(render_markdown_preview('</div>')).rejects.toMatchObject({
      name: 'studio_validation_error',
      issues: [{ code: 'unsafe_html' }],
    });
  });

  it('matches Astro rendering for headings, code fences, and multiline display math', async () => {
    const source = '# Preview heading\n\n```ts\nconst value = 1;\n```\n\n$$\nE = mc^2\n$$';
    const astro_renderer = await create_markdown_processor(markdown_processor_options);
    const astro_html = (await astro_renderer.render(source)).code;
    const studio_html = await render_markdown_preview(source);

    expect(studio_html).toBe(astro_html);
    expect(studio_html).toContain('id="preview-heading"');
    expect(studio_html).toContain('<code');
    expect(studio_html).toContain('katex-display');
  });
});
