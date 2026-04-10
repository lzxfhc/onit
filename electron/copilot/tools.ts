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
      description: 'Dispatch a task to a worker session. Can reuse an existing session (to maintain context) or create a new one. For simple one-shot tasks, set task_type="temporary". For recurring/complex topics, set task_type="persistent".',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Clear description of the task for the worker agent to execute' },
          topic: { type: 'string', description: 'REQUIRED. Topic category in lowercase-english-hyphenated. e.g. "weather", "code-review", "research-ai". Check existing sessions and reuse their topic.' },
          reuse_session_id: { type: 'string', description: 'Route to existing session by ID (from list_tasks). ALWAYS set this if matching session exists.' },
          task_type: { type: 'string', description: '"persistent" (default, context preserved) or "temporary" (one-shot, cleaned up). Set temporary only for independent queries like weather/translation/conversion.' },
          workspace: { type: 'string', description: 'Optional: working directory path for the task' },
          skills: { type: 'string', description: 'Optional: comma-separated skill names to enable for this task' },
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
      description: 'Get the result of a completed task. Returns status, summary, full result text, and sessionId for follow-up routing.',
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
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search past tasks by keyword. Use when the user asks about previous work and the specific task is not immediately visible in context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keyword(s) to match against task names, descriptions, topics, and summaries' },
          limit: { type: 'number', description: 'Max results to return (default 5)' },
        },
        required: ['query'],
      },
    },
  },
  // Reuse exact web_search definition from agent/tools.ts
  webSearchTool,
  // Reuse ask_user from agent/tools.ts — orchestrator needs to clarify requirements with user
  AGENT_TOOLS.find(t => t.function.name === 'ask_user')!,
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

  // ask_user is handled by AgentManager directly (intercepted in runAgentLoop before reaching here)
  if (toolName === 'ask_user') {
    return { success: false, output: 'ask_user should be handled by AgentManager, not executeCopilotTool', riskLevel: 'safe' }
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
          topic: args.topic,
          reuse_session_id: args.reuse_session_id,
          task_type: args.task_type,
          workspace: args.workspace,
          skills: args.skills ? String(args.skills).split(',').map((s: string) => s.trim()) : undefined,
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
          sessionId: t.sessionId,
          topic: t.topic,
          taskType: t.taskType,
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

      case 'search_tasks': {
        const results = manager.searchTasks(args.query || '', args.limit || 5)
        return {
          success: true,
          output: JSON.stringify(results.map((t: any) => ({
            id: t.id, name: t.name, topic: t.topic, status: t.status,
            summary: t.summary, sessionId: t.sessionId,
          }))),
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
