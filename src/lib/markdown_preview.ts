import rehype_katex from 'rehype-katex';
import rehype_raw from 'rehype-raw';
import rehype_stringify from 'rehype-stringify';
import remark_parse from 'remark-parse';
import remark_rehype from 'remark-rehype';
import remark_math from 'remark-math';
import sanitize_html from 'sanitize-html';
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

const allowed_tags = [
  'a', 'article', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'li', 'math', 'mi',
  'mn', 'mo', 'mfrac', 'mrow', 'msub', 'msubsup', 'msup', 'mtext', 'ol', 'p', 'path',
  'pre', 'semantics', 'span', 'strong', 'sub', 'sup', 'svg', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul', 'annotation', 'mover', 'munder', 'munderover', 'mpadded',
  'mphantom', 'mroot', 'mspace', 'msqrt', 'mstyle', 'mtable', 'mtd', 'mtr',
];

const katex_mathml_attributes = [
  'accent', 'accentunder', 'columnalign', 'columnspacing', 'columnspan', 'displaystyle',
  'encoding', 'fence', 'form', 'lspace', 'mathvariant', 'maxsize', 'minsize',
  'movablelimits', 'notation', 'rspace', 'scriptlevel', 'separator', 'stretchy',
  'symmetric', 'voffset', 'xmlns',
];

const sanitize_options: sanitize_html.IOptions = {
  allowedTags: allowed_tags,
  allowedAttributes: {
    '*': ['aria-hidden', 'class', 'style', ...katex_mathml_attributes],
    a: ['href', 'rel', 'target', 'title'],
    img: ['alt', 'height', 'loading', 'src', 'title', 'width'],
    path: ['d'],
    svg: ['height', 'preserveAspectRatio', 'viewBox', 'width', 'xmlns'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
};

const source_global_attributes = new Set(['aria-hidden', 'class', ...katex_mathml_attributes]);
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
  value?: unknown;
};

const collect_raw_html = (node: unknown, raw_html: string[]): void => {
  if (typeof node !== 'object' || node === null) return;
  const markdown_node = node as markdown_node;
  if (markdown_node.type === 'html' && typeof markdown_node.value === 'string') raw_html.push(markdown_node.value);
  if (Array.isArray(markdown_node.children)) {
    for (const child of markdown_node.children) collect_raw_html(child, raw_html);
  }
};

const remove_assigned_attributes = (attributes: string): string => (
  attributes.replace(/\s[a-z][a-z0-9-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, ' ')
);

const find_unsafe_raw_html = (raw_html: string): string | undefined => {
  for (const raw_tag of raw_html.matchAll(/<\s*([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const tag_name = raw_tag[1]?.toLowerCase();
    const attributes = raw_tag[2] ?? '';
    if (!tag_name || !allowed_tags.includes(tag_name)) return tag_name ?? 'unknown tag';

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

const find_unsafe_html = (markdown: string): string | undefined => {
  const raw_html: string[] = [];
  collect_raw_html(unified_processor().use(remark_parse).parse(markdown), raw_html);
  for (const raw_html_node of raw_html) {
    const unsafe_html = find_unsafe_raw_html(raw_html_node);
    if (unsafe_html) return unsafe_html;
  }
  return undefined;
};

/** Renders Markdown with the same math extensions used by Astro's static build. */
export const render_markdown_preview = async (markdown: string): Promise<string> => {
  const unsafe_html = find_unsafe_html(markdown);
  if (unsafe_html) {
    throw new studio_validation_error([{
      code: 'unsafe_html',
      message: `Preview contains unsafe HTML (${unsafe_html}) that the sanitizer would remove.`,
    }]);
  }
  const rendered_html = String(await create_preview_processor().process(markdown));
  const sanitized_html = sanitize_html(rendered_html, sanitize_options);
  return sanitized_html;
};
