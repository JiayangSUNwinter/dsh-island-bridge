#!/usr/bin/env node
/**
 * 预编译原生面板 helper。
 *
 * 运行时桥接会在 helper 源码哈希变化时自动调用 swiftc 编译；本脚本用于
 * 开发时手动编译，或在不希望宿主进程里触发编译的环境里预热二进制。
 *
 * 用法：
 *   node scripts/build-helper.mjs                 # 编译到 <DSH_HOME>/dsh-island-bridge/island-helper
 *   node scripts/build-helper.mjs --out ./build   # 编译到指定目录
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'helper', 'island-helper.swift');

const outIndex = process.argv.indexOf('--out');
const outDir = outIndex > -1
  ? path.resolve(process.argv[outIndex + 1] ?? '.')
  : path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'dsh-island-bridge');

if (process.platform !== 'darwin') {
  console.error('dsh-island-bridge 只支持 macOS（需要 AppKit/NSWindow）。');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const binary = path.join(outDir, 'island-helper');
// 先编到临时文件再原子重命名：旧 helper 正在运行时不能原地覆盖（ETXTBSY）
const staging = `${binary}.building-${process.pid}`;

console.log('编译', source, '→', binary);
try {
  execFileSync('swiftc', ['-O', '-o', staging, source], { stdio: 'inherit', timeout: 120_000 });
  fs.renameSync(staging, binary);
} finally {
  try { fs.unlinkSync(staging); } catch {}
}

const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 32);
fs.writeFileSync(binary + '.sha256', hash + '\n');
console.log('完成：', binary, '（源码哈希', hash + '）');
