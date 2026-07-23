import { defineConfig as define_config } from 'astro/config';
import { unified as unified_processor } from '@astrojs/markdown-remark';
import { markdown_processor_options } from './src/lib/markdown_preview';

export default define_config({
  output: 'static',
  site: 'http://106.14.173.234',
  trailingSlash: 'never',
  markdown: {
    processor: unified_processor({
      ...markdown_processor_options,
    }),
  },
});
