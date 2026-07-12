/**
 * Publish client-updated to GitHub WITHOUT local git binary (GitHub Git Data API).
 *   $env:GITHUB_TOKEN='ghp_...'; node scripts/publish-client-github-api.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(__dirname, '..');
const OWNER = 'afekns';
const REPO = 'RMRP-Helper';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const SKIP_DIRS = new Set(['node_modules', 'release', '.git', 'drivers']);
const SKIP_FILES = new Set(['logs.txt', '.env', 'driver-signed.zip', 'package-lock.json']);

if (!TOKEN) {
  console.error('GITHUB_TOKEN required');
  process.exit(1);
}

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else if (st.isFile() && st.size < 40 * 1024 * 1024) out.push({ rel: rel.replace(/\\/g, '/'), full });
  }
  return out;
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          'User-Agent': 'RMRP-Helper-Publisher',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`${method} ${apiPath} → ${res.statusCode}: ${raw.slice(0, 400)}`));
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ensureRepo() {
  try {
    await api('GET', `/repos/${OWNER}/${REPO}`);
  } catch (e) {
    if (String(e.message).includes('404')) {
      console.log('Creating repo', REPO);
      await api('POST', '/user/repos', {
        name: REPO,
        private: false,
        description: 'RMRP Helper client sources (auto-published)',
        auto_init: true,
      });
    } else throw e;
  }
}

async function getHead() {
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    const sha = ref.object.sha;
    const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${sha}`);
    return { commitSha: sha, treeSha: commit.tree.sha };
  } catch {
    return { commitSha: null, treeSha: null };
  }
}

async function createBlob(contentBuf) {
  const b64 = contentBuf.toString('base64');
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: b64,
    encoding: 'base64',
  });
  return blob.sha;
}

async function main() {
  console.log('Collecting files…');
  const files = walk(CLIENT);
  // Prefer UI/assets for integrity; still publish source code
  console.log('Files:', files.length);
  await ensureRepo();
  const head = await getHead();

  const tree = [];
  let i = 0;
  for (const f of files) {
    i += 1;
    if (i % 20 === 0 || i === files.length) console.log(`  blob ${i}/${files.length}: ${f.rel}`);
    const buf = fs.readFileSync(f.full);
    const sha = await createBlob(buf);
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha });
  }

  // Always include .gitignore
  const gi = ['node_modules/', 'release/', '.env', 'logs.txt', '*.log', 'driver-signed.zip'].join('\n') + '\n';
  tree.push({
    path: '.gitignore',
    mode: '100644',
    type: 'blob',
    sha: await createBlob(Buffer.from(gi, 'utf8')),
  });

  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    tree,
    base_tree: head.treeSha || undefined,
  });

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `chore: publish client ${new Date().toISOString()}`,
    tree: newTree.sha,
    parents: head.commitSha ? [head.commitSha] : [],
  });

  if (head.commitSha) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.sha,
      force: true,
    });
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.sha,
    });
  }

  console.log('OK https://github.com/' + OWNER + '/' + REPO);
  console.log('Commit', commit.sha);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
