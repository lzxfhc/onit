import { useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import type { ApiConfig, BillingMode } from '../types'
import { AVAILABLE_MODELS } from '../types'
import { Zap, Key, Globe, ChevronDown, ArrowRight } from 'lucide-react'

export default function Login() {
  const { login } = useSettingsStore()
  const [billingMode, setBillingMode] = useState<BillingMode>('coding-plan')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('qianfan-code-latest')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = () => {
    if (!apiKey.trim()) {
      setError('Please enter your API Key')
      return
    }

    const config: ApiConfig = {
      billingMode,
      apiKey: apiKey.trim(),
      model,
      customBaseUrl: customBaseUrl.trim() || undefined,
    }

    login(config)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleLogin()
    }
  }

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
            <label className="label">Billing Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setBillingMode('coding-plan')
                  setModel('qianfan-code-latest')
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
                }}
                className={`flex-1 py-2 px-3 text-xs font-medium rounded-sm border transition-all ${
                  billingMode === 'api-call'
                    ? 'bg-accent-50 border-accent text-accent-700'
                    : 'bg-white border-border-subtle text-text-secondary hover:border-gray-300'
                }`}
              >
                API Call
              </button>
            </div>
          </div>

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
                    ? 'https://qianfan.baidubce.com/v2/coding/chat/completions'
                    : 'https://qianfan.baidubce.com/v2/chat/completions'}
                  className="input text-xs"
                />
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-danger animate-fade-in">{error}</p>
          )}

          {/* Login Button */}
          <button
            onClick={handleLogin}
            className="btn-primary w-full"
          >
            Get Started
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-text-tertiary mt-6">
          Your API key is stored locally on your device
        </p>
      </div>
    </div>
  )
}
