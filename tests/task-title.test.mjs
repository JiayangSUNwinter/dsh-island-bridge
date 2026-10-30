import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTitle } from '../lib/task-title.js';

test('默认标题使用完整首条人类消息，超过原先前缀仍保留', () => {
  const full = '你刚才其他对话里网络连接报错，请检查连接原因并修复这个问题，保留现有配置';
  assert.equal(taskTitle({ title: full.slice(0, 15), source: { kind: 'fallback' } }, full), full);
});
test('手动、模型生成和旧版未知来源的标题均保留原文', () => {
  for (const source of [{ kind: 'user' }, { kind: 'provider' }, undefined]) {
    assert.equal(taskTitle({ title: '用户选定的名称', source }, '非常长的原始提问'), '用户选定的名称');
  }
});
test('首条消息或投影不可用时保留DSH标题', () => {
  for (const prompt of [undefined, null, '', ' \n ']) {
    assert.equal(taskTitle({ title: '已有标题', source: { kind: 'fallback' } }, prompt), '已有标题');
  }
});
test('完整标题保持单行并去掉终端和方向控制符，不破坏中文和emoji', () => {
  assert.equal(taskTitle({ source: { kind: 'fallback' } }, '\u001b[31m检查\u001b[0m\n网络\u202e 👩‍💻'), '检查 网络 👩‍💻');
});
