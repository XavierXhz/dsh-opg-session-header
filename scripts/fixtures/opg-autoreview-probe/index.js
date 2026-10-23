/**
 * 一次性验证插件（不属于交付物）：在 tools/pre-execute（与官方 auto-review 相同的
 * 调用栈位置、同在 agents.withInitiator 作用域内）发出一条**无 sessionId** 的
 * opencode-go 流式请求，把结果写到 /tmp/opg-autoreview-probe.json。
 */
import { writeFileSync } from 'node:fs';

const name = 'opg-autoreview-probe';
const inject = ['llm', 'agents'];
const OUT = '/tmp/opg-autoreview-probe.json';

function apply(ctx) {
  let fired = false;
  ctx.on('tools/pre-execute', (exec, next) => {
    if (fired) return next();
    fired = true;
    void probe(ctx, exec);
    return next();
  }, { prepend: true });
}

async function probe(ctx, exec) {
  const out = { at: new Date().toISOString(), tool: exec?.name };
  try {
    out.initiator = ctx.agents.currentInitiator()?.session?.id ?? null;
  } catch (error) {
    out.initiatorError = String(error?.message ?? error);
  }
  try {
    out.preset = ctx.permissionPresets?.current?.(exec?.agent?.session) ?? null;
  } catch (error) {
    out.presetError = String(error?.message ?? error);
  }
  try {
    let text = '';
    let finished = null;
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      system: 'Reply with the single word ok.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'reply ok' }] }],
      temperature: 0,
      maxTokens: 32,
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text;
      if (chunk?.type === 'finish') finished = chunk.reason?.kind ?? chunk.reason ?? null;
    }
    out.ok = true;
    out.text = text.slice(0, 200);
    out.finish = finished;
  } catch (error) {
    out.ok = false;
    out.error = error instanceof Error ? `${error.code ?? ''} ${error.message}`.trim() : String(error);
  }
  try {
    writeFileSync(OUT, JSON.stringify(out, null, 2));
  } catch (error) {
    console.error('probe write failed', error);
  }
}

export { apply, inject, name };
