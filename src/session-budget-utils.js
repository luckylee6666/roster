/**
 * 会话体积徽标（纯展示逻辑）。
 *
 * 档位由后端 `session_budget` 算好——窗口表和换算比都只在 Rust 侧登记一份，前端不重复
 * 判断，只把它变成能读的一小块文字。**估算值必须写"估算"**，别当成精确 token 用。
 */

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function formatSessionBytes(bytes) {
  const n = count(bytes);
  if (!n) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

export function formatSessionTokens(tokens) {
  const n = count(tokens);
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${Math.round(n)}`;
}

/** 后端字段原样归一到前端形状；缺字段一律按 0/空处理，不猜。 */
export function normalizeSessionBudget(raw) {
  return {
    sizeBytes: count(raw?.sizeBytes),
    estTokens: count(raw?.estTokens),
    window: count(raw?.window),
    band: String(raw?.band || ''),
  };
}

/**
 * 体积徽标：只有 `long` / `over` 才显示，`ok` 与拿不到体积时返回 null（不制造噪声）。
 */
export function sessionBudgetBadge(raw) {
  const budget = normalizeSessionBudget(raw);
  if (budget.band !== 'long' && budget.band !== 'over') return null;
  const size = formatSessionBytes(budget.sizeBytes);
  if (!size) return null;
  const tokens = formatSessionTokens(budget.estTokens);
  const window = formatSessionTokens(budget.window);
  const detail = tokens ? `估算 ≈${tokens} tokens` : '估算值不可用';
  const limit = window ? `登记的窗口 ${window} tokens` : '这家 CLI 没有登记窗口';
  const title = budget.band === 'over'
    ? `${size} · ${detail}，已达到${limit}——继续很可能直接失败（上下文超限），建议开新会话`
    : `${size} · ${detail}，接近${limit}——再长下去会变慢，也可能触发压缩或直接失败`;
  return { text: size, level: budget.band, title };
}

/** 续接前的拦截判据：只有 `over` 才需要拦。 */
export function sessionBudgetOver(raw) {
  return normalizeSessionBudget(raw).band === 'over';
}
