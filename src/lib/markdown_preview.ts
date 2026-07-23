import rehype_katex from 'rehype-katex';
import rehype_raw from 'rehype-raw';
import rehype_stringify from 'rehype-stringify';
import remark_parse from 'remark-parse';
import remark_rehype from 'remark-rehype';
import remark_math from 'remark-math';
import { decodeHTML as decode_html } from 'entities';
import { unified as unified_processor } from 'unified';

export type studio_validation_issue = {
  code: 'unsafe_html' | 'invalid_frontmatter' | 'invalid_slug';
  field?: string;
  message: string;
};

export class studio_validation_error extends Error {
  readonly issues: studio_validation_issue[];

  constructor(issues: studio_validation_issue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'studio_validation_error';
    this.issues = issues;
  }
}

export const markdown_processor_options = {
  remarkPlugins: [remark_math],
  rehypePlugins: [rehype_katex],
};

const safe_user_html_tags = [
  'a', 'article', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'li', 'math', 'mi',
  'mn', 'mo', 'mfrac', 'mrow', 'msub', 'msubsup', 'msup', 'mtext', 'ol', 'p', 'path',
  'pre', 'semantics', 'span', 'strong', 'sub', 'sup', 'svg', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul', 'annotation', 'mover', 'munder', 'munderover', 'mpadded',
  'mphantom', 'mroot', 'mspace', 'msqrt', 'mstyle', 'mtable', 'mtd', 'mtr',
];

const source_global_attributes = new Set(['aria-hidden', 'class', 'encoding', 'stretchy', 'xmlns']);
const source_tag_attributes: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'target', 'title']),
  img: new Set(['alt', 'height', 'loading', 'src', 'title', 'width']),
};

const create_preview_processor = () => unified_processor()
  .use(remark_parse)
  .use(remark_math)
  .use(remark_rehype, { allowDangerousHtml: true })
  .use(rehype_raw)
  .use(rehype_katex)
  .use(rehype_stringify);

type markdown_node = {
  children?: unknown;
  type?: unknown;
  url?: unknown;
  value?: unknown;
};

type markdown_url = {
  kind: 'image' | 'link';
  value: string;
};

const collect_untrusted_markdown = (node: unknown, raw_html: string[], markdown_urls: markdown_url[]): void => {
  if (typeof node !== 'object' || node === null) return;
  const markdown_node = node as markdown_node;
  if (markdown_node.type === 'html' && typeof markdown_node.value === 'string') raw_html.push(markdown_node.value);
  if ((markdown_node.type === 'image' || markdown_node.type === 'link') && typeof markdown_node.url === 'string') {
    markdown_urls.push({ kind: markdown_node.type, value: markdown_node.url });
  }
  if (Array.isArray(markdown_node.children)) {
    for (const child of markdown_node.children) collect_untrusted_markdown(child, raw_html, markdown_urls);
  }
};

const remove_assigned_attributes = (attributes: string): string => (
  attributes.replace(/\s[a-z][a-z0-9-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, ' ')
);

const find_unsafe_raw_html = (raw_html: string): string | undefined => {
  for (const raw_tag of raw_html.matchAll(/<\s*([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const tag_name = raw_tag[1]?.toLowerCase();
    const attributes = raw_tag[2] ?? '';
    if (!tag_name || !safe_user_html_tags.includes(tag_name)) return tag_name ?? 'unknown tag';

    for (const raw_attribute of attributes.matchAll(/\s([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const attribute_name = raw_attribute[1]?.toLowerCase();
      const attribute_value = raw_attribute[2] ?? raw_attribute[3] ?? raw_attribute[4] ?? '';
      if (!attribute_name) continue;
      if (attribute_name.startsWith('on') || attribute_name === 'style') return attribute_name;
      if (!source_global_attributes.has(attribute_name) && !source_tag_attributes[tag_name]?.has(attribute_name)) {
        return attribute_name;
      }
      if (attribute_name === 'href' || attribute_name === 'src') {
        const scheme = decode_html(attribute_value).replace(/[\u0000-\u0020]/g, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
        const allowed_schemes = attribute_name === 'src' ? ['http', 'https'] : ['http', 'https', 'mailto'];
        if (scheme && !allowed_schemes.includes(scheme)) return `${attribute_name} URL`;
      }
    }
    const bare_attribute = remove_assigned_attributes(attributes).match(/\s([a-z][a-z0-9-]*)\b/i)?.[1]?.toLowerCase();
    if (bare_attribute) return bare_attribute;
  }
  return undefined;
};

const find_unsafe_url = (url: markdown_url): string | undefined => {
  const scheme = decode_html(url.value).replace(/[\u0000-\u0020]/g, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  const allowed_schemes = url.kind === 'image' ? ['http', 'https'] : ['http', 'https', 'mailto'];
  return scheme && !allowed_schemes.includes(scheme) ? `${url.kind} URL` : undefined;
};

const find_unsafe_html = (markdown: string): string | undefined => {
  const raw_html: string[] = [];
  const markdown_urls: markdown_url[] = [];
  collect_untrusted_markdown(unified_processor().use(remark_parse).parse(markdown), raw_html, markdown_urls);
  for (const markdown_url of markdown_urls) {
    const unsafe_url = find_unsafe_url(markdown_url);
    if (unsafe_url) return unsafe_url;
  }
  for (const raw_html_node of raw_html) {
    const unsafe_html = find_unsafe_raw_html(raw_html_node);
    if (unsafe_html) return unsafe_html;
  }
  return undefined;
};

/** Renders prevalidated Markdown with the same math extensions used by Astro's static build. */
export const render_markdown_preview = async (markdown: string): Promise<string> => {
  const unsafe_html = find_unsafe_html(markdown);
  if (unsafe_html) {
    throw new studio_validation_error([{
      code: 'unsafe_html',
      message: `Preview contains unsafe HTML (${unsafe_html}) that the sanitizer would remove.`,
    }]);
  }
  return String(await create_preview_processor().process(markdown));
};
