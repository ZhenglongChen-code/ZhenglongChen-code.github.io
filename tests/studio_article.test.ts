import { describe, expect, it } from 'vitest';
import {
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
});
