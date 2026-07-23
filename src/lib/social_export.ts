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

const xiaohongshu_max_characters = 1000;

/** Renders a Markdown image token as its human-readable alt text only. */
function render_image_alt({ text }: Tokens.Image): string {
  return text;
}

/** Renders a Markdown hard break as a plain-text separator. */
function render_plain_break(): string {
  return '\n';
}

const plain_text_renderer = new Renderer();
plain_text_renderer.image = render_image_alt;
plain_text_renderer.br = render_plain_break;

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

/** Counts complete Unicode code points. */
function count_characters(value: string): number {
  return Array.from(value).length;
}

/** Truncates by complete Unicode code points without splitting surrogate pairs. */
function truncate_text(value: string, max_characters: number): string {
  return Array.from(value).slice(0, Math.max(0, max_characters)).join('');
}

/** Converts Markdown to collapsed plain text suitable for a social post. */
function markdown_to_plain_text(markdown: string): string {
  const parsed_markdown = marked.parse(markdown, { renderer: plain_text_renderer });

  if (typeof parsed_markdown !== 'string') {
    throw new TypeError('Markdown parsing must return a string.');
  }

  const plain_text = sanitize_html(parsed_markdown, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed'],
  });

  return decode_html_entities(plain_text).replace(/\s+/gu, ' ').trim();
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
  return `${article.markdown}\n\n---\n\n原文：${article.canonical_url}\n`;
}

/** Produces sanitized, self-contained HTML with only trusted inline presentation styles. */
export function format_wechat_html(article: social_article): string {
  if (typeof article.markdown !== 'string') {
    throw new TypeError('Article Markdown must be a string.');
  }

  const parsed_markdown = marked.parse(article.markdown);
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

  return `<section style="margin:0 auto;max-width:720px;color:#242424;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;word-break:break-word;">${sanitized_html}</section>`;
}

/** Formats a concise plain-text Xiaohongshu post with safe Unicode truncation. */
export function format_xiaohongshu(article: social_article): string {
  const canonical_line = `原文：${article.canonical_url}`;
  if (count_characters(canonical_line) > xiaohongshu_max_characters) {
    throw new TypeError('Canonical source line exceeds the 1000-character Xiaohongshu limit.');
  }

  const reserved_sections = [canonical_line];
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
    markdown_to_plain_text(article.markdown),
    Math.min(760, get_section_budget(reserved_sections)),
  );

  return [title, description, body, canonical_line, topics]
    .filter(Boolean)
    .join('\n\n');
}
