// 「不给 --model 时用哪个 embedding」的优先级。
//
// 这条链的最后两层（环境变量覆盖的默认、内置默认）是「零手动配置建索引」的
// 全部依据：一台干净机器的 `~/.zvec-grep/config.json` 并不存在，zg 又要求
// 新索引必须显式给 --embedding。漏掉兜底 → 「添加目录 → 更新索引」直接失败，
// 用户就得自己去配模型——这正是我们要消除的「额外手动操作」。
// 反过来，兜底绝不能顶掉用户明确给的值，所以顺序也要钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbeddingModel } from '../../src/modules/kb/service.js';
import { DEFAULT_EMBEDDING, EMBEDDING_ENV } from '../../src/core/paths.js';

// 每条用例都自行设置/还原环境变量，避免互相污染
function withEnv(value, fn) {
  const prev = process.env[EMBEDDING_ENV];
  if (value === undefined) delete process.env[EMBEDDING_ENV];
  else process.env[EMBEDDING_ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[EMBEDDING_ENV];
    else process.env[EMBEDDING_ENV] = prev;
  }
}

test('优先级：命令行 --model 压过一切', () => {
  withEnv('local/from-env', () => {
    assert.equal(
      resolveEmbeddingModel({ explicit: 'qwen/text-embedding-v4', current: 'a', recorded: 'b' }),
      'qwen/text-embedding-v4'
    );
  });
});

test('优先级：已建索引里实际生效的模型 > 登记时记的 > 默认', () => {
  assert.equal(resolveEmbeddingModel({ current: 'local/current', recorded: 'local/recorded' }), 'local/current');
  assert.equal(resolveEmbeddingModel({ recorded: 'local/recorded' }), 'local/recorded');
});

test('都没有时回落到内置默认（干净机器零配置建索引的前提）', () => {
  withEnv(undefined, () => {
    assert.equal(resolveEmbeddingModel({}), DEFAULT_EMBEDDING);
    assert.equal(resolveEmbeddingModel(), DEFAULT_EMBEDDING);
  });
});

test('环境变量 NX_KN_EMBEDDING 可覆盖内置默认（CI / 内网逃生舱）', () => {
  withEnv('local/potion-code-16m-v2', () => {
    assert.equal(resolveEmbeddingModel({}), 'local/potion-code-16m-v2');
    // 但压不过「已建索引里实际生效的」——换模型是显式动作，不能被环境变量偷袭
    assert.equal(resolveEmbeddingModel({ current: 'local/current' }), 'local/current');
  });
});

test('环境变量为空白时不算数（回落内置默认，而不是用空串去建索引）', () => {
  withEnv('   ', () => {
    assert.equal(resolveEmbeddingModel({}), DEFAULT_EMBEDDING);
  });
});
