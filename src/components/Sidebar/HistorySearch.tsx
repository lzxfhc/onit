import { useState, useMemo } from 'react'
import { Search, MessageSquare } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'

export default function HistorySearch() {
  const { sessions, setActiveSession } = useSessionStore()
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return sessions
      .filter(session =>
        session.name.toLowerCase().includes(q) ||
        session.messages.some((msg: any) =>
          msg.content?.toLowerCase().includes(q)
        )
      )
      .map(session => {
        const matchingMsg = session.messages.find((msg: any) =>
          msg.content?.toLowerCase().includes(q)
        )
        return {
          session,
          preview: matchingMsg
            ? highlightMatch(matchingMsg.content.substring(0, 100), q)
            : session.name,
        }
      })
      .slice(0, 20)
  }, [query, sessions])

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      {/* Search Input */}
      <div className="px-2 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations..."
            className="input pl-8 text-xs"
            autoFocus
          />
        </div>
      </div>

      {/* Results */}
      {query.trim() ? (
        results.length > 0 ? (
          <div className="space-y-0.5">
            {results.map(({ session, preview }) => (
              <button
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className="sidebar-item w-full text-left"
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-50" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{session.name}</p>
                  <p className="text-[10px] text-text-tertiary truncate mt-0.5"
                    dangerouslySetInnerHTML={{ __html: preview }}
                  />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-tertiary text-center py-8">
            No results found
          </p>
        )
      ) : (
        <p className="text-xs text-text-tertiary text-center py-8">
          Type to search conversations
        </p>
      )}
    </div>
  )
}

function highlightMatch(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query)
  if (idx === -1) return text
  const before = text.substring(0, idx)
  const match = text.substring(idx, idx + query.length)
  const after = text.substring(idx + query.length)
  return `${escapeHtml(before)}<mark class="bg-warning-light text-charcoal rounded px-0.5">${escapeHtml(match)}</mark>${escapeHtml(after)}`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
