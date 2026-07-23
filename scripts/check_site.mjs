import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

const required_paths = [
  'dist/index.html',
  'dist/research/index.html',
  'dist/projects/index.html',
  'dist/articles/index.html',
  'dist/about/index.html',
  'dist/rss.xml',
  'dist/404.html',
];
const retired_paths = ['dist/work', 'dist/writing', 'dist/en/writing'];

const social_export_extensions = new Set(['.html', '.md', '.txt']);

const generated_artifact_roots = [
  { path: 'dist', extensions: new Set(['.html', '.xml']) },
  { path: 'social_exports', extensions: social_export_extensions },
];

const former_public_names = ['陈正龙', 'ChenZL'];
const forbidden_studio_markers = [
  { marker: 'studio', description: 'Studio UI' },
  { marker: '/api/', description: 'Studio API route' },
  { marker: 'session_token', description: 'Studio token' },
  { marker: '.env.studio.local', description: 'local Studio environment file' },
  { marker: '.studio/transactions', description: 'Studio transaction journal' },
  { marker: 'transaction journal', description: 'Studio transaction journal' },
];

/** Return a validation error for a build artifact, or null when it is safe. */
async function inspect_artifact(relative_path) {
  try {
    const artifact_path = resolve(relative_path);
    const artifact_stat = await lstat(artifact_path);
    if (!artifact_stat.isFile()) {
      return `${relative_path}: not a regular file`;
    }
    await access(artifact_path, constants.R_OK);
    return null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return `${relative_path}: missing`;
    }
    return `${relative_path}: not readable`;
  }
}

/** Return a validation error when a retired public artifact remains in the build. */
async function inspect_retired_artifact(relative_path) {
  try {
    await lstat(resolve(relative_path));
    return `${relative_path}: retired public output must not exist`;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    return `${relative_path}: cannot verify absence`;
  }
}

/** Return a validation error for a required generated artifact directory, or null when it is safe. */
async function inspect_artifact_directory(relative_path) {
  try {
    const artifact_path = resolve(relative_path);
    const artifact_stat = await lstat(artifact_path);
    if (!artifact_stat.isDirectory()) {
      return `${relative_path}: not a directory`;
    }
    await access(artifact_path, constants.R_OK);
    return null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return `${relative_path}: missing`;
    }
    return `${relative_path}: not readable`;
  }
}

