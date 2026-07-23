import { decode as decode_html_entities } from 'entities';
import { marked, Renderer, type Tokens } from 'marked';
import sanitize_html, { type Attributes, type Tag } from 'sanitize-html';

export type social_article = {
  title: string;
  description: string;
  tags: string[];
  canonical_url: string;
  markdown: string;
};

const wechat_styles: Readonly<Record<string, string>> = {
  h1: 'margin:0 0 24px;font-size:30px;line-height:1.35;color:#111111;font-weight:700;',
  h2: 'margin:32px 0 16px;font-size:24px;line-height:1.4;color:#111111;font-weight:700;',
  h3: 'margin:24px 0 12px;font-size:20px;line-height:1.5;color:#222222;font-weight:700;',
  p: 'margin:0 0 18px;font-size:16px;line-height:1.9;color:#242424;',
  blockquote: 'margin:24px 0;padding:12px 18px;border-left:4px solid #888888;color:#555555;background:#f7f7f7;',
  pre: 'margin:20px 0;padding:16px;overflow-x:auto;background:#f5f5f5;border-radius:6px;font-size:14px;line-height:1.65;',
  code: 'padding:2px 5px;background:#f1f1f1;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:0.9em;',
  a: 'color:#175199;text-decoration:underline;',
  ul: 'margin:0 0 18px;padding-left:24px;font-size:16px;line-height:1.9;color:#242424;',
  ol: 'margin:0 0 18px;padding-left:24px;font-size:16px;line-height:1.9;color:#242424;',
};

const wechat_tags = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'blockquote',
  'pre',
  'code',
  'a',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'del',
  'br',
  'hr',
] as const;

const source_detection_tags = wechat_tags.filter((tag) => tag !== 'code' && tag !== 'pre');

const xiaohongshu_max_characters = 1000;

type protected_math_source = {
  markdown: string;
  replacements: ReadonlyMap<string, string>;
};

/** Renders a Markdown image token as its human-readable alt text only. */
function render_image_alt({ text }: Tokens.Image): string {
  return text;
}

/** Renders a Markdown hard break as a plain-text separator. */
function render_plain_break(): string {
  return '\n';
}

/** Creates a plain-text renderer that retains an existing canonical link destination. */
function create_plain_text_renderer(canonical_url?: string): Renderer {
  const plain_text_renderer = new Renderer();
  plain_text_renderer.image = render_image_alt;
  plain_text_renderer.br = render_plain_break;
  plain_text_renderer.link = ({ href, text }: Tokens.Link): string => {
    if (canonical_url && href === canonical_url) {
      return text === href ? text : `${text} ${href}`;
    }

    return text;
  };

  return plain_text_renderer;
}

/** Adds a trusted static style while discarding any source style value. */
function style_wechat_tag(tag_name: string, tag_attributes: Attributes): Tag {
  const style = wechat_styles[tag_name];

  return {
    tagName: tag_name,
    attribs: style
      ? { ...tag_attributes, style }
      : tag_attributes,
  };
}

/** Returns grapheme clusters, falling back deterministically to Unicode code points. */
function split_graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  }

  return Array.from(value);
}

/** Counts complete Unicode grapheme clusters. */
function count_characters(value: string): number {
  return split_graphemes(value).length;
}

/** Truncates by complete Unicode grapheme clusters without splitting visible characters. */
function truncate_text(value: string, max_characters: number): string {
  return split_graphemes(value).slice(0, Math.max(0, max_characters)).join('');
}

/** Escapes a text value for safe interpolation into trusted static HTML. */
function escape_html(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const escaped_characters: Readonly<Record<string, string>> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return escaped_characters[character] ?? character;
  });
}

/** Rejects canonical URLs that are not safe absolute public HTTP(S) URLs. */
function validate_canonical_url(canonical_url: string): void {
  let parsed_url: URL;

  try {
    parsed_url = new URL(canonical_url);
  } catch {
    throw new TypeError('Canonical URL must be a valid credential-free HTTP(S) URL.');
  }

  if (
    !['http:', 'https:'].includes(parsed_url.protocol)
    || !parsed_url.hostname
    || parsed_url.username
    || parsed_url.password
  ) {
    throw new TypeError('Canonical URL must be a valid credential-free HTTP(S) URL.');
  }
}

/** Masks a source range without changing string offsets used by later validation. */
function mask_source_range(source: string): string {
  return ' '.repeat(source.length);
}

/** Masks inline code spans after fenced blocks and comments are already masked. */
function mask_inline_code(markdown: string): string {
  const characters = markdown.split('');
  let index = 0;

  while (index < characters.length) {
    if (characters[index] !== '`') {
      index += 1;
      continue;
    }

    let delimiter_length = 1;
    while (characters[index + delimiter_length] === '`') {
      delimiter_length += 1;
    }

    let closing_index = index + delimiter_length;
    while (closing_index < characters.length) {
      const delimiter = characters.slice(closing_index, closing_index + delimiter_length).join('');
      if (delimiter === '`'.repeat(delimiter_length)) {
        characters.fill(' ', index, closing_index + delimiter_length);
        index = closing_index + delimiter_length;
        break;
      }
      closing_index += 1;
    }

    if (closing_index >= characters.length) {
      index += delimiter_length;
    }
  }

  return characters.join('');
}

