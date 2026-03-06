import { AlertTriangle, Shield, FileWarning, Terminal, X } from 'lucide-react'
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
      case 'file-delete': return 'File Deletion'
      case 'file-write': return 'File Write'
      case 'file-overwrite': return 'File Overwrite'
      case 'command-execute': return 'Command Execution'
      case 'system-config': return 'System Configuration'
      default: return 'Permission Required'
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
                The agent wants to perform this operation
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
              <span className="text-[10px] text-text-tertiary font-medium">Details:</span>
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
            Deny
          </button>
          {request.showAlwaysAllow && (
            <button
              onClick={() => handleResponse(true, true)}
              className="btn-secondary flex-1 text-accent border-accent/30"
            >
              Always Allow
            </button>
          )}
          <button
            onClick={() => handleResponse(true)}
            className="btn-primary flex-1"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