/** Collect recursively generated public artifacts with one of the allowed text extensions. */
async function collect_generated_artifacts(relative_root, allowed_extensions) {
  const root_path = resolve(relative_root);
  const artifact_paths = [];

  async function visit_directory(directory_path) {
    let entries;

    try {
      entries = await readdir(directory_path, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entry_path = resolve(directory_path, entry.name);

      if (entry.isDirectory()) {
        await visit_directory(entry_path);
      } else if (entry.isFile() && allowed_extensions.has(extname(entry.name).toLowerCase())) {
        artifact_paths.push(entry_path);
      }
    }
  }

  await visit_directory(root_path);
  return artifact_paths;
}

/** Collect every public build file so private Studio assets and source maps cannot escape. */
async function collect_public_build_files() {
  const root_path = resolve('dist');
  const files = [];

  async function visit_directory(directory_path) {
    const entries = await readdir(directory_path, { withFileTypes: true });
    for (const entry of entries) {
      const entry_path = resolve(directory_path, entry.name);
      if (entry.isDirectory()) await visit_directory(entry_path);
      else if (entry.isFile()) files.push(entry_path);
    }
  }

  await visit_directory(root_path);
  return files;
}

/** Return public-build errors for Studio markers, private paths, and source maps. */
async function inspect_public_studio_exclusion() {
  const errors = [];
  const artifact_paths = await collect_public_build_files();
  for (const artifact_path of artifact_paths) {
    const artifact_label = relative(process.cwd(), artifact_path);
    if (extname(artifact_path).toLowerCase() === '.map') {
      errors.push(`${artifact_label}: source map leakage is forbidden`);
      continue;
    }
    const artifact_content = await readFile(artifact_path, 'utf8').catch(() => undefined);
    if (artifact_content === undefined) continue;
    const normalized_content = artifact_content.toLowerCase();
    for (const { marker, description } of forbidden_studio_markers) {
      if (normalized_content.includes(marker)) errors.push(`${artifact_label}: contains ${description}`);
    }
  }
  return errors;
}

/** Return a validation error when the generated social-export directory has no public text files. */
async function inspect_social_exports() {
  const directory_error = await inspect_artifact_directory('social_exports');

  if (directory_error) {
    return directory_error;
  }

  const social_export_artifacts = await collect_generated_artifacts(
    'social_exports',
    social_export_extensions,
  );

  return social_export_artifacts.length > 0
    ? null
    : 'social_exports: contains no generated text artifacts';
}

/** Return every former public-name match in generated HTML, XML, and social-export text. */
async function inspect_generated_identity_artifacts() {
  const artifact_paths = (
    await Promise.all(
      generated_artifact_roots.map(({ path, extensions }) => collect_generated_artifacts(path, extensions)),
    )
  ).flat();
  const identity_errors = [];

  for (const artifact_path of artifact_paths) {
    const artifact_content = await readFile(artifact_path, 'utf8');
    const artifact_label = relative(process.cwd(), artifact_path);

    for (const former_public_name of former_public_names) {
      if (artifact_content.includes(former_public_name)) {
        identity_errors.push(`${artifact_label}: contains former public name "${former_public_name}"`);
      }
    }
  }

  return identity_errors;
}

/** Verify the complete static-site output and homepage production metadata. */
async function check_site() {
  const required_artifact_errors = (await Promise.all(required_paths.map(inspect_artifact)))
    .filter((artifact_error) => artifact_error !== null);
  const retired_artifact_errors = (await Promise.all(retired_paths.map(inspect_retired_artifact)))
    .filter((artifact_error) => artifact_error !== null);
  const social_exports_error = await inspect_social_exports();
  const artifact_errors = social_exports_error
    ? [...required_artifact_errors, ...retired_artifact_errors, social_exports_error]
    : [...required_artifact_errors, ...retired_artifact_errors];

  if (artifact_errors.length > 0) {
    throw new Error(`invalid required site artifacts:\n- ${artifact_errors.join('\n- ')}`);
  }

  const index_html = await readFile(resolve('dist/index.html'), 'utf8');
  const index_errors = [];
  const starter_text_pattern = /Astro Starter Kit|Welcome to Astro|Get started by opening|astro\.new/i;
  const canonical_pattern = /<link\b(?=[^>]*\brel="canonical")(?=[^>]*\bhref="http:\/\/106\.14\.173\.234\/")[^>]*>/i;

  if (starter_text_pattern.test(index_html)) {
    index_errors.push('contains starter/template text');
  }
  if (!index_html.includes('lang="zh-CN"')) {
    index_errors.push('missing lang="zh-CN"');
  }
  if (!canonical_pattern.test(index_html)) {
    index_errors.push('missing canonical http://106.14.173.234/');
  }
  if (!index_html.includes('Zhenglong Chen')) {
    index_errors.push('missing Zhenglong Chen public identity');
  }

  if (index_errors.length > 0) {
    throw new Error(`invalid dist/index.html:\n- ${index_errors.join('\n- ')}`);
  }

  const identity_errors = await inspect_generated_identity_artifacts();

  if (identity_errors.length > 0) {
    throw new Error(`invalid generated public identity artifacts:\n- ${identity_errors.join('\n- ')}`);
  }

  const studio_exclusion_errors = await inspect_public_studio_exclusion();

  if (studio_exclusion_errors.length > 0) {
    throw new Error(`invalid public Studio exclusion:\n- ${studio_exclusion_errors.join('\n- ')}`);
  }

  console.log(`site artifacts verified (${required_paths.length} required files)`);
}

try {
  await check_site();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`check_site: ${message}`);
  process.exitCode = 1;
}