/** Masks fenced code blocks using Marked's CommonMark-aware lexer tokens. */
function mask_fenced_code(markdown: string): string {
  const characters = markdown.split('');
  const tokens = marked.lexer(markdown);
  let search_start = 0;

  for (const token of tokens) {
    const token_start = markdown.indexOf(token.raw, search_start);
    if (token_start < 0) {
      continue;
    }

    if (token.type === 'code') {
      characters.fill(' ', token_start, token_start + token.raw.length);
    }

    search_start = token_start + token.raw.length;
  }

  return characters.join('');
}

/** Masks Markdown regions whose HTML-looking text cannot execute as raw HTML. */
function mask_non_executable_markdown(markdown: string): string {
  const without_comments = markdown.replace(/<!--[\s\S]*?(?:-->|$)/gu, mask_source_range);
  const without_fenced_code = mask_fenced_code(without_comments);

  return mask_inline_code(without_fenced_code);
}

/** Rejects unclosed non-text raw HTML tags that would silently absorb source content. */
export function validate_unsafe_raw_html(markdown: string): void {
  const unsafe_tag_pattern = /<\/?(script|style|textarea|iframe|object|embed)\b[^>]*>/giu;
  const open_tags: string[] = [];
  const executable_markdown = mask_non_executable_markdown(markdown);

  for (const match of executable_markdown.matchAll(unsafe_tag_pattern)) {
    const raw_tag = match[1];
    if (!raw_tag) {
      continue;
    }

    const tag = raw_tag.toLowerCase();
    const tag_text = match[0];

    if (tag === 'embed') {
      continue;
    }

    if (tag_text.startsWith('</')) {
      const open_tag = open_tags.pop();
      if (open_tag !== tag) {
        throw new TypeError(`Unbalanced unsafe raw HTML tag </${tag}>.`);
      }
      continue;
    }

    if (!tag_text.endsWith('/>')) {
      open_tags.push(tag);
    }
  }

  if (open_tags.length > 0) {
    throw new TypeError(`Unclosed unsafe raw HTML tag <${open_tags.at(-1)}>.`);
  }
}

/** Protects TeX delimiters from Markdown parsing with deterministic collision-free sentinels. */
function protect_math_source(markdown: string): protected_math_source {
  let prefix_index = 0;
  let sentinel_prefix = '';

  do {
    sentinel_prefix = `\uE000social-math-${prefix_index}\uE001`;
    prefix_index += 1;
  } while (markdown.includes(sentinel_prefix));

  const replacements = new Map<string, string>();
  const create_placeholder = (formula: string): string => {
    const placeholder = `${sentinel_prefix}${replacements.size}\uE002`;
    replacements.set(placeholder, formula);
    return placeholder;
  };
  const block_math_pattern = /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/gu;
  const inline_math_pattern = /(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?(?<!\\)\$/gu;
  const protected_blocks = markdown.replace(block_math_pattern, create_placeholder);

  return {
    markdown: protected_blocks.replace(inline_math_pattern, create_placeholder),
    replacements,
  };
}

/** Restores protected TeX source as literal text, optionally escaped for HTML. */
function restore_math_source(
  value: string,
  replacements: ReadonlyMap<string, string>,
  should_escape_html: boolean,
): string {
  let restored_value = value;

  for (const [placeholder, formula] of replacements) {
    const replacement = should_escape_html ? escape_html(formula) : formula;
    restored_value = restored_value.replaceAll(placeholder, () => replacement);
  }

  return restored_value;
}

/** Validates shared source inputs before any platform formatter transforms them. */
function validate_social_article(article: social_article): void {
  if (typeof article.markdown !== 'string') {
    throw new TypeError('Article Markdown must be a string.');
  }

  validate_canonical_url(article.canonical_url);
  validate_unsafe_raw_html(article.markdown);
}

/** Reports whether canonical source survives Markdown parsing and sanitization. */
function has_surviving_canonical_source(article: social_article): boolean {
  const protected_math = protect_math_source(article.markdown);
  const parsed_markdown = marked.parse(protected_math.markdown);
  if (typeof parsed_markdown !== 'string') {
    throw new TypeError('Markdown parsing must return a string.');
  }

  const sanitized_html = sanitize_html(parsed_markdown, {
    allowedTags: source_detection_tags,
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'code', 'pre'],
  });

  return sanitized_html.includes(escape_html(article.canonical_url));
}

/** Builds a trusted, escaped WeChat source link after untrusted Markdown is sanitized. */
function format_wechat_source(canonical_url: string): string {
  const escaped_url = escape_html(canonical_url);

  return `<p style="${wechat_styles.p}">原文：<a href="${escaped_url}" style="${wechat_styles.a}">${escaped_url}</a></p>`;
}

