/** Returns the next roving-tab stop for horizontal arrow navigation. */
export const next_tab_index = (current_index: number, key: string, tab_count: number): number => {
  if (tab_count < 1 || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return current_index;
  return key === 'ArrowRight' ? (current_index + 1) % tab_count : (current_index - 1 + tab_count) % tab_count;
};

/** Ensures a delayed response cannot overwrite a newer preview. */
export const is_latest_preview = (latest_sequence: number, response_sequence: number): boolean => latest_sequence === response_sequence;
