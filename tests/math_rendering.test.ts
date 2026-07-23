import { readFile as read_file } from 'node:fs/promises';
import { resolve as resolve_path } from 'node:path';
import { describe, expect, it } from 'vitest';

const read_source = async (relative_path: string): Promise<string> => (
  read_file(resolve_path(process.cwd(), relative_path), 'utf8')
);

describe('Markdown math rendering', () => {
  it('configures KaTeX for Markdown articles and provides a public formula fixture', async () => {
    const [astro_config, global_css, fixture] = await Promise.all([
      read_source('astro.config.mjs'),
      read_source('src/styles/global.css'),
      read_source('src/content/writing/math-rendering-check.md'),
    ]);

    expect(astro_config).toContain("import remark_math from 'remark-math';");
    expect(astro_config).toContain("import rehype_katex from 'rehype-katex';");
    expect(astro_config).toContain('remarkPlugins: [remark_math]');
    expect(astro_config).toContain('rehypePlugins: [rehype_katex]');
    expect(global_css.startsWith("@import 'katex/dist/katex.min.css';")).toBe(true);
    expect(fixture).toContain('$p(y \\mid x, I)$');
    expect(fixture).toMatch(/\$\$[\s\S]*?\$\$/);
  });
});
