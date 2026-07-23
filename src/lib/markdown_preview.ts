import { createMarkdownProcessor as create_markdown_processor } from '@astrojs/markdown-remark';
import rehype_katex from 'rehype-katex';
import remark_parse from 'remark-parse';
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

const preview_renderer = create_markdown_processor(markdown_processor_options);

type markdown_node = {
  children?: unknown;
  identifier?: unknown;
  type?: unknown;
  url?: unknown;
  value?: unknown;
};

type markdown_url = {
  kind: 'image' | 'link';
  identifier?: string;
  value?: string;
};

/** Collects CommonMark definitions using the parser's normalized identifiers and first-definition precedence. */
export const collect_markdown_definitions = (node: unknown): Map<string, string> => {
  const definitions = new Map<string, string>();
  const collect_definitions = (current_node: unknown): void => {
    if (typeof current_node !== 'object' || current_node === null) return;
    const markdown_node = current_node as markdown_node;
    if (markdown_node.type === 'definition' && typeof markdown_node.identifier === 'string' && typeof markdown_node.url === 'string') {
      if (!definitions.has(markdown_node.identifier)) definitions.set(markdown_node.identifier, markdown_node.url);
    }
    if (Array.isArray(markdown_node.children)) {
      for (const child of markdown_node.children) collect_definitions(child);
    }
  };
  collect_definitions(node);
  return definitions;
};

const collect_untrusted_markdown = (node: unknown, raw_html: string[], markdown_urls: markdown_url[]): void => {
  if (typeof node !== 'object' || node === null) return;
  const markdown_node = node as markdown_node;
  if (markdown_node.type === 'html' && typeof markdown_node.value === 'string') raw_html.push(markdown_node.value);
  if ((markdown_node.type === 'image' || markdown_node.type === 'link') && typeof markdown_node.url === 'string') {
    markdown_urls.push({ kind: markdown_node.type, value: markdown_node.url });
  }
  if ((markdown_node.type === 'imageReference' || markdown_node.type === 'linkReference') && typeof markdown_node.identifier === 'string') {
    markdown_urls.push({
      kind: markdown_node.type === 'imageReference' ? 'image' : 'link',
      identifier: markdown_node.identifier,
    });
  }
  if (Array.isArray(markdown_node.children)) {
    for (const child of markdown_node.children) collect_untrusted_markdown(child, raw_html, markdown_urls);
  }
};

const find_unsafe_url = (url: markdown_url, definitions: Map<string, string>): string | undefined => {
  const value = url.value ?? (url.identifier === undefined ? undefined : definitions.get(url.identifier));
  if (value === undefined) return undefined;
  const scheme = decode_html(value).replace(/[\u0000-\u0020]/g, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  const allowed_schemes = url.kind === 'image' ? ['http', 'https'] : ['http', 'https', 'mailto'];
  return scheme && !allowed_schemes.includes(scheme) ? `${url.kind} URL` : undefined;
};

const find_unsafe_html = (markdown: string): string | undefined => {
  const raw_html: string[] = [];
  const markdown_urls: markdown_url[] = [];
  const markdown_tree = unified_processor().use(remark_parse).parse(markdown);
  const definitions = collect_markdown_definitions(markdown_tree);
  collect_untrusted_markdown(markdown_tree, raw_html, markdown_urls);
  for (const markdown_url of markdown_urls) {
    const unsafe_url = find_unsafe_url(markdown_url, definitions);
    if (unsafe_url) return unsafe_url;
  }
  for (const raw_html_node of raw_html) {
    if (raw_html_node.trim()) return 'raw HTML';
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
  return (await preview_renderer).render(markdown).then((result) => result.code);
};
