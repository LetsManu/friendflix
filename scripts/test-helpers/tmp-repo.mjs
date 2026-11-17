// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helper (not a test file: importing a *.test.mjs would re-run its tests): throwaway git repositories, removed after the run.
import { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_C = ['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main'];

const created = [];
after(() => { for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** a throwaway git repository: write files, commit, branch, merge --no-ff, git mv, revert; every helper that commits returns the new sha */
export function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ff-changed-images-'));
  created.push(root);
  const git = (...args) => execFileSync('git', [...GIT_C, '-C', root, ...args], { encoding: 'utf8' }).trim();
  const head = () => git('rev-parse', 'HEAD');
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  git('init', '-q');
  return {
    root,
    git,
    head,
    write,
    /** writes `files`, stages everything and commits */
    commit(message, files = {}) { write(files); git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', message); return head(); },
    branch(name) { git('checkout', '-q', '-b', name); },
    checkout(name) { git('checkout', '-q', name); },
    merge(name, message = `Merge ${name}`) { git('merge', '-q', '--no-ff', '-m', message, name); return head(); },
    mv(from, to, message = `move ${from}`) { mkdirSync(dirname(join(root, to)), { recursive: true }); git('mv', from, to); git('commit', '-q', '-m', message); return head(); },
    revert(sha) { git('revert', '--no-edit', sha); return head(); },
  };
}