/** Converts Markdown to collapsed plain text suitable for a social post. */
function markdown_to_plain_text(markdown: string, canonical_url?: string): string {
  const protected_math = protect_math_source(markdown);
  const parsed_markdown = marked.parse(protected_math.markdown, {
    renderer: create_plain_text_renderer(canonical_url),
  });

  if (typeof parsed_markdown !== 'string') {
    throw new TypeError('Markdown parsing must return a string.');
  }

  const plain_text = sanitize_html(parsed_markdown, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed'],
  });

  return restore_math_source(
    decode_html_entities(plain_text).replace(/\s+/gu, ' ').trim(),
    protected_math.replacements,
    false,
  );
}

/** Builds complete, unique hashtag topics in source order within the size budget. */
function build_topics(tags: string[], max_characters: number): string {
  const seen_topics = new Set<string>();
  const topics: string[] = [];

  for (const tag of tags) {
    const normalized_tag = tag.normalize('NFC');
    const topic_name = normalized_tag.replace(/[^\p{L}\p{M}\p{N}_]/gu, '');

    if (!topic_name || seen_topics.has(topic_name)) {
      continue;
    }

    const candidate_topics = [...topics, `#${topic_name}`].join(' ');
    if (count_characters(candidate_topics) > max_characters) {
      break;
    }

    seen_topics.add(topic_name);
    topics.push(`#${topic_name}`);
  }

  return topics.join(' ');
}

/** Returns the remaining code-point budget for one more separated output section. */
function get_section_budget(reserved_sections: string[]): number {
  const reserved_characters = count_characters(reserved_sections.join('\n\n'));
  const separator_characters = reserved_sections.length > 0 ? 2 : 0;

  return Math.max(0, xiaohongshu_max_characters - reserved_characters - separator_characters);
}

/** Formats the original Markdown with a stable canonical source for Zhihu. */
export function format_zhihu(article: social_article): string {
  validate_social_article(article);
  const has_canonical_source = has_surviving_canonical_source(article);

  return has_canonical_source
    ? `${article.markdown}\n`
    : `${article.markdown}\n\n---\n\n原文：${article.canonical_url}\n`;
}

/** Produces sanitized, self-contained HTML with only trusted inline presentation styles. */
export function format_wechat_html(article: social_article): string {
  validate_social_article(article);
  const has_canonical_source = has_surviving_canonical_source(article);

  const protected_math = protect_math_source(article.markdown);
  const parsed_markdown = marked.parse(protected_math.markdown);
  if (typeof parsed_markdown !== 'string') {
    throw new TypeError('Markdown parsing must return a string.');
  }

  const transform_tags = Object.fromEntries(
    wechat_tags.map((tag_name) => [tag_name, style_wechat_tag]),
  );
  const sanitized_html = sanitize_html(parsed_markdown, {
    allowedTags: [...wechat_tags],
    allowedAttributes: {
      a: ['href', 'title', 'style'],
      h1: ['style'],
      h2: ['style'],
      h3: ['style'],
      p: ['style'],
      blockquote: ['style'],
      pre: ['style'],
      code: ['style'],
      ul: ['style'],
      ol: ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed'],
    transformTags: transform_tags,
  });

  const restored_html = restore_math_source(sanitized_html, protected_math.replacements, true);
  const trusted_source = has_canonical_source
    ? ''
    : format_wechat_source(article.canonical_url);

  return `<section style="margin:0 auto;max-width:720px;color:#242424;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;word-break:break-word;">${restored_html}${trusted_source}</section>`;
}

/** Formats a concise plain-text Xiaohongshu post with safe Unicode truncation. */
export function format_xiaohongshu(article: social_article): string {
  validate_social_article(article);
  const has_canonical_source = has_surviving_canonical_source(article);
  const canonical_line = `原文：${article.canonical_url}`;
  if (count_characters(canonical_line) > xiaohongshu_max_characters) {
    throw new TypeError('Canonical source line exceeds the 1000-character Xiaohongshu limit.');
  }

  const reserved_sections = has_canonical_source ? [] : [canonical_line];
  const title = truncate_text(
    markdown_to_plain_text(article.title),
    Math.min(80, get_section_budget(reserved_sections)),
  );
  if (title) {
    reserved_sections.push(title);
  }

  const topics = build_topics(
    article.tags,
    Math.min(160, get_section_budget(reserved_sections)),
  );
  if (topics) {
    reserved_sections.push(topics);
  }

  const description = truncate_text(
    markdown_to_plain_text(article.description),
    Math.min(140, get_section_budget(reserved_sections)),
  );
  if (description) {
    reserved_sections.push(description);
  }

  const body = truncate_text(
    markdown_to_plain_text(article.markdown, article.canonical_url),
    Math.min(760, get_section_budget(reserved_sections)),
  );

  return [title, description, body, has_canonical_source ? '' : canonical_line, topics]
    .filter(Boolean)
    .join('\n\n');
}
