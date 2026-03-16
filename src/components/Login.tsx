import { useState, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import type { ApiConfig, BillingMode, CodingPlanProvider, LocalModelState } from '../types'
import { AVAILABLE_MODELS, CODING_PLAN_PROVIDERS, AVAILABLE_LOCAL_MODELS } from '../types'
import { Zap, Key, Globe, ChevronDown, ArrowRight, Download, CheckCircle2, Loader2, X, Cpu, HardDrive } from 'lucide-react'

function formatFileSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '...'
  const mb = bytesPerSec / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`
}

export default function Login() {
  const { login, settings } = useSettingsStore()
  const saved = settings.apiConfig
  const [billingMode, setBillingMode] = useState<BillingMode>(saved.billingMode || 'coding-plan')
  const [provider, setProvider] = useState<CodingPlanProvider>(saved.codingPlanProvider || 'qianfan')
  const [apiKey, setApiKey] = useState(saved.apiKey || '')
  const [model, setModel] = useState(saved.model || 'qianfan-code-latest')
  const [customBaseUrl, setCustomBaseUrl] = useState(saved.customBaseUrl || '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState('')

  // Local model state
  const savedLocalModel = AVAILABLE_LOCAL_MODELS.find(m => m.id === saved.localModelId) || AVAILABLE_LOCAL_MODELS[0]
  const [selectedLocalModel, setSelectedLocalModel] = useState(savedLocalModel)
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelState | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadSpeed, setDownloadSpeed] = useState(0)
  const [isDownloading, setIsDownloading] = useState(false)

  // Load local model status on mount and when switching to local tab
  useEffect(() => {
    if (billingMode === 'local-model' && selectedLocalModel) {
      window.electronAPI.getLocalModelStatus({ modelId: selectedLocalModel.id })
        .then((status: LocalModelState) => setLocalModelStatus(status))
        .catch(() => {})
    }
  }, [billingMode, selectedLocalModel])

  // Listen for download progress and status changes
  useEffect(() => {
    const unsubProgress = window.electronAPI.onLocalModelProgress((data: any) => {
      setDownloadProgress(data.progress)
      if (data.speed !== undefined) setDownloadSpeed(data.speed)
    })
    const unsubStatus = window.electronAPI.onLocalModelStatusChange((data: any) => {
      setLocalModelStatus({ modelId: data.modelId, status: data.status, error: data.error })
      if (data.status === 'downloaded' || data.status === 'error') {
        setIsDownloading(false)
      }
    })
    return () => {
      unsubProgress()
      unsubStatus()
    }
  }, [])

  const handleDownloadModel = async () => {
    if (!selectedLocalModel) return
    setIsDownloading(true)
    setDownloadProgress(0)
    setDownloadSpeed(0)
    setError('')
    try {
      const result = await window.electronAPI.downloadLocalModel({ modelId: selectedLocalModel.id })
      if (!result.success) {
        setError(result.error || '下载失败')
        setIsDownloading(false)
      }
    } catch (err: any) {
      setError(err.message || '下载失败')
      setIsDownloading(false)
    }
  }

  const handleCancelDownload = () => {
    window.electronAPI.cancelLocalModelDownload()
    setIsDownloading(false)
    setLocalModelStatus(prev => prev ? { ...prev, status: 'not-downloaded' } : null)
  }

  const handleLogin = () => {
    if (billingMode === 'local-model') {
      if (!selectedLocalModel) {
        setError('请选择一个模型')
        return
      }
      if (!localModelStatus || (localModelStatus.status !== 'downloaded' && localModelStatus.status !== 'ready')) {
        setError('请先下载模型')
        return
      }
      const config: ApiConfig = {
        billingMode: 'local-model',
        apiKey: '',
        model: selectedLocalModel.name,
        localModelId: selectedLocalModel.id,
        maxInputTokens: selectedLocalModel.maxInputTokens,
        maxOutputTokens: selectedLocalModel.maxOutputTokens,
      }
      login(config)
      return
    }

    if (!apiKey.trim()) {
      setError('Please enter your API Key')
      return
    }

    const config: ApiConfig = {
      billingMode,
      apiKey: apiKey.trim(),
      model,
      customBaseUrl: customBaseUrl.trim() || undefined,
      codingPlanProvider: billingMode === 'coding-plan' ? provider : undefined,
    }

    login(config)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleLogin()
    }
  }

  const isModelReady = localModelStatus?.status === 'downloaded' || localModelStatus?.status === 'ready'

  return (
    <div className="h-screen flex items-center justify-center bg-canvas">
      {/* Title bar drag area */}
      <div className="fixed top-0 left-0 right-0 h-12 drag-region z-40" />

      <div className="w-full max-w-md px-8">
        {/* Logo & Title */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-accent/10 rounded-xl mb-5">
            <Zap className="w-8 h-8 text-accent" strokeWidth={1.5} />
          </div>
          <h1 className="text-2xl font-semibold text-charcoal tracking-tight">
            Onit
          </h1>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            你的桌面搭档，随时待命。
            <br />
            把琐碎的小任务交给 Onit，你专注重要的事。
          </p>
        </div>

        {/* Login Form */}
        <div className="card p-6 space-y-5">
          {/* Billing Mode */}
          <div>
            <label className="label">Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setBillingMode('coding-plan')
                  const config = CODING_PLAN_PROVIDERS.find(c => c.id === provider)
                  setModel(config?.model || 'qianfan-code-latest')
                  setError('')
                }}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-sm border transition-all ${
                  billingMode === 'coding-plan'
                    ? 'bg-accent-50 border-accent text-accent-700'
                    : 'bg-white border-border-subtle text-text-secondary hover:border-gray-300'
                }`}
              >
                Coding Plan
              </button>
              <button
                onClick={() => {
                  setBillingMode('api-call')
                  setModel('ernie-4.5-8k')
                  setError('')
                }}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-sm border transition-all ${
                  billingMode === 'api-call'
                    ? 'bg-accent-50 border-accent text-accent-700'
                    : 'bg-white border-border-subtle text-text-secondary hover:border-gray-300'
                }`}
              >
                API Call
              </button>
              <button
                onClick={() => {
                  setBillingMode('local-model')
                  setError('')
                }}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-sm border transition-all ${
                  billingMode === 'local-model'
                    ? 'bg-accent-50 border-accent text-accent-700'
                    : 'bg-white border-border-subtle text-text-secondary hover:border-gray-300'
                }`}
              >
                本地模型
              </button>
            </div>
          </div>

          {/* ===== Local Model Tab Content ===== */}
          {billingMode === 'local-model' && (
            <div className="space-y-4 animate-fade-in">
              {/* Description */}
              <div className="bg-accent/5 rounded-sm p-3.5">
                <p className="text-xs text-text-secondary leading-relaxed">
                  无需 API Key，模型在您的设备上本地运行。完全离线可用，数据不出设备。适合日常任务，效果接近小型云端模型。
                </p>
              </div>

              {/* Framework Info */}
              <div>
                <label className="label">
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5" />
                    推理引擎
                  </span>
                </label>
                <div className="input bg-gray-50 text-text-secondary text-xs cursor-default">
                  llama.cpp (Metal GPU 加速)
                </div>
              </div>

              {/* Model Selection */}
              <div>
                <label className="label">
                  <span className="flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5" />
                    模型
                  </span>
                </label>
                <div className="relative">
                  <select
                    value={selectedLocalModel?.id || ''}
                    onChange={(e) => {
                      const m = AVAILABLE_LOCAL_MODELS.find(m => m.id === e.target.value)
                      if (m) setSelectedLocalModel(m)
                    }}
                    className="input appearance-none pr-8"
                  >
                    {AVAILABLE_LOCAL_MODELS.map(m => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
                </div>
                {selectedLocalModel && (
                  <p className="text-[10px] text-text-tertiary mt-1.5">
                    {formatFileSize(selectedLocalModel.fileSize)} · 支持工具调用 · 中英双语
                  </p>
                )}
              </div>

              {/* Download Status & Actions */}
              {selectedLocalModel && (
                <div>
                  {/* Not downloaded */}
                  {(!localModelStatus || localModelStatus.status === 'not-downloaded') && !isDownloading && (
                    <button
                      onClick={handleDownloadModel}
                      className="btn-secondary w-full"
                    >
                      <Download className="w-4 h-4" />
                      下载模型 ({formatFileSize(selectedLocalModel.fileSize)})
                    </button>
                  )}

                  {/* Downloading */}
                  {isDownloading && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-text-secondary">
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          下载中 {downloadProgress}%
                        </span>
                        <button
                          onClick={handleCancelDownload}
                          className="flex items-center gap-1 text-text-tertiary hover:text-danger transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                          取消
                        </button>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-1.5">
                        <div
                          className="bg-accent h-1.5 rounded-full transition-all duration-300"
                          style={{ width: `${downloadProgress}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-text-tertiary">
                        {formatFileSize(selectedLocalModel.fileSize * downloadProgress / 100)} / {formatFileSize(selectedLocalModel.fileSize)}
                        {downloadSpeed > 0 && <span className="ml-2">· {formatSpeed(downloadSpeed)}</span>}
                      </p>
                    </div>
                  )}

                  {/* Downloaded / Ready */}
                  {isModelReady && !isDownloading && (
                    <div className="flex items-center gap-2 text-xs text-green-600 bg-success-light px-3 py-2 rounded-sm">
                      <CheckCircle2 className="w-4 h-4" />
                      模型已就绪
                    </div>
                  )}

                  {/* Loading */}
                  {localModelStatus?.status === 'loading' && (
                    <div className="flex items-center gap-2 text-xs text-accent px-3 py-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      正在加载模型...
                    </div>
                  )}

                  {/* Error */}
                  {localModelStatus?.status === 'error' && !isDownloading && (
                    <div className="space-y-2">
                      <p className="text-xs text-danger">{localModelStatus.error || '发生错误'}</p>
                      <button
                        onClick={handleDownloadModel}
                        className="btn-secondary w-full btn-sm"
                      >
                        重试下载
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ===== Cloud API Tab Content (Coding Plan / API Call) ===== */}
          {billingMode !== 'local-model' && (
            <>
              {/* Provider Selection (only for Coding Plan mode) */}
              {billingMode === 'coding-plan' && (
                <div>
                  <label className="label">Provider</label>
                  <div className="relative">
                    <select
                      value={provider}
                      onChange={(e) => {
                        const p = e.target.value as CodingPlanProvider
                        setProvider(p)
                        const config = CODING_PLAN_PROVIDERS.find(c => c.id === p)
                        if (config) setModel(config.model)
                      }}
                      className="input appearance-none pr-8"
                    >
                      {CODING_PLAN_PROVIDERS.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
                  </div>
                </div>
              )}

              {/* API Key */}
              <div>
                <label className="label">
                  <span className="flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5" />
                    API Key
                  </span>
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setError('') }}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter your API key..."
                  className="input"
                  autoFocus
                />
              </div>

              {/* Model Selection (only for API mode) */}
              {billingMode === 'api-call' && (
                <div>
                  <label className="label">Model</label>
                  <div className="relative">
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="input appearance-none pr-8"
                    >
                      {AVAILABLE_MODELS.filter(m => !m.codingPlan).map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary pointer-events-none" />
                  </div>
                </div>
              )}

              {/* Advanced Settings */}
              <div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-xs text-text-secondary hover:text-charcoal transition-colors flex items-center gap-1"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                  Advanced Settings
                </button>
                {showAdvanced && (
                  <div className="mt-3 animate-fade-in">
                    <label className="label">
                      <span className="flex items-center gap-1.5">
                        <Globe className="w-3.5 h-3.5" />
                        Custom Base URL (optional)
                      </span>
                    </label>
                    <input
                      type="url"
                      value={customBaseUrl}
                      onChange={(e) => setCustomBaseUrl(e.target.value)}
                      placeholder={billingMode === 'coding-plan'
                        ? CODING_PLAN_PROVIDERS.find(c => c.id === provider)?.baseUrl || ''
                        : 'https://qianfan.baidubce.com/v2/chat/completions'}
                      className="input text-xs"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-danger animate-fade-in">{error}</p>
          )}

          {/* Login Button */}
          <button
            onClick={handleLogin}
            disabled={billingMode === 'local-model' && !isModelReady}
            className={`w-full ${billingMode === 'local-model' && !isModelReady ? 'btn bg-gray-200 text-text-tertiary cursor-not-allowed' : 'btn-primary'}`}
          >
            {billingMode === 'local-model' ? '开始使用' : 'Get Started'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-text-tertiary mt-6">
          {billingMode === 'local-model'
            ? '模型在本地运行，数据完全保留在您的设备上'
            : 'Your API key is stored locally on your device'
          }
        </p>
      </div>
    </div>
  )
}
