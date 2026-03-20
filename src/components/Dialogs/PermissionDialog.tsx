import { AlertTriangle, Shield, FileWarning, Terminal, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'

interface Props {
  request: {
    id: string
    sessionId: string
    type: string
    description: string
    details: string
    toolName?: string
    showAlwaysAllow?: boolean
  }
}

export default function PermissionDialog({ request }: Props) {
  const t = useT()
  const { removePermissionRequest } = useSettingsStore()

  const handleResponse = (approved: boolean, alwaysAllow?: boolean) => {
    window.electronAPI.sendPermissionResponse({
      requestId: request.id,
      approved,
      alwaysAllow,
    })
    removePermissionRequest(request.id)
  }

  const getIcon = () => {
    switch (request.type) {
      case 'file-delete':
        return <AlertTriangle className="w-6 h-6 text-danger" />
      case 'file-write':
      case 'file-overwrite':
        return <FileWarning className="w-6 h-6 text-warning" />
      case 'command-execute':
        return <Terminal className="w-6 h-6 text-accent" />
      default:
        return <Shield className="w-6 h-6 text-warning" />
    }
  }

  const getTitle = () => {
    switch (request.type) {
      case 'file-delete': return t.permission.fileDelete
      case 'file-write': return t.permission.fileWrite
      case 'file-overwrite': return t.permission.fileOverwrite
      case 'command-execute': return t.permission.commandExec
      case 'system-config': return t.permission.systemConfig
      default: return t.permission.title
    }
  }

  const getRiskColor = () => {
    switch (request.type) {
      case 'file-delete':
      case 'system-config':
        return 'border-danger/30 bg-danger-light'
      default:
        return 'border-warning/30 bg-warning-light'
    }
  }

  const formatDetails = (details: string) => {
    try {
      return JSON.stringify(JSON.parse(details), null, 2)
    } catch {
      return details
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-charcoal/20 backdrop-blur-sm"
        onClick={() => handleResponse(false)}
      />

      {/* Dialog */}
      <div className="relative bg-surface rounded-lg shadow-dialog w-full max-w-md mx-4 animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            {getIcon()}
            <div>
              <h3 className="text-sm font-semibold text-charcoal">{getTitle()}</h3>
              <p className="text-xs text-text-secondary mt-0.5">
                {t.permission.description}
              </p>
            </div>
          </div>
          <button
            onClick={() => handleResponse(false)}
            className="btn-icon"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 pb-4">
          {/* Description */}
          <div className={`rounded-sm border px-3 py-2.5 mb-3 ${getRiskColor()}`}>
            <p className="text-xs font-medium text-charcoal">{request.description}</p>
          </div>

          {/* Details */}
          {request.details && (
            <div className="mb-4">
              <span className="text-[10px] text-text-tertiary font-medium">{t.permission.details}</span>
              <pre className="mt-1 text-[11px] bg-terminal text-gray-200 rounded p-3 overflow-x-auto font-mono max-h-48 overflow-y-auto">
                {formatDetails(request.details)}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between p-5 pt-0 gap-2">
          <button
            onClick={() => handleResponse(false)}
            className="btn-secondary flex-1"
          >
            {t.permission.deny}
          </button>
          {request.showAlwaysAllow && (
            <button
              onClick={() => handleResponse(true, true)}
              className="btn-secondary flex-1 text-accent border-accent/30"
            >
              {t.permission.alwaysAllow}
            </button>
          )}
          <button
            onClick={() => handleResponse(true)}
            className="btn-primary flex-1"
          >
            {t.permission.allow}
          </button>
        </div>
      </div>
    </div>
  )
}
