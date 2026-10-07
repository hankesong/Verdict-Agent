import { symbol } from '../shell';

export type ModelRole = 'guard';
export const modelRoles: ModelRole[] = ['guard'];
const titles: Record<ModelRole, string> = { guard: '审查 Agent' };
const descriptions: Record<ModelRole, string> = { guard: '检查交易与授权条件' };

function profileCard(role: ModelRole) {
  return `<form class="model-card" id="model-${role}" data-model-role="${role}">
    <div class="model-card-heading"><span class="model-icon">${symbol('shield')}</span><div><h2>${titles[role]}</h2><p>${descriptions[role]}</p></div><span class="model-state" id="${role}-state">读取中</span></div>
    <div class="model-current"><span>当前模型</span><strong id="${role}-current">—</strong><span id="${role}-source"></span></div>
    <fieldset id="${role}-fields" disabled>
      <label for="${role}-baseURL">API 地址</label><input id="${role}-baseURL" name="baseURL" type="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" maxlength="2048" required>
      <div class="model-field-grid"><div><label for="${role}-modelId">模型名称</label><input id="${role}-modelId" name="modelId" placeholder="输入模型 ID" autocomplete="off" spellcheck="false" maxlength="160" required></div><div><label for="${role}-compatibility">接口格式</label><select id="${role}-compatibility" name="compatibility"><option value="openai">OpenAI 兼容</option><option value="glm">GLM</option></select></div></div>
      <div class="model-secret-field" id="${role}-secret-field"><label for="${role}-apiKey">API Key <span id="${role}-key-state"></span></label><input id="${role}-apiKey" name="apiKey" type="password" placeholder="输入 API Key" autocomplete="new-password" spellcheck="false" maxlength="4096"><p class="model-field-hint" id="${role}-key-hint" hidden></p></div>
      <details class="model-advanced"><summary>高级设置 <span>⌄</span></summary><div class="model-field-grid"><div><label for="${role}-requestTimeoutMs">请求超时（秒）</label><input id="${role}-requestTimeoutMs" name="timeout" type="number" value="90" min="0.001" max="120" step="0.001" required></div><div><label for="${role}-outputTokens">最大输出 Token</label><input id="${role}-outputTokens" name="outputTokens" type="number" value="1024" min="64" max="1024" step="1" required></div></div></details>
      <div class="model-actions"><span class="model-save-state" id="${role}-save-state" role="status"></span><button class="product-primary" id="${role}-save" type="submit">保存设置 ${symbol('arrow')}</button></div>
    </fieldset><p class="model-error" id="${role}-error" role="alert" hidden></p>
  </form>`;
}

export function modelSettingsView() {
  return `<div class="model-settings"><div class="model-page-heading"><div><div class="product-eyebrow">VERDICT / MODELS</div><h1>模型设置</h1></div><button type="button" class="product-quiet" id="models-refresh">刷新配置 ↻</button></div><p id="models-notice" class="model-notice" role="status" hidden></p><div class="model-grid">${modelRoles.map(profileCard).join('')}</div></div>`;
}
