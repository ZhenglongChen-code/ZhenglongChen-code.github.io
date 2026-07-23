export type reading_time = {
  label: string;
  minutes: number;
};

const words_per_minute = 200;
const han_characters_per_minute = 400;

/** Produces a stable reading-time estimate from Markdown source without counting fenced code. */
export const calculate_reading_time = (markdown: string, language: 'zh' | 'en'): reading_time => {
  const prose = markdown
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/`[^`]*`/gu, '')
    .replace(/!?(?:\[[^\]]*\])?\([^)]*\)/gu, '')
    .replace(/[#>*_~|$]/gu, ' ');
  const han_count = (prose.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const word_count = (prose.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const units = language === 'zh' ? han_count : word_count;
  const rate = language === 'zh' ? han_characters_per_minute : words_per_minute;
  const minutes = Math.max(1, Math.ceil(units / rate));

  return language === 'zh'
    ? { minutes, label: `预计 ${minutes} 分钟阅读` }
    : { minutes, label: `${minutes} min read` };
};
