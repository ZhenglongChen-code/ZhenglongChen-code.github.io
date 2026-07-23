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

  it('lists verified degrees, dates, internships, awards, and contact links on the about page', async () => {
    const source = await read_source('src/pages/about.astro');

    for (const verified_detail of [
      'Master of Science in Mathematics, Shandong University',
      '2023/09 - 2026/06',
      'Bachelor of Science in Mathematics, Nanjing University of Information Science and Technology',
      '2019/09 - 2023/06',
      'HUAWEI Hangzhou Research Institute',
      '2025/06 - 2025/09',
      'ZHENHUA Petroleum Research Center',
      '2025/04 - 2025/06',
      'TAL Education Group',
      '2024/10 - 2024/11',
      'ICM Finalist',
      'National Mathematical Contest 1st Prize',
      'Blue Bridge Cup 1st Prize',
      'National Mathematics 2nd Prize',
      'Undergraduate Thesis Outstanding Undergraduate Thesis Team',
      'Scholarship First-Class Scholarship (NUIST 3)',
      'National Scholarship for Postgraduates 2025',
      'Other Outstanding Psychological Committee Member',
      'mailto:chenzhenglong@mail.sdu.edu.cn',
      'https://github.com/ZhenglongChen-code',
      'https://www.zhihu.com/people/ni-hao-a-53-88-52',
    ]) {
      expect(source).toContain(verified_detail);
    }
    expect(source).not.toContain('/assets/files/curriculum_vitae.pdf');
  });

  it('publishes multimodal learning as research work', async () => {
    const source = await read_source('src/content/work/multimodal-research.md');

    expect(source).toContain('title: Multimodal Learning and Visual Reasoning');
    expect(source).toContain('kind: research');
  });

  it('preserves verified project titles, organizations, and date ranges', async () => {
    const verified_projects = [
      {
        source_file: 'src/content/work/generative-reservoir-characterization.md',
        title: 'title: Generative Characterization of Oil-Gas Reservoirs',
        organization: 'Chinese Academy of Science ·',
        date_range: '2024/09 - 2025/03',
      },
      {
        source_file: 'src/content/work/generative-hydrocarbon-sweet-spots.md',
        title: 'title: Generative Large Model for Hydrocarbon Sweet Spots',
        organization: 'Chinese Academy of Science ·',
        date_range: '2023/11 - 2024/03',
      },
      {
        source_file: 'src/content/work/intelligent-surrogate-imbalanced-data.md',
        title: 'title: Intelligent Surrogate Model for Imbalanced Data',
        organization: 'Qingdao Soft Control Company ·',
        date_range: '2023/09 - 2024/09',
      },
    ];

    for (const verified_project of verified_projects) {
      const source = await read_source(verified_project.source_file);

      expect(source).toContain(verified_project.title);
      expect(source).toContain(verified_project.organization);
      expect(source).toContain(verified_project.date_range);
    }
  });
});
