import { readFile as read_file } from 'node:fs/promises';
import { resolve as resolve_path } from 'node:path';
import { describe, expect, it } from 'vitest';

const read_source = async (source_file: string) => read_file(
  resolve_path(process.cwd(), source_file),
  'utf8',
);

describe('verified personal content', () => {
  it('identifies Zhenglong Chen as a VLM Algorithm Engineer on the home page', async () => {
    const source = await read_source('src/pages/index.astro');

    expect(source).toContain('Zhenglong Chen');
    expect(source).toContain('VLM Algorithm Engineer');
  });

  it('lists the verified education and internship record on the about page', async () => {
    const source = await read_source('src/pages/about.astro');

    expect(source).toContain('Shandong University');
    expect(source).toContain('Nanjing University of Information Science and Technology');
    expect(source).toContain('HUAWEI Hangzhou Research Institute');
    expect(source).toContain('ZHENHUA Petroleum Research Center');
    expect(source).toContain('TAL Education Group');
  });

  it('publishes multimodal learning as research work', async () => {
    const source = await read_source('src/content/work/multimodal-research.md');

    expect(source).toContain('title: Multimodal Learning and Visual Reasoning');
    expect(source).toContain('kind: research');
  });

  it('preserves the verified generative reservoir project title', async () => {
    const source = await read_source('src/content/work/generative-reservoir-characterization.md');

    expect(source).toContain('title: Generative Characterization of Oil-Gas Reservoirs');
  });
});
