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

    expect(html).toContain('&#x3C;span onclick="alert(1)">$x$&#x3C;/span>');
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

    expect(html).toContain('&#x3C;img src=x onerror>');
    expect(html).toContain('&#x3C;a href="javascript:alert(1)">x&#x3C;/a>');
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
});
