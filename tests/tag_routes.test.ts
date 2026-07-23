import { describe, expect, it } from 'vitest';
import { encode_tag_slug } from '../src/lib/tag_routes';

describe('encode_tag_slug', () => {
  it('encodes reserved and non-ASCII tag characters into one safe path segment', () => {
    const encoded_tag = encode_tag_slug('研究/100%');

    expect(encoded_tag).toBe('_E7_A0_94_E7_A9_B6_2F100_25');
    expect(encoded_tag).not.toMatch(/[/.%]/u);
  });

  it('keeps literal escape-like text distinct from encoded characters', () => {
    expect(encode_tag_slug('a/b')).not.toBe(encode_tag_slug('a_2Fb'));
    expect(encode_tag_slug('..')).toBe('_2E_2E');
    expect(encode_tag_slug('..')).not.toBe(encode_tag_slug('_2E_2E'));
  });
});
