import { ModelSettingsSchema, ModelProfileSchema, ModelAPIKeySchema, type ModelSettings } from '@verdict/protocol';
import { ApiError, primary, request } from '../api';
import { modelSettingsView, modelRoles, type ModelRole } from './view';
import './settings.css';

const messages: Record<string, string> = {
  MODEL_SETTINGS_CHANGED: '配置已在其他页面更新，请刷新后再保存。',
  MODEL_SETTINGS_BUSY: '有任务正在运行或等待签名，请完成或取消后再保存。',
  MODEL_API_KEY_REQUIRED: '请填写 API Key。',
  MODEL_KEY_REQUIRED_FOR_NEW_ENDPOINT: 'API 地址已更改，请重新填写该地址的 API Key。',
  MODEL_SETTINGS_SAVE_FAILED: '配置未保存，请稍后重试。',
  INVALID_INPUT: '请检查 API 地址、模型名称和参数。',
  DEFENSE_API_REQUIRED: '当前实例不开放模型设置。',
};

export function mountModelSettings(root: HTMLElement) {
  root.innerHTML = modelSettingsView();
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  let snapshot: ModelSettings | null = null;
  let loading = false, saving: ModelRole | null = null, generation = 0;
  const dirty = new Set<ModelRole>();
  const notice = (message = '') => { $('models-notice').textContent = message; $('models-notice').hidden = !message; };
  function setError(role: ModelRole, message = '') { $(role + '-error').textContent = message; $(role + '-error').hidden = !message; }
  function state() {
    for (const role of modelRoles) {
      $<HTMLFieldSetElement>(role + '-fields').disabled = !snapshot || loading || !!saving;
      $(role + '-save').textContent = saving === role ? '正在保存…' : '保存设置 →';
      $(role + '-save-state').textContent = dirty.has(role) ? '尚未保存' : '';
      $('model-' + role).dataset.dirty = String(dirty.has(role));
    }
    $<HTMLButtonElement>('models-refresh').disabled = loading || !!saving;
  }
  function draw(role: ModelRole, fill: boolean) {
    if (!snapshot) return;
    const profile = snapshot[role];
    $(role + '-current').textContent = profile?.modelId ?? '未配置';
    $(role + '-state').textContent = profile?.hasApiKey ? '已配置' : '未配置';
    $(role + '-state').dataset.state = profile?.hasApiKey ? 'ready' : 'offline';
    $(role + '-source').textContent = profile?.source === 'TEST_TRANSPORT' ? 'TEST_TRANSPORT' : '';
    $(role + '-key-state').textContent = profile?.hasApiKey ? '已保存' : '未设置';
    const key = $<HTMLInputElement>(role + '-apiKey');
    key.placeholder = profile?.hasApiKey ? '留空保留已有密钥' : '输入 API Key';
    if (fill) {
      $<HTMLInputElement>(role + '-baseURL').value = profile?.baseURL ?? '';
      $<HTMLInputElement>(role + '-modelId').value = profile?.modelId ?? '';
      $<HTMLSelectElement>(role + '-compatibility').value = profile?.compatibility ?? 'openai';
      $<HTMLInputElement>(role + '-requestTimeoutMs').value = String((profile?.requestTimeoutMs ?? 90000) / 1000);
      $<HTMLInputElement>(role + '-outputTokens').value = String(profile?.outputTokens ?? 1024);
      key.value = '';
    }
    keyRequirement(role);
  }
  function keyRequirement(role: ModelRole) {
    const changed = !!snapshot?.[role] && $<HTMLInputElement>(role + '-baseURL').value.trim() !== snapshot[role]!.baseURL;
    $<HTMLInputElement>(role + '-apiKey').required = !snapshot?.[role]?.hasApiKey || changed;
    $(role + '-key-hint').textContent = changed ? '地址已更改，请填写新地址的密钥' : '密钥保存在服务端';
  }
  function explain(error: unknown) {
    if (error instanceof ApiError) {
      const code = error.message.split(' · ').at(-1)!;
      if (messages[code]) return messages[code];
      if (error.status === 404) return '当前服务不支持模型设置，请连接已更新的服务。';
      if (error.status === 403) return '当前服务不允许修改模型配置。';
    }
    return '服务连接中断，请重试。';
  }
  async function refresh() {
    if (loading || saving) return;
    loading = true; state(); notice();
    const currentGeneration = ++generation;
    try {
      snapshot = ModelSettingsSchema.parse(await request(primary, '/api/settings/models'));
      if (currentGeneration !== generation) return;
      for (const role of modelRoles) { draw(role, !dirty.has(role)); setError(role); }
    } catch (error) {
      snapshot = null;
      for (const role of modelRoles) { $(role + '-state').textContent = '不可用'; $(role + '-state').dataset.state = 'offline'; }
      notice(explain(error));
    } finally { loading = false; state(); }
  }
  for (const role of modelRoles) {
    const form = $<HTMLFormElement>('model-' + role);
    form.addEventListener('input', () => { dirty.add(role); setError(role); keyRequirement(role); state(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!snapshot || saving || loading || !form.reportValidity()) return;
      const profile = ModelProfileSchema.safeParse({
        baseURL: $<HTMLInputElement>(role + '-baseURL').value.trim(),
        modelId: $<HTMLInputElement>(role + '-modelId').value.trim(),
        compatibility: $<HTMLSelectElement>(role + '-compatibility').value,
        requestTimeoutMs: Number($<HTMLInputElement>(role + '-requestTimeoutMs').value) * 1000,
        outputTokens: Number($<HTMLInputElement>(role + '-outputTokens').value),
      });
      if (!profile.success) { setError(role, '请使用 HTTPS 或本机 HTTP 地址，并检查模型名称和参数。'); return; }
      const apiKey = $<HTMLInputElement>(role + '-apiKey').value.trim();
      if (apiKey && !ModelAPIKeySchema.safeParse(apiKey).success) { setError(role, 'API Key 格式不正确。'); return; }
      saving = role; state(); setError(role); notice();
      try {
        const next = ModelSettingsSchema.parse(await request(primary, '/api/settings/models/' + role, {
          revision: snapshot.revision, profile: profile.data, ...(apiKey ? { apiKey } : {}),
        }));
        snapshot = next; dirty.delete(role);
        for (const item of modelRoles) draw(item, !dirty.has(item));
        window.dispatchEvent(new Event('verdict:models-updated'));
      } catch (error) {
        setError(role, error instanceof ApiError ? explain(error) : '保存结果尚未确认，请刷新配置后核对。');
      } finally {
        $<HTMLInputElement>(role + '-apiKey').value = '';
        saving = null; state();
        if (!dirty.has(role)) $(role + '-save-state').textContent = '已保存并生效';
      }
    });
  }
  $('models-refresh').addEventListener('click', () => void refresh());
  const clearKeys = () => { for (const role of modelRoles) $<HTMLInputElement>(role + '-apiKey').value = ''; };
  window.addEventListener('pagehide', clearKeys);
  window.addEventListener('hashchange', () => {
    if (location.hash.split('?')[0] !== '#settings') clearKeys();
    else void refresh();
  });
  void refresh();
}
