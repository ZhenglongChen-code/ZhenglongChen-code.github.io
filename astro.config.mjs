import { defineConfig as define_config } from 'astro/config';
import rehype_katex from 'rehype-katex';
import remark_math from 'remark-math';

export default define_config({
  output: 'static',
  site: 'http://106.14.173.234',
  trailingSlash: 'never',
  markdown: {
    remarkPlugins: [remark_math],
    rehypePlugins: [rehype_katex],
  },
});
