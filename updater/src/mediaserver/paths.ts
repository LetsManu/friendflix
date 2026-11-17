// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** one path component: letters (any script), digits, space and `._-+()&'`, never starting with a dot */
const COMPONENT_RE = /^[\p{L}\p{N} ._\-+()&']+$/u;
const MAX_PATH = 200;
const TARGET_RE = /^\/media(\/[a-z0-9-]{1,40}){1,3}$/;
/** the system trees: the path and everything below it is refused (`/lib*` is handled by prefix, see refusedTree) */
const REFUSED_TREES = ['bin', 'boot', 'dev', 'etc', 'proc', 'root', 'run', 'sbin', 'sys', 'usr'];
const REFUSED_DEEP = [['var', 'run'], ['var', 'lib', 'docker']];
/** top-level trees that hold more than media: refused themselves, a folder below them is fine */
const TOP_ONLY = ['home', 'var', 'opt', 'mnt', 'media', 'srv'];

const okComponent = (c: string): boolean => COMPONENT_RE.test(c) && !c.startsWith('.');

/** the components of an absolute, normalised path ('/' = []); null = bad syntax */
function components(path: string): string[] | null {
  if (path.length > MAX_PATH || !path.startsWith('/')) return null;
  if (path === '/') return [];
  const parts = path.slice(1).split('/');
  return parts.every(okComponent) ? parts : null;
}

const startsWith = (parts: readonly string[], prefix: readonly string[]): boolean => prefix.length <= parts.length && prefix.every((p, i) => parts[i] === p);

function refusedTree(c: readonly string[]): boolean {
  if (c.length === 0) return true;
  const top = c[0]!;
  if (REFUSED_TREES.includes(top) || /^lib/.test(top)) return true;
  if (REFUSED_DEEP.some((d) => startsWith(c, d))) return true;
  if (c.length === 1 && (TOP_ONLY.includes(top) || /^volume[0-9]+$/.test(top))) return true;
  return false;
}

function parts(path: string | null): string[] | null {
  return path === null ? null : components(path);
}

/**
 * Syntax and refused places of a media base path (spec "Refused bases"): `path_invalid` for syntax, `path_refused` for the system trees,
 * the top-level trees themselves, anything that contains, equals or lies below the Docker root, and anything that contains or equals the
 * stack directory. null = acceptable.
 */
export function checkBasePath(path: string, f: { dockerRoot: string | null; stackDir: string | null }): null | 'path_invalid' | 'path_refused' {
  const c = components(path);
  if (c === null) return 'path_invalid';
  if (refusedTree(c)) return 'path_refused';
  const docker = parts(f.dockerRoot);
  if (docker && (startsWith(c, docker) || startsWith(docker, c))) return 'path_refused';
  const stack = parts(f.stackDir);
  if (stack && startsWith(stack, c)) return 'path_refused';
  return null;
}

/** a folder path below the base: `min` to `max` components (each as in a base path), at most 200 characters, relative, no trailing slash */
export function isRel(rel: string, min: number, max: number): boolean {
  if (rel.length > MAX_PATH) return false;
  if (rel === '') return min === 0;
  const p = rel.split('/');
  return p.length >= min && p.length <= max && p.every(okComponent);
}

/** the mount point inside the media server: /media/<slug> up to three levels */
export function isTarget(t: string): boolean {
  return TARGET_RE.test(t);
}

/** whether one folder equals or lies below another (the check is on whole components: Filme and Filmeklassiker are not nested) */
export function nestedFolders(rels: readonly string[]): boolean {
  return rels.some((a, i) => rels.some((b, j) => i !== j && (a === b || a.startsWith(b + '/'))));
}
