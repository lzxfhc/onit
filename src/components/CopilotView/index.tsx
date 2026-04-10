import { useCopilotStore } from '../../stores/copilotStore'
import CopilotChat from './CopilotChat'
import TaskPanel from './TaskPanel'
import TaskDetail from './TaskDetail'

export default function CopilotView() {
  const taskDetailOpen = useCopilotStore(s => s.taskDetailOpen)

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: Task Panel */}
      <div className="w-56 shrink-0">
        <TaskPanel />
      </div>

      {/* Center: Chat */}
      <CopilotChat />

      {/* Right: Task Detail (collapsible) */}
      <div
        className={`shrink-0 transition-[width] duration-200 ease-out overflow-hidden ${
          taskDetailOpen ? 'w-80' : 'w-0'
        }`}
        aria-hidden={!taskDetailOpen}
      >
        <div
          className={`w-80 h-full transition-opacity duration-200 ${
            taskDetailOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <TaskDetail />
        </div>
      </div>
    </div>
  )
}
