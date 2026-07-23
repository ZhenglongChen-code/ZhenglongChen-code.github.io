import { describe, expect, it } from 'vitest';
import {
  format_wechat_html,
  format_xiaohongshu,
  format_zhihu,
  type social_article,
} from '../src/lib/social_export';

const article: social_article = {
  title: '为长期写作建一个自己的家',
  description: '为什么我选择把个人网站作为内容源头，再把文章带到不同平台。',
  tags: ['写作', '独立网站'],
  canonical_url: 'http://106.14.173.234/articles/building-a-writing-home',
  markdown: '# 起点\n\n这是正文。',
};

describe('social article formatters', () => {
  it('uses the exact article metadata and Markdown supplied by the exporter', () => {
    expect(article).toEqual({
      title: '为长期写作建一个自己的家',
      description: '为什么我选择把个人网站作为内容源头，再把文章带到不同平台。',
      tags: ['写作', '独立网站'],
      canonical_url: 'http://106.14.173.234/articles/building-a-writing-home',
      markdown: '# 起点\n\n这是正文。',
    });
  });

  it('appends the canonical source to the original Markdown for Zhihu', () => {
    expect(format_zhihu(article)).toBe(
      '# 起点\n\n这是正文。\n\n---\n\n原文：http://106.14.173.234/articles/building-a-writing-home\n',
    );
  });

  it('preserves every original Markdown character before the Zhihu suffix', () => {
    const original_markdown = '  indented opening\nline with a hard break  \n\n';
    const whitespace_article: social_article = {
      ...article,
      markdown: original_markdown,
    };

    const output = format_zhihu(whitespace_article);

    expect(output.startsWith(original_markdown)).toBe(true);
    expect(output).toBe(
      `${original_markdown}\n\n---\n\n原文：http://106.14.173.234/articles/building-a-writing-home\n`,
    );
  });

  it('creates a self-contained inline-styled WeChat section', () => {
    const output = format_wechat_html(article);

    expect(output).toContain('<section style=');
    expect(output).toContain('<h1 style=');
    expect(output).not.toContain('<script');
    expect(output).not.toContain('<link');
  });

  it('preserves LaTeX source across manual social formats without unsafe WeChat markup', () => {
    const math_article: social_article = {
      ...article,
      markdown: '行内公式 $p(y \\mid x)$。\n\n$$E = mc^2$$',
    };

    const zhihu_output = format_zhihu(math_article);
    const wechat_output = format_wechat_html(math_article);
    const xiaohongshu_output = format_xiaohongshu(math_article);

    expect(zhihu_output).toContain('$p(y \\mid x)$');
    expect(zhihu_output).toContain('$$E = mc^2$$');
    expect(wechat_output).toContain('$p(y \\mid x)$');
    expect(wechat_output).toContain('$$E = mc^2$$');
    expect(wechat_output).toContain('http://106.14.173.234/articles/building-a-writing-home');
    expect(wechat_output).not.toMatch(/<(script|style|link|iframe|object|embed)\b/i);
    expect(xiaohongshu_output).toContain('p(y \\mid x)');
    expect(xiaohongshu_output).toContain('E = mc^2');
    expect(Array.from(xiaohongshu_output).length).toBeLessThanOrEqual(1000);
    expect(zhihu_output).toContain('http://106.14.173.234/articles/building-a-writing-home');
  });

  it('preserves complex inline and block TeX source without Markdown reinterpretation', () => {
    const sentinel_like_text = '\uE000social-math-0\uE0010\uE002';
    const math_article: social_article = {
      ...article,
      markdown: [
        `$a **b** c$ and $x \\* y$ ${sentinel_like_text}`,
        '',
        '$$',
        'E = mc^2',
        '$$',
        '',
        '价格是 \\$100。',
      ].join('\n'),
    };

    const wechat_output = format_wechat_html(math_article);
    const xiaohongshu_output = format_xiaohongshu(math_article);

    for (const output of [wechat_output, xiaohongshu_output]) {
      expect(output).toContain('$a **b** c$');
      expect(output).toContain('$x \\* y$');
      expect(output).toContain('$$\nE = mc^2\n$$');
      expect(output).toContain(sentinel_like_text);
    }
    expect(xiaohongshu_output).toContain('价格是 $100。');
    expect(wechat_output).not.toContain('<strong>');
  });

  it('never splits a family emoji grapheme while fitting Xiaohongshu output', () => {
    const family_emoji = '👨‍👩‍👧‍👦';
    const emoji_article: social_article = {
      ...article,
      markdown: family_emoji.repeat(200),
    };

    const output = format_xiaohongshu(emoji_article);
    const emoji_remainder = output.replaceAll(family_emoji, '');
    const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });

    expect(Array.from(segmenter.segment(output)).length).toBeLessThanOrEqual(1000);
    expect(emoji_remainder).not.toMatch(/[👨👩👧👦]/u);
  });

  it('rejects hostile canonical URLs at every public formatter boundary', () => {
    const hostile_article: social_article = {
      ...article,
      canonical_url: 'javascript:alert(1)',
    };

    expect(() => format_zhihu(hostile_article)).toThrow(/canonical.*http/i);
    expect(() => format_wechat_html(hostile_article)).toThrow(/canonical.*http/i);
    expect(() => format_xiaohongshu(hostile_article)).toThrow(/canonical.*http/i);

    const credentialed_article: social_article = {
      ...article,
      canonical_url: 'https://user:secret@example.test/articles/post',
    };

    expect(() => format_wechat_html(credentialed_article)).toThrow(/canonical.*credential/i);
  });

  it('does not duplicate an existing canonical source across social formats', () => {
    const source_markdown = `[原文](${article.canonical_url})`;
    const sourced_article: social_article = { ...article, markdown: source_markdown };
    const url_pattern = new RegExp(article.canonical_url, 'gu');

    const zhihu_output = format_zhihu(sourced_article);
    const wechat_output = format_wechat_html(sourced_article);
    const xiaohongshu_output = format_xiaohongshu(sourced_article);

    expect(zhihu_output.match(url_pattern)).toHaveLength(1);
    expect(wechat_output.match(url_pattern)).toHaveLength(1);
    expect(xiaohongshu_output.match(url_pattern)).toHaveLength(1);
  });

  it('removes unsafe raw HTML, event handlers, and JavaScript URLs from WeChat HTML', () => {
    const unsafe_article: social_article = {
      ...article,
      markdown: [
        '<script>alert(1)</script>',
        '<style>body{display:none}</style>',
        '<link rel="stylesheet" href="https://example.com/a.css">',
        '<iframe src="https://example.com"></iframe>',
        '<object data="https://example.com"></object>',
        '<embed src="https://example.com">',
        '<p onclick="alert(1)"><a href="javascript:alert(1)" onmouseover="alert(2)">safe label</a></p>',
      ].join('\n'),
    };

    const output = format_wechat_html(unsafe_article).toLowerCase();

    expect(output).not.toMatch(/<(script|style|link|iframe|object|embed)\b/);
    expect(output).not.toMatch(/\son[a-z]+=/);
    expect(output).not.toContain('javascript:');
    expect(output).toContain('safe label');
  });

  it('rejects unclosed unsafe raw Markdown before formatting WeChat output', () => {
    const unsafe_article: social_article = {
      ...article,
      markdown: [
        '$$E = mc^2$$',
        '',
        '<script>unclosed unsafe content',
        '$p(y \\mid x)$',
      ].join('\n'),
    };

    expect(() => format_wechat_html(unsafe_article)).toThrow(/unclosed.*script/i);
  });

  it('creates deduplicated sanitized Xiaohongshu topics', () => {
    const tagged_article: social_article = {
      ...article,
      tags: ['写作', ' 写作 ', '#独立 网站', 'AI/工具', '!!!'],
    };

    const output = format_xiaohongshu(tagged_article);

    expect(output).toContain('#写作');
    expect(output.match(/#写作/g)).toHaveLength(1);
    expect(output).toContain('#独立网站');
    expect(output).toContain('#AI工具');
    expect(output).not.toContain('#!!!');
  });

  it('strips Markdown and raw HTML from the Xiaohongshu body', () => {
    const markdown_article: social_article = {
      ...article,
      markdown: '## **标题**\n\n<a href="https://example.com">链接</a> `代码` ![图](image.png)',
    };

    const output = format_xiaohongshu(markdown_article);

    expect(output).toContain('标题 链接 代码 图');
    expect(output).not.toMatch(/[<>{}`!*\[\]]/);
  });

  it('renders an image with balanced destination parentheses as alt text only', () => {
    const image_article: social_article = {
      ...article,
      markdown: 'Before ![alt](https://x.test/a_(b).png) after.',
    };

    const output = format_xiaohongshu(image_article);

    expect(output).toContain('Before alt after.');
    expect(output).not.toContain('https://x.test');
    expect(output).not.toContain('a_(b).png');
  });

  it('keeps image-like syntax literal inside inline and fenced code', () => {
    const code_article: social_article = {
      ...article,
      markdown: [
        '`![inline](inline.png)`',
        '',
        '```md',
        '![fenced](fenced.png)',
        '```',
      ].join('\n'),
    };

    const output = format_xiaohongshu(code_article);

    expect(output).toContain('![inline](inline.png)');
    expect(output).toContain('![fenced](fenced.png)');
  });

  it('retains a plain-text separator for Markdown hard breaks', () => {
    const hard_break_article: social_article = {
      ...article,
      markdown: 'first  \nsecond',
    };

    expect(format_xiaohongshu(hard_break_article)).toContain('first second');
  });

  it('normalizes topics to NFC and retains Unicode combining marks', () => {
    const unicode_topic_article: social_article = {
      ...article,
      tags: ['cafe\u0301', 'café', 'हिन्दी'],
    };

    const output = format_xiaohongshu(unicode_topic_article);

    expect(output.match(/#café/gu)).toHaveLength(1);
    expect(output).toContain('#हिन्दी');
    expect(output).not.toContain('#cafe');
  });

  it('decodes named, decimal, and hexadecimal HTML entities in Xiaohongshu text', () => {
    const entity_article: social_article = {
      ...article,
      markdown: 'A &amp; B, &lt;safe&gt;, &#169;, &#x1F600;. <script>&amp; hidden</script>',
    };

    const output = format_xiaohongshu(entity_article);

    expect(output).toContain('A & B, <safe>, ©, 😀.');
    expect(output).not.toContain('&amp;');
    expect(output).not.toContain('hidden');
    expect(output).not.toContain('<script');
  });

  it('truncates Unicode without splitting surrogate pairs and keeps final output within 1000 characters', () => {
    const long_article: social_article = {
      ...article,
      markdown: `开始${'😀'.repeat(900)}结束`,
      tags: Array.from({ length: 80 }, (_value, index) => `标签${index}`),
    };

    const output = format_xiaohongshu(long_article);

    expect(Array.from(output).length).toBeLessThanOrEqual(1000);
    expect(output).not.toContain('\ufffd');
    expect(Array.from(output).every((character) => {
      const code_unit = character.charCodeAt(0);
      return code_unit < 0xd800 || code_unit > 0xdfff || character.length === 2;
    })).toBe(true);
  });

  it('keeps a long accepted canonical URL intact while dynamically fitting optional sections', () => {
    const canonical_url = `https://example.com/writing/${'路'.repeat(850)}`;
    const long_canonical_article: social_article = {
      ...article,
      title: `标题${'😀'.repeat(100)}`,
      description: '描述'.repeat(100),
      markdown: '正文'.repeat(500),
      canonical_url,
      tags: ['写作', '独立网站', '超长测试'],
    };

    const output = format_xiaohongshu(long_canonical_article);

    expect(output).toContain(`原文：${canonical_url}`);
    expect(Array.from(output).length).toBeLessThanOrEqual(1000);
    expect(Array.from(output).some((character) => (
      character.charCodeAt(0) >= 0xd800
      && character.charCodeAt(0) <= 0xdfff
      && character.length === 1
    ))).toBe(false);
  });

  it('rejects a canonical line that cannot fit within the Xiaohongshu limit', () => {
    const overlong_canonical_article: social_article = {
      ...article,
      canonical_url: `https://example.com/${'a'.repeat(990)}`,
    };

    expect(() => format_xiaohongshu(overlong_canonical_article)).toThrow(/canonical.*1000/i);
  });
});
