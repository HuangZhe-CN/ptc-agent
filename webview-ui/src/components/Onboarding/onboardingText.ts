/**
 * Onboarding 局部文案字典（zh/en）——Task 25。
 * 受控约束：不得修改 i18n.ts（Task 26 统一收口），故本目录组件自带字典；
 * locale 取 useAgentStore 的 state.locale（boot 快照下发）。
 * key 缺失时回退 key 本身，便于发现漏译（与 i18n.ts 约定一致）。
 */
export type ObLocale = 'zh' | 'en'

const zh = {
  'wizard.title': '配置模型服务',
  'wizard.subtitle': '只需三步，连接你的第一个模型',
  'wizard.step': '第 {n} 步 / 共 3 步',
  'step1.title': '选择协议',
  'step1.desc': '选择模型服务的接口协议，Base URL 会预填官方默认值',
  'proto.openai': 'OpenAI 兼容',
  'proto.openai.desc': 'OpenAI / DeepSeek / SiliconFlow / vLLM 等',
  'proto.anthropic': 'Anthropic',
  'proto.anthropic.desc': 'Claude 官方 API 或兼容网关',
  'proto.gemini': 'Gemini',
  'proto.gemini.desc': 'Google AI Studio / Vertex',
  'step2.title': '填写服务信息',
  'form.label': '名称',
  'form.label.hint': '仅用于本地显示',
  'form.baseUrl': 'Base URL',
  'form.apiKey': 'API Key',
  'form.apiKey.hint': '仅保存在系统密钥库中，界面不回显',
  'form.fetchModels': '获取模型列表',
  'form.fetching': '获取中…',
  'form.fetchHint': '填写 Base URL 与 API Key 后可拉取模型列表',
  'form.fetched': '勾选要启用的模型',
  'form.fetchEmpty': '服务未返回任何模型',
  'form.fetchFailed': '获取模型失败',
  'form.models': '模型（{n}）',
  'form.models.hint': '至少添加一个模型：可从列表勾选，或在下方手动添加',
  'form.modelId': '模型 ID',
  'form.modelLabel': '显示名（可选）',
  'form.thinking': '支持思考',
  'form.addModel': '添加',
  'form.removeModel': '移除',
  'form.next': '下一步',
  'form.back': '上一步',
  'form.save': '保存',
  'form.errRequired': '请填写名称与 Base URL，并至少添加一个模型',
  'form.errDup': '模型 ID 已存在',
  'step3.title': '选择默认模型',
  'step3.model': '默认模型',
  'step3.quality': '思考强度',
  'step3.qualityHint': '之后可随时在输入框旁的模型菜单中切换',
  'step3.finish': '完成',
  'quality.low': '低',
  'quality.medium': '中',
  'quality.high': '高',
  'tag.thinking': '思考',
  'manage.title': '模型服务',
  'manage.empty': '还没有配置任何服务',
  'manage.add': '添加服务',
  'manage.modelsCount': '{n} 个模型',
  'manage.keyed': '密钥已保存',
  'manage.nokey': '未保存密钥',
  'manage.active': '使用中',
  'manage.delete': '删除',
  'manage.confirmDelete': '确认删除？',
} as const

const en: Record<keyof typeof zh, string> = {
  'wizard.title': 'Set up a model provider',
  'wizard.subtitle': 'Three steps to connect your first model',
  'wizard.step': 'Step {n} of 3',
  'step1.title': 'Choose a protocol',
  'step1.desc': 'Pick the API protocol; Base URL is prefilled with the official default',
  'proto.openai': 'OpenAI-compatible',
  'proto.openai.desc': 'OpenAI / DeepSeek / SiliconFlow / vLLM, etc.',
  'proto.anthropic': 'Anthropic',
  'proto.anthropic.desc': 'Claude official API or compatible gateways',
  'proto.gemini': 'Gemini',
  'proto.gemini.desc': 'Google AI Studio / Vertex',
  'step2.title': 'Provider details',
  'form.label': 'Label',
  'form.label.hint': 'For local display only',
  'form.baseUrl': 'Base URL',
  'form.apiKey': 'API Key',
  'form.apiKey.hint': 'Stored only in the system secret store, never echoed back',
  'form.fetchModels': 'Fetch models',
  'form.fetching': 'Fetching…',
  'form.fetchHint': 'Fill in Base URL and API Key, then fetch the model list',
  'form.fetched': 'Select the models to enable',
  'form.fetchEmpty': 'The service returned no models',
  'form.fetchFailed': 'Failed to fetch models',
  'form.models': 'Models ({n})',
  'form.models.hint': 'Add at least one model: pick from the list or add manually below',
  'form.modelId': 'Model ID',
  'form.modelLabel': 'Display name (optional)',
  'form.thinking': 'Supports thinking',
  'form.addModel': 'Add',
  'form.removeModel': 'Remove',
  'form.next': 'Next',
  'form.back': 'Back',
  'form.save': 'Save',
  'form.errRequired': 'Label, Base URL and at least one model are required',
  'form.errDup': 'Model ID already exists',
  'step3.title': 'Choose the default model',
  'step3.model': 'Default model',
  'step3.quality': 'Reasoning effort',
  'step3.qualityHint': 'You can change it anytime from the model menu next to the composer',
  'step3.finish': 'Finish',
  'quality.low': 'Low',
  'quality.medium': 'Medium',
  'quality.high': 'High',
  'tag.thinking': 'Thinking',
  'manage.title': 'Model Providers',
  'manage.empty': 'No providers configured yet',
  'manage.add': 'Add provider',
  'manage.modelsCount': '{n} models',
  'manage.keyed': 'API key saved',
  'manage.nokey': 'No API key saved',
  'manage.active': 'Active',
  'manage.delete': 'Delete',
  'manage.confirmDelete': 'Delete?',
}

export type ObKey = keyof typeof zh

/** 与 i18n.normalizeLocale 同规则的局部取词：zh* → zh，其余 → en */
export function ob(locale: string, key: ObKey, params?: Record<string, string | number>): string {
  const dict: Record<ObKey, string> =
    locale && locale.toLowerCase().startsWith('zh') ? (zh as Record<ObKey, string>) : en
  let s = dict[key] ?? (key as string)
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}
