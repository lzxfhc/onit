import {
  AVAILABLE_LOCAL_MODELS,
  AVAILABLE_MODELS,
  CODING_PLAN_PROVIDERS,
} from '../types'
import type { ApiConfig, BillingMode, CodingPlanProvider } from '../types'

export const CUSTOM_API_MODEL_VALUE = '__custom_api_model__'
export const DEFAULT_API_CALL_MODEL = 'ernie-4.5-8k'
export const LEGACY_CODING_PLAN_MODEL = 'qianfan-code-latest'

export function isApiCallPresetModel(modelId: string): boolean {
  return AVAILABLE_MODELS.some(model => !model.codingPlan && model.id === modelId)
}

export function isApiCallCustomModel(modelId: string | undefined | null): boolean {
  return Boolean(modelId)
    && modelId !== LEGACY_CODING_PLAN_MODEL
    && !isApiCallPresetModel(modelId || '')
}

export function getApiCallSelectValue(modelId: string): string {
  return isApiCallPresetModel(modelId) ? modelId : CUSTOM_API_MODEL_VALUE
}

export function getCodingPlanModel(provider?: CodingPlanProvider): string {
  const config = CODING_PLAN_PROVIDERS.find(item => item.id === (provider || 'qianfan'))
  return config?.model || LEGACY_CODING_PLAN_MODEL
}

export function getDefaultSessionModel(apiConfig: Partial<ApiConfig>): string {
  if (apiConfig.billingMode === 'local-model') {
    const local = AVAILABLE_LOCAL_MODELS.find(model => model.id === apiConfig.localModelId)
    return apiConfig.model || local?.name || AVAILABLE_LOCAL_MODELS[0]?.name || ''
  }

  if (apiConfig.billingMode === 'api-call') {
    return apiConfig.model && apiConfig.model !== LEGACY_CODING_PLAN_MODEL
      ? apiConfig.model
      : DEFAULT_API_CALL_MODEL
  }

  return getCodingPlanModel(apiConfig.codingPlanProvider)
}

export function getModelChoices(apiConfig: Partial<ApiConfig>) {
  if (apiConfig.billingMode === 'coding-plan') {
    const modelId = getCodingPlanModel(apiConfig.codingPlanProvider)
    const provider = CODING_PLAN_PROVIDERS.find(item => item.model === modelId)
    return [{ id: modelId, name: provider ? `${provider.name} Code` : modelId }]
  }

  if (apiConfig.billingMode === 'api-call') {
    return AVAILABLE_MODELS
      .filter(model => !model.codingPlan)
      .map(model => ({ id: model.id, name: model.name }))
  }

  return []
}

export function getModelDisplayName(modelId: string, billingMode: BillingMode, apiConfig?: Partial<ApiConfig>): string {
  if (billingMode === 'local-model') {
    const local = AVAILABLE_LOCAL_MODELS.find(model => model.id === apiConfig?.localModelId)
    return local?.displayName || modelId
  }

  if (billingMode === 'coding-plan') {
    const provider = CODING_PLAN_PROVIDERS.find(item => item.model === modelId)
    return provider ? `${provider.name} Code` : modelId
  }

  return AVAILABLE_MODELS.find(model => model.id === modelId)?.name || modelId
}
