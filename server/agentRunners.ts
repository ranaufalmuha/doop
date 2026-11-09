/**
 * The connections a person's composer may send a task to, as
 * `GET /api/agent-runners` lists them: the Claude Plan while it is on, and
 * every model account that is on. `default` is what work carrying no pick
 * runs on (agentDefaults.ts). The Settings pane gets every account, on or
 * off, through `accountsView`.
 */
import { AGENT_MODELS, effortFor } from './openaiAgent.ts'
import { geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import { localAgentRuns } from './localAgentRuns.ts'
import { readConnections } from './agentDefaults.ts'
import {
  accountModelFor,
  chatgptConnectEnabled,
  getAccounts,
  statusOf,
  takesReasoningEffort,
  type AccountKind,
  type AccountStatus,
} from './modelAccounts.ts'
import { CLAUDE_EFFORT_OPTIONS, CLAUDE_MODELS } from '../shared/localAgent.ts'
import { ANTHROPIC_MODELS, GEMINI_MODELS, OPENROUTER_MODELS, reasoningEffortOptions } from '../shared/modelMenu.ts'
import type { ModelOption } from '../shared/modelMenu.ts'
import { RUNNER_NAMES, type AgentRunner, type AgentRunners, type RunnerProvider } from '../shared/agentRunner.ts'
import { customEndpointPolicy, customEndpointsEnabled, type CustomEndpointPolicy } from './customEndpoint.ts'

/** the curated menu each account kind's picker opens with */
export const MODEL_MENUS: Record<AccountKind, ModelOption[]> = {
  chatgpt: AGENT_MODELS.map((m) => ({ ...m, vision: true })),
  'openai-key': AGENT_MODELS.map((m) => ({ ...m, vision: true })),
  'anthropic-key': ANTHROPIC_MODELS,
  'openrouter-key': OPENROUTER_MODELS,
  'gemini-key': GEMINI_MODELS,
  /* the custom provider has no curated roster: its list is live or the one
     stored model */
  custom: [],
}

export async function listRunners(userId: string): Promise<AgentRunners> {
  const connections = await readConnections(userId)
  const runners: AgentRunner[] = []
  const { plan } = connections
  if (plan.enabled) {
    runners.push({
      provider: 'claude-local',
      name: RUNNER_NAMES['claude-local'],
      online: localAgentRuns.online(userId),
      model: plan.model,
      ...(plan.effort ? { effort: plan.effort } : {}),
      models: CLAUDE_MODELS,
      efforts: CLAUDE_EFFORT_OPTIONS,
    })
  }
  for (const account of connections.accounts) {
    if (!account.enabled) continue
    if (account.kind === 'custom') {
      const model = accountModelFor(account)
      runners.push({
        provider: 'custom',
        name: account.label || RUNNER_NAMES.custom,
        model,
        vision: account.vision === true,
        models: [{ id: model, name: model, blurb: '' }],
      })
      continue
    }
    const effort = takesReasoningEffort(account.kind) ? effortFor(account) : undefined
    runners.push({
      provider: account.kind,
      name: RUNNER_NAMES[account.kind],
      ...(account.email ? { email: account.email } : {}),
      model: accountModelFor(account),
      ...(effort ? { effort } : {}),
      models: MODEL_MENUS[account.kind].map(({ id, name, blurb }) => ({ id, name, blurb })),
      ...(effort ? { efforts: reasoningEffortOptions(effort) } : {}),
    })
  }
  const fallback = geminiCloudWorkerFor(userId) ? ('gemini-cloud' as const) : connections.default
  return { runners, ...(fallback ? { default: fallback } : {}) }
}

/** What the Settings pane renders: every connected account, on or off, and
 *  which connection is the default. Every account route answers with it, so
 *  the pane re-renders straight from the response. */
export interface AccountsView {
  accounts: AccountStatus[]
  default?: RunnerProvider
  chatgptEnabled: boolean
  /** whether the custom-provider feature is on at all */
  customEnabled: boolean
  /** the server-level endpoint policy, so the form can explain allowed URLs */
  policy: CustomEndpointPolicy
  menus: Record<AccountKind, ModelOption[]>
}

export async function accountsView(userId: string): Promise<AccountsView> {
  /* the view is informational, so it lists every stored row even when the
     policy is `off` — that is how the owner can still see and delete a custom
     key. Routing (`readConnections`) keeps hiding it, so an off policy never
     runs or bills it. */
  const [connections, accounts] = await Promise.all([readConnections(userId), getAccounts(userId)])
  return {
    accounts: accounts.map(statusOf),
    ...(connections.default ? { default: connections.default } : {}),
    chatgptEnabled: chatgptConnectEnabled(),
    customEnabled: customEndpointsEnabled(),
    policy: customEndpointPolicy(),
    menus: MODEL_MENUS,
  }
}
