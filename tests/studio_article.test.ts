import { describe, expect, it } from 'vitest';
import {
  discover_local_images,
  parse_studio_article,
  serialize_studio_article,
  validate_article_slug,
} from '../src/lib/studio_article';

const representative_source = `---
title: 视觉语言模型评测
description: 一篇包含公式的测试文章。
date: 2026-07-23
language: zh
draft: false
---

行内公式 $p(y \\mid x)$。

$$E = mc^2$$
`;

describe('studio_article', () => {
  it('imports frontmatter into every writing field with generated defaults', () => {
    const article = parse_studio_article(representative_source, 'vlm-evaluation');

    expect(article.metadata).toEqual({
      title: '视觉语言模型评测',
      description: '一篇包含公式的测试文章。',
      date: '2026-07-23',
      tags: [],
      language: 'zh',
      featured: false,
      draft: false,
      slug: 'vlm-evaluation',
      assets: [],
      social: { zhihu: true, wechat: true, xiaohongshu: true },
    });
  });

  it('round-trips default metadata without serializing undefined optionals', () => {
    const article = parse_studio_article(representative_source, 'vlm-evaluation');
    const serialized = serialize_studio_article(article);

    expect(serialized).not.toContain('updated: undefined');
    expect(serialized).not.toContain('translation: undefined');
    expect(serialized).not.toContain('slug:');
    expect(serialized).toContain("date: '2026-07-23'");
    expect(serialized).toContain('tags: []');
    expect(serialized).toContain('featured: false');
    expect(serialized).toContain('draft: false');
    expect(parse_studio_article(serialized, 'vlm-evaluation')).toEqual(article);
  });

  it('preserves optional writing fields and generated assets through serialization', () => {
    const article = parse_studio_article(`---
title: English title
description: English description
date: 2026-07-23
updated: 2026-07-24
tags: [AI]
language: en
translation: 中文标题
featured: true
draft: true
assets:
  - object_key: studio/figure.png
    public_url: /assets/figure.png
    source_path: /tmp/figure.png
social:
  zhihu: false
  wechat: true
  xiaohongshu: false
---

Body.`, 'english-title');

    expect(parse_studio_article(serialize_studio_article(article), 'english-title').metadata).toEqual(article.metadata);
  });

  it('requires lowercase ASCII hyphenated slugs', () => {
    expect(() => validate_article_slug('视觉-language')).toThrow(/lowercase ASCII/i);
    expect(() => validate_article_slug('VLM-Evaluation')).toThrow(/lowercase ASCII/i);
    expect(() => validate_article_slug('vlm-evaluation')).not.toThrow();
  });

  it('rejects malformed frontmatter and invalid calendar dates without timestamp normalization', () => {
    expect(() => parse_studio_article('---\ntitle: [\n---\nBody', 'broken')).toThrow(expect.objectContaining({
      name: 'studio_validation_error',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_frontmatter' })]),
    }));
    expect(() => parse_studio_article(`---
title: Invalid date
description: Date test
date: 2026-02-31
---
Body`, 'invalid-date')).toThrow(/YYYY-MM-DD/);
    expect(parse_studio_article(`---
title: Leap day
description: Date test
date: 2024-02-29
---
Body`, 'leap-day').metadata.date).toBe('2024-02-29');
  });

  it('discovers unique local Markdown images through AST nodes and definitions', () => {
    const images = discover_local_images(`![nested](images/plot(1).png)
![space](<images/a b.png>)
![reference][figure]
![duplicate](images/plot(1).png)
![remote](https://example.com/image.png)
![ftp](ftp://example.com/image.png)
![data](data:image/png;base64,abc)
![absolute](/image.png)
![protocol](//example.com/image.png)
![fragment](#figure)

[figure]: assets/figure.png

\`![inline](ignored.png)\`

\`\`\`md
![fenced](ignored-fenced.png)
\`\`\``);

    expect(images).toEqual(['images/plot(1).png', 'images/a b.png', 'assets/figure.png']);
  });

  it('uses the first normalized definition for full, collapsed, and shortcut image references', () => {
    const images = discover_local_images(`![full][Figure Name]
![collapsed][]
![shortcut]

[figure   name]: first.png
[FIGURE NAME]: ignored.png
[collapsed]: collapsed.png
[shortcut]: shortcut.png`);

    expect(images).toEqual(['first.png', 'collapsed.png', 'shortcut.png']);
  });
});
