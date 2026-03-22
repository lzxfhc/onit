import { AgentToolDef, ToolExecutionResult } from '../agent/types'
import { AGENT_TOOLS, executeTool } from '../agent/tools'
import type { CopilotManager } from './index'

// Reuse the exact web_search tool definition from agent/tools.ts
const webSearchTool = AGENT_TOOLS.find(t => t.function.name === 'web_search')!

export const COPILOT_TOOLS: AgentToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'dispatch_task',
      description: 'Create a new task and route it to a worker session for execution. Use this for tasks that require file operations, command execution, code analysis, or any multi-step work. Do NOT use this for simple questions you can answer directly.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Clear description of the task for the worker agent to execute' },
          session_hint: { type: 'string', description: 'Optional: session ID to route to an existing worker session' },
          workspace: { type: 'string', description: 'Optional: working directory path for the task' },
          skills: { type: 'string', description: 'Optional: comma-separated skill names to enable for this task' },
          priority: { type: 'string', description: 'Task priority: "normal" or "urgent" (default: "normal")' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all active and recently completed tasks. Use this to check what tasks are running, queued, or recently finished before making routing decisions.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_result',
      description: 'Get the result of a completed task. Returns the task summary and status. Use this when the user asks about a finished task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The ID of the task to get the result for' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_task_status',
      description: 'Check the current progress of a running task. Returns status and progress information.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The ID of the task to check' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel a running or queued task. Use this when the user wants to stop a task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The ID of the task to cancel' },
        },
        required: ['task_id'],
      },
    },
  },
  // Reuse exact web_search definition from agent/tools.ts
  webSearchTool,
]

/**
 * Execute a copilot tool. For web_search, delegates to the existing executeTool
 * from agent/tools.ts. All other tools dispatch to the CopilotManager.
 */
export async function executeCopilotTool(
  toolName: string,
  argsStr: string,
  workspacePath: string | null,
  options: { signal?: AbortSignal; copilotManager?: CopilotManager }
): Promise<ToolExecutionResult> {
  // web_search delegates to the existing agent tool implementation
  if (toolName === 'web_search') {
    return executeTool(toolName, argsStr, workspacePath, { signal: options.signal })
  }

  const manager = options.copilotManager
  if (!manager) {
    return { success: false, output: 'CopilotManager not available', riskLevel: 'safe' }
  }

  let args: any
  try {
    args = JSON.parse(argsStr)
  } catch {
    return { success: false, output: `Invalid tool arguments: ${argsStr}`, riskLevel: 'safe' }
  }

  try {
    switch (toolName) {
      case 'dispatch_task': {
        const task = await manager.dispatchTask({
          description: args.description || '',
          session_hint: args.session_hint,
          workspace: args.workspace,
          skills: args.skills ? String(args.skills).split(',').map((s: string) => s.trim()) : undefined,
          priority: args.priority,
        })
        return {
          success: true,
          output: JSON.stringify({
            taskId: task.id,
            sessionId: task.sessionId,
            status: task.status,
            description: task.description,
          }),
          riskLevel: 'safe',
        }
      }

      case 'list_tasks': {
        const tasks = manager.listTasks()
        const summary = tasks.map(t => ({
          id: t.id,
          description: t.description.substring(0, 200),
          status: t.status,
          createdAt: t.createdAt,
          completedAt: t.completedAt,
          summary: t.summary?.substring(0, 200),
        }))
        return {
          success: true,
          output: JSON.stringify(summary),
          riskLevel: 'safe',
        }
      }

      case 'get_task_result': {
        const result = manager.getTaskResult(args.task_id)
        return {
          success: true,
          output: JSON.stringify(result),
          riskLevel: 'safe',
        }
      }

      case 'check_task_status': {
        const status = manager.checkTaskStatus(args.task_id)
        return {
          success: true,
          output: JSON.stringify(status),
          riskLevel: 'safe',
        }
      }

      case 'cancel_task': {
        const cancelled = await manager.cancelTask(args.task_id)
        return {
          success: true,
          output: JSON.stringify({ cancelled }),
          riskLevel: 'safe',
        }
      }

      default:
        return { success: false, output: `Unknown copilot tool: ${toolName}`, riskLevel: 'safe' }
    }
  } catch (err: any) {
    return { success: false, output: `Tool error: ${err.message || String(err)}`, riskLevel: 'safe' }
  }
}
