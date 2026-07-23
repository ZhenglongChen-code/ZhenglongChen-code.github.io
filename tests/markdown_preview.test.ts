import { describe, expect, it } from 'vitest';
import { render_markdown_preview } from '../src/lib/markdown_preview';

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

    expect(html).toContain('&lt;span onclick="alert(1)"&gt;$x$&lt;/span&gt;');
    expect(html).not.toContain('<span onclick=');
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
});
