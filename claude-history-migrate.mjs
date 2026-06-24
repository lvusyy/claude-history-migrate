#!/usr/bin/env node
/**
 * claude-history-migrate
 * -----------------------
 * Restore Claude Code conversation history + memory when moving projects between
 * machines (or relocating them on the same machine).
 *
 * It writes ONLY into <dest>/<encoded-project-dir>/ . It never touches
 * ~/.claude/.credentials.json or ~/.claude.json, so your login stays intact.
 *
 * What it handles (every gotcha learned the hard way):
 *   1. Directory encoding   - Claude stores a project's history under
 *                             ~/.claude/projects/<encoded> where
 *                             encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
 *                             (case-preserving; '_' '.' ':' '\\' '/' all -> '-').
 *   2. Path remapping       - if a project moved to a new path, the dir is
 *                             re-encoded for the NEW path and the internal
 *                             "cwd" fields are rewritten so resume works.
 *   3. entrypoint filter    - /resume HIDES sessions whose entrypoint is one of
 *                             {sdk-ts, sdk-cli, sdk-py}. Sessions produced by the
 *                             Agent SDK / workflow tools (e.g. maestro, ccw) carry
 *                             entrypoint=sdk-ts and never show up in the picker.
 *                             This tool rewrites them to "cli" so they appear.
 *   4. Auth safety          - only the destination projects dir is written.
 *
 * Usage:
 *   node claude-history-migrate.mjs --source <oldProjectsDir> [options]
 *
 * Run with no --apply first: it prints a dry-run plan and changes nothing.
 *
 * Options:
 *   --source <dir>        (required) The old machine's projects folder. Accepts
 *                         a ".../.claude/projects" dir, or a folder that contains
 *                         "projects/" or ".claude/projects/" (e.g. an extracted
 *                         backup). Extract your .tar/.zip backup first.
 *   --dest <dir>          Destination projects dir. Default: <home>/.claude/projects
 *   --map "<old>=<new>"   Path-prefix remap rule (repeatable). Example:
 *                         --map "D:\\codeBase=D:\\tmp"
 *                         --map "C:\\Users\\OldUser=C:\\Users\\NewUser"
 *                         Longest matching prefix wins; unmatched projects keep
 *                         their original path.
 *   --only <a,b,...>      Only process these SOURCE project dir names.
 *   --require-exists      Skip projects whose (remapped) path does not exist on
 *                         disk (i.e. only migrate projects you actually have here).
 *   --no-entrypoint-fix   Do NOT rewrite sdk-* entrypoints to cli (NOT advised;
 *                         leaving it means /resume will hide SDK/workflow sessions).
 *   --overwrite           Overwrite existing session files in the destination
 *                         (default: keep existing, only add missing ones).
 *   --apply               Actually perform the migration (default is dry-run).
 *   -h, --help            Show this help.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HELP = `claude-history-migrate - migrate Claude Code history & memory across machines

Usage:
  node claude-history-migrate.mjs --source <oldProjectsDir> [options]

Dry-run by default (prints a plan, writes nothing). Add --apply to write.
Only ever writes into <dest>/<encoded-project-dir>/. Never touches your login
(~/.claude/.credentials.json or ~/.claude.json).

Options:
  --source <dir>        (required) old machine's projects folder. Accepts a
                        ".../.claude/projects" dir or a folder containing it
                        (extract your .tar/.zip backup first).
  --dest <dir>          destination projects dir (default: <home>/.claude/projects)
  --map "<old>=<new>"   path-prefix remap rule, repeatable. Longest prefix wins:
                          --map "D:\\codeBase=D:\\tmp"
                          --map "C:\\Users\\Old=C:\\Users\\New"
  --only <a,b,...>      only process these source project dir names
  --require-exists      skip projects whose remapped path is absent on this machine
  --no-entrypoint-fix   do NOT rewrite sdk-* entrypoints to "cli" (not advised:
                        /resume hides SDK/workflow sessions otherwise)
  --overwrite           overwrite existing destination files (default: keep them)
  --apply               perform the migration (omit for a dry-run preview)
  -h, --help            show this help

After migrating, open a project and run /resume to verify its history appears.`;

// ---------- core rules (the Claude Code conventions) ----------
const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-'); // project path -> dir name
const jsonEsc = (p) => p.replace(/\\/g, '\\\\');       // backslashes as they appear inside JSONL
const ENTRYPOINT_BLOCKED = ['sdk-ts', 'sdk-cli', 'sdk-py']; // hidden by /resume
const TEXT_EXT = new Set(['.jsonl', '.json']);          // files we rewrite (cwd / entrypoint)

// ---------- tiny arg parser ----------
function parseArgs(argv) {
  const o = { map: [], apply: false, fixEntrypoint: true, requireExists: false, overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--source') o.source = next();
    else if (a === '--dest') o.dest = next();
    else if (a === '--map') o.map.push(next());
    else if (a === '--only') o.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--require-exists') o.requireExists = true;
    else if (a === '--no-entrypoint-fix') o.fixEntrypoint = false;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

function die(msg) { console.error('error: ' + msg); process.exit(1); }

// ---------- locate the source projects dir ----------
function resolveProjectsDir(src) {
  for (const c of [src, path.join(src, 'projects'), path.join(src, '.claude', 'projects')]) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      const hasChildDirs = fs.readdirSync(c, { withFileTypes: true }).some((e) => e.isDirectory());
      if (hasChildDirs) return c;
    }
  }
  return null;
}

// read first N bytes of a file and return complete lines (bounded memory for huge files)
function readHeadLines(file, maxBytes = 1 << 20) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    let s = buf.toString('utf8');
    if (len < size) s = s.slice(0, s.lastIndexOf('\n') + 1); // drop trailing partial line
    return s.split('\n').filter(Boolean);
  } finally { fs.closeSync(fd); }
}

function topLevelJsonl(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name));
}

// Recover the TRUE old project path from the cwd recorded inside the sessions.
// encode() is length-preserving, so the project root is exactly the first
// dirName.length characters of any cwd under it -- this works even when every
// recorded cwd is a sub-directory of the project (session ran in a subfolder).
function detectOldPath(projDir, dirName) {
  const files = topLevelJsonl(projDir).sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  for (const f of files.slice(0, 6)) {
    for (const ln of readHeadLines(f)) {
      let obj; try { obj = JSON.parse(ln); } catch { continue; }
      const cwd = obj && obj.cwd;
      if (typeof cwd === 'string' && cwd.length >= dirName.length) {
        const root = cwd.slice(0, dirName.length);
        if (encode(root) === dirName) return root;
      }
    }
  }
  return null; // memory-only project, or path not recoverable
}

// longest-prefix remap
function remap(oldPath, rules) {
  let best = null;
  for (const r of rules) {
    if (oldPath === r.from || oldPath.startsWith(r.from + '\\') || oldPath.startsWith(r.from + '/')) {
      if (!best || r.from.length > best.from.length) best = r;
    }
  }
  return best ? best.to + oldPath.slice(best.from.length) : oldPath;
}

// rewrite a JSONL/JSON file's text: cwd prefix + blocked entrypoints
function transform(text, oldPath, newPath, fixEntrypoint) {
  let t = text;
  if (oldPath && newPath && oldPath !== newPath) {
    // prefix replace inside the cwd field; handles the project root and every subdir cwd
    t = t.split('"cwd":"' + jsonEsc(oldPath)).join('"cwd":"' + jsonEsc(newPath));
  }
  if (fixEntrypoint) {
    for (const v of ENTRYPOINT_BLOCKED) {
      t = t.split('"entrypoint":"' + v + '"').join('"entrypoint":"cli"');
    }
  }
  return t;
}

// recursively copy a project dir, transforming text files
function copyProject(srcDir, dstDir, oldPath, newPath, opt, stats) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    if (e.isDirectory()) { copyProject(s, d, oldPath, newPath, opt, stats); continue; }
    if (!e.isFile()) continue;
    if (fs.existsSync(d) && !opt.overwrite) { stats.skipped++; continue; }
    if (TEXT_EXT.has(path.extname(e.name))) {
      const out = transform(fs.readFileSync(s, 'utf8'), oldPath, newPath, opt.fixEntrypoint);
      fs.writeFileSync(d, out);
    } else {
      fs.copyFileSync(s, d); // memory .md, etc. copied verbatim
    }
    stats.copied++;
  }
}

// ---------- main ----------
function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.source) {
    console.log(HELP);
    process.exit(opt.help ? 0 : 1);
  }

  const projectsDir = resolveProjectsDir(opt.source);
  if (!projectsDir) die(`could not find a projects folder under: ${opt.source}\n` +
    `(point --source at the old ".../.claude/projects", or a folder containing it)`);

  const dest = opt.dest || path.join(os.homedir(), '.claude', 'projects');
  const rules = opt.map.map((m) => {
    const i = m.indexOf('=');
    if (i < 0) die(`bad --map (expected old=new): ${m}`);
    return { from: m.slice(0, i).trim(), to: m.slice(i + 1).trim() };
  });

  console.log(`source : ${projectsDir}`);
  console.log(`dest   : ${dest}`);
  console.log(`mode   : ${opt.apply ? 'APPLY' : 'DRY-RUN (no changes; add --apply to write)'}`);
  if (rules.length) console.log('remap  :\n' + rules.map((r) => `         ${r.from}  ->  ${r.to}`).join('\n'));
  console.log('safety : credentials and ~/.claude.json are never touched\n');

  let names = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  if (opt.only) names = names.filter((n) => opt.only.includes(n));
  names.sort();

  const plan = [];
  for (const name of names) {
    const srcDir = path.join(projectsDir, name);
    const oldPath = detectOldPath(srcDir, name);
    const newPath = oldPath ? remap(oldPath, rules) : null;
    const newName = newPath ? encode(newPath) : name;     // memory-only -> keep original name
    const sessions = topLevelJsonl(srcDir).length;
    const exists = newPath ? fs.existsSync(newPath) : false;
    const skip = opt.requireExists && newPath && !exists;
    plan.push({ name, oldPath, newPath, newName, sessions, exists, skip });
  }

  // ----- report -----
  const col = (s, w) => String(s ?? '').padEnd(w);
  console.log(col('SOURCE DIR', 30) + col('SESS', 5) + col('-> TARGET DIR', 32) + col('NEW PATH?', 12) + 'NOTE');
  for (const p of plan) {
    const note = p.skip ? 'SKIP (--require-exists, path absent)'
      : !p.oldPath ? 'memory-only / path not recovered -> kept as-is'
        : p.newPath !== p.oldPath ? 'REMAPPED (cwd will be rewritten)'
          : '';
    console.log(col(p.name, 30) + col(p.sessions, 5) + col('-> ' + p.newName, 32) +
      col(p.newPath ? (p.exists ? 'exists' : 'MISSING') : 'n/a', 12) + note);
  }
  console.log('');

  if (!opt.apply) {
    console.log('dry-run only. Re-run with --apply to perform the migration.');
    return;
  }

  // ----- apply -----
  const stats = { projects: 0, copied: 0, skipped: 0 };
  for (const p of plan) {
    if (p.skip) continue;
    const srcDir = path.join(projectsDir, p.name);
    const dstDir = path.join(dest, p.newName);
    copyProject(srcDir, dstDir, p.oldPath, p.newPath, opt, stats);
    stats.projects++;
    console.log(`migrated ${p.name} -> ${p.newName}` +
      (p.newPath !== p.oldPath && p.oldPath ? `  (cwd ${p.oldPath} -> ${p.newPath})` : ''));
  }
  console.log(`\ndone. projects=${stats.projects}, files copied=${stats.copied}, files kept(existing)=${stats.skipped}`);
  console.log('open a migrated project and run /resume to verify its history appears.');
}

try { main(); } catch (e) { die(e.message); }
