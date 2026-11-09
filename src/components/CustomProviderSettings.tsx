import { Fragment, useState } from 'react'
import type { CustomProviderInput, CustomProviderPatch, ModelAccountStatus, ModelAccounts } from '../lib/api'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { AvailableRow, ConnectionRow, FieldError, ModelSelect, type ModelChoice } from './ConnectionTable'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { ServerIcon } from './ui/icons'

/**
 * The one custom OpenAI-compatible provider (9Router, LiteLLM, vLLM, Ollama,
 * LocalAI) in Settings → Doop Agent.
 *
 * The form only checks what a browser can: the URL shape the server accepts
 * (origin or its `/v1` root, no credentials/query/fragment, https unless this
 * is a self-host with the private policy), the label, model-id and budget
 * rules. The server still screens the address and probes the endpoint — its
 * failure lands under the field it is about, and the row stays unconnected.
 *
 * Connected, the row behaves like every other connection: its own model
 * dropdown (the live catalog, or the stored id when the provider could not be
 * listed), on/off switch, Make default, Replace connection and Disconnect.
 */

type FormValues = {
  label: string
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens: string
  vision: boolean
}

type FormField = 'label' | 'baseUrl' | 'apiKey' | 'model' | 'maxOutputTokens' | 'vision' | 'form'
type Problems = Partial<Record<FormField, string>>

const EMPTY_FORM: FormValues = {
  label: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  maxOutputTokens: '8192',
  vision: false,
}

const MAX_URL = 2000
const MAX_MODEL = 120
const MIN_BUDGET = 1024
const MAX_BUDGET = 16000
/** The spec's model-id rule: opaque, but 1–120 characters, never whitespace,
 *  control characters or the quote/backslash set the JSON body cannot carry. */
function validModelId(id: string): boolean {
  if (id.length < 1 || id.length > MAX_MODEL) return false
  if (/[\s"'<>\\]/.test(id)) return false
  return [...id].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
}

function formFor(account: ModelAccountStatus | undefined): FormValues {
  if (!account) return EMPTY_FORM
  return {
    label: account.label ?? '',
    baseUrl: account.baseUrl ?? '',
    apiKey: '',
    model: account.model ?? '',
    maxOutputTokens: String(account.maxOutputTokens ?? 8192),
    vision: account.vision === true,
  }
}

/** The URL rules the server will apply, so a typo fails here first. */
function urlProblem(raw: string, policy: ModelAccounts['policy'], t: ReturnType<typeof useT>): string | undefined {
  const text = raw.trim()
  if (!text) return t('models.customErrUrlRequired')
  if (text.length > MAX_URL) return t('models.customErrUrlLong')
  /* backslashes are how `https:\\evil` slides past a naive host check; the
     server rejects them, and so do we */
  if (text.includes('\\')) return t('models.customErrUrlShape')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return t('models.customErrUrl')
  }
  if (url.protocol !== 'https:' && !(policy === 'private' && url.protocol === 'http:')) {
    return t('models.customErrScheme')
  }
  if (!url.hostname) return t('models.customErrUrl')
  if (url.username || url.password || url.search || url.hash) return t('models.customErrUrlShape')
  if (!['', '/', '/v1', '/v1/'].includes(url.pathname)) return t('models.customErrUrlShape')
  return undefined
}

function problemsFor(values: FormValues, policy: ModelAccounts['policy'], t: ReturnType<typeof useT>): Problems {
  const problems: Problems = {}
  const label = values.label.trim()
  if (!label || label.length > 40) problems.label = t('models.customErrName')
  const url = urlProblem(values.baseUrl, policy, t)
  if (url) problems.baseUrl = url
  const model = values.model.trim()
  if (model && !validModelId(model)) problems.model = t('models.customErrModel')
  const budget = values.maxOutputTokens.trim()
  if (budget) {
    const value = Number(budget)
    if (!/^\d+$/.test(budget) || !Number.isInteger(value) || value < MIN_BUDGET || value > MAX_BUDGET) {
      problems.maxOutputTokens = t('models.customErrBudget')
    }
  }
  return problems
}

/** Which field a server sentence belongs under. The connect probe answers
 *  with a whole sentence, and the person should see it beside the thing that
 *  needs fixing, not as a banner far above the form. */
function fieldForServerError(message: string): FormField {
  const m = message.toLowerCase()
  if (m.includes('base url') || m.includes('redirect') || m.includes('origin') || m.includes('address'))
    return 'baseUrl'
  if (m.includes('https://') || m.includes('private') || m.includes('endpoint')) return 'baseUrl'
  if (m.includes('api key') || m.includes('authentication') || /\b401\b/.test(m) || /\b403\b/.test(m)) return 'apiKey'
  if (m.includes('screenshot') || m.includes('image')) return 'vision'
  if (m.includes('budget') || m.includes('token')) return 'maxOutputTokens'
  if (m.includes('model')) return 'model'
  return 'form'
}

function CustomMark() {
  return (
    <span
      aria-hidden
      className="grid size-8 flex-none place-items-center overflow-hidden bg-sub text-ink-soft shadow-ring"
      style={{ borderRadius: '23%' }}
    >
      <ServerIcon size={18} />
    </span>
  )
}

/** The connect / replace form. Reused inline under the add row and in the
 *  replace modal; `replacing` only changes the copy and the submit label. */
function CustomProviderForm({
  initial,
  policy,
  busy,
  serverError,
  submitLabel,
  replacing = false,
  showCancel = true,
  onSubmit,
  onCancel,
  onClearError,
}: {
  initial: FormValues
  policy: ModelAccounts['policy']
  busy: boolean
  serverError?: string | undefined
  submitLabel: string
  replacing?: boolean
  /** the row header already offers Cancel, so the inline form does not */
  showCancel?: boolean
  onSubmit: (input: CustomProviderInput) => Promise<boolean>
  onCancel: () => void
  /** dismiss the pane's last failure when the person starts fixing it */
  onClearError: () => void
}) {
  const t = useT()
  const [values, setValues] = useState<FormValues>(initial)
  const [problems, setProblems] = useState<Problems>({})

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }))
    /* a fresh edit stops the old complaint describing this field */
    setProblems((current) => ({ ...current, [key]: undefined }))
    onClearError()
  }

  const serverField = serverError ? fieldForServerError(serverError) : undefined
  const errorFor = (field: FormField) => problems[field] ?? (serverField === field ? serverError : undefined)

  const submit = async () => {
    const next = problemsFor(values, policy, t)
    setProblems(next)
    if (Object.keys(next).length > 0) return
    const model = values.model.trim()
    const budget = values.maxOutputTokens.trim()
    const apiKey = values.apiKey.trim()
    const saved = await onSubmit({
      baseUrl: values.baseUrl.trim(),
      label: values.label.trim(),
      /* blank on first connect = keyless; blank on replace keeps the stored
         key, which is what an empty field under "leave blank to keep" means */
      ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}),
      vision: values.vision,
      ...(budget ? { maxOutputTokens: Number(budget) } : {}),
    })
    if (saved) {
      setValues(EMPTY_FORM)
      setProblems({})
    }
  }

  const fieldId = (field: string) => `custom-${replacing ? 'replace-' : ''}${field}`
  const bad = (field: FormField) => !!errorFor(field)

  return (
    <form
      noValidate
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          labelVariant="form"
          label={t('models.customNameLabel')}
          hint={t('models.customNameHint')}
          htmlFor={fieldId('label')}
        >
          <Input
            id={fieldId('label')}
            value={values.label}
            onChange={(event) => set('label', event.target.value)}
            placeholder={t('models.customNamePlaceholder')}
            autoComplete="off"
            autoFocus
            aria-invalid={bad('label')}
            aria-describedby={bad('label') ? `${fieldId('label')}-error` : undefined}
          />
          <FieldError id={`${fieldId('label')}-error`}>{errorFor('label')}</FieldError>
        </Field>
        <Field
          labelVariant="form"
          label={t('models.customBudgetLabel')}
          hint={t('models.customBudgetHint')}
          htmlFor={fieldId('budget')}
        >
          <Input
            id={fieldId('budget')}
            type="number"
            inputMode="numeric"
            min={MIN_BUDGET}
            max={MAX_BUDGET}
            step={1}
            value={values.maxOutputTokens}
            onChange={(event) => set('maxOutputTokens', event.target.value)}
            aria-invalid={bad('maxOutputTokens')}
            aria-describedby={bad('maxOutputTokens') ? `${fieldId('budget')}-error` : undefined}
          />
          <FieldError id={`${fieldId('budget')}-error`}>{errorFor('maxOutputTokens')}</FieldError>
        </Field>
        <Field
          className="sm:col-span-2"
          labelVariant="form"
          label={t('models.customUrlLabel')}
          hint={t('models.customUrlHint')}
          htmlFor={fieldId('url')}
        >
          <Input
            id={fieldId('url')}
            value={values.baseUrl}
            onChange={(event) => set('baseUrl', event.target.value)}
            placeholder="https://api.9router.dev/v1"
            autoComplete="url"
            spellCheck={false}
            aria-invalid={bad('baseUrl')}
            aria-describedby={bad('baseUrl') ? `${fieldId('url')}-error` : undefined}
          />
          <FieldError id={`${fieldId('url')}-error`}>{errorFor('baseUrl')}</FieldError>
        </Field>
        <Field
          labelVariant="form"
          label={t('models.customKeyLabel')}
          hint={t('models.customKeyHint')}
          htmlFor={fieldId('key')}
        >
          <Input
            id={fieldId('key')}
            type="password"
            value={values.apiKey}
            onChange={(event) => set('apiKey', event.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={bad('apiKey')}
            aria-describedby={bad('apiKey') ? `${fieldId('key')}-error` : undefined}
          />
          <FieldError id={`${fieldId('key')}-error`}>{errorFor('apiKey')}</FieldError>
        </Field>
        <Field
          labelVariant="form"
          label={t('models.customModelLabel')}
          hint={t('models.customModelHint')}
          htmlFor={fieldId('model')}
        >
          <Input
            id={fieldId('model')}
            value={values.model}
            onChange={(event) => set('model', event.target.value)}
            placeholder="9router/auto"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={bad('model')}
            aria-describedby={bad('model') ? `${fieldId('model')}-error` : undefined}
          />
          <FieldError id={`${fieldId('model')}-error`}>{errorFor('model')}</FieldError>
        </Field>
      </div>

      <div className="mt-3">
        <label className="flex cursor-pointer items-start gap-2.5">
          <span className="relative mt-0.5 flex">
            <Checkbox
              checked={values.vision}
              onChange={(event) => set('vision', event.target.checked)}
              aria-describedby={bad('vision') ? `${fieldId('vision')}-error` : undefined}
            />
          </span>
          <span className="min-w-0">
            <span className="block text-body text-ink">{t('models.customVisionLabel')}</span>
            <span className="mt-0.5 block text-label text-ink-faint">{t('models.customVisionHint')}</span>
            <FieldError id={`${fieldId('vision')}-error`}>{errorFor('vision')}</FieldError>
          </span>
        </label>
      </div>

      <p className="mt-3 text-label leading-snug text-ink-faint">
        {policy === 'private' ? t('models.customPolicyPrivate') : t('models.customPolicyPublic')}
      </p>
      {serverField === 'form' && <FieldError>{serverError}</FieldError>}

      <div className={cn('mt-3 flex items-center gap-2 max-sm:flex-col max-sm:items-stretch')}>
        <Button type="submit" variant="primary" disabled={busy} className="max-sm:justify-center">
          {busy ? t('models.customChecking') : submitLabel}
        </Button>
        {showCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy} className="max-sm:justify-center">
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}

export function CustomProviderEntry({
  view,
  account,
  models,
  catalogError,
  busy,
  error,
  onSubmit,
  onPatch,
  onMakeDefault,
  onDisconnect,
  onClearError,
}: {
  view: ModelAccounts
  account: ModelAccountStatus | undefined
  /** the live catalog, or the stored id as its only row */
  models: ModelChoice[]
  catalogError?: string | undefined
  busy: boolean
  error?: string | undefined
  onSubmit: (input: CustomProviderInput) => Promise<boolean>
  onPatch: (patch: CustomProviderPatch) => Promise<boolean>
  onMakeDefault: () => void
  onDisconnect: () => Promise<boolean>
  onClearError: () => void
}) {
  const t = useT()
  const [editing, setEditing] = useState<'connect' | 'replace' | 'disconnect' | null>(null)

  const close = () => {
    setEditing(null)
    onClearError()
  }

  const name = account?.label || t('models.customName')
  const budget = account?.maxOutputTokens ?? 8192
  const host = account?.baseUrl?.replace(/^https?:\/\//, '') ?? ''
  const meta = account
    ? [host, account.model || t('models.customNoModel'), t('models.customTokens', { n: budget })].join(' · ')
    : undefined

  if (!account) {
    return (
      <AvailableRow
        mark={<CustomMark />}
        name={t('models.customTitle')}
        sub={t('models.customShort')}
        action={
          editing === 'connect' ? (
            <Button size="sm" variant="ghost" onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                onClearError()
                setEditing('connect')
              }}
              disabled={busy}
            >
              {t('models.connect')}
            </Button>
          )
        }
        panel={
          <CustomProviderForm
            initial={EMPTY_FORM}
            policy={view.policy}
            busy={busy}
            serverError={error}
            submitLabel={t('models.connect')}
            showCancel={false}
            onSubmit={async (input) => {
              const saved = await onSubmit(input)
              if (saved) close()
              return saved
            }}
            onCancel={close}
            onClearError={onClearError}
          />
        }
        open={editing === 'connect'}
      />
    )
  }

  return (
    <Fragment>
      <ConnectionRow
        mark={<CustomMark />}
        name={name}
        sub={meta}
        state={account.enabled ? 'on' : 'off'}
        isDefault={view.default === 'custom'}
        busy={busy}
        model={
          <ModelSelect
            name={name}
            models={models}
            model={account.model}
            onModel={(model) => void onPatch({ model })}
            disabled={busy}
            caption={catalogError}
          />
        }
        onToggle={(on) => void onPatch({ enabled: on })}
        onMakeDefault={onMakeDefault}
        onDisconnect={() => setEditing('disconnect')}
        menuItems={[
          {
            label: t('models.replaceKey'),
            onSelect: () => {
              onClearError()
              setEditing('replace')
            },
          },
        ]}
        error={editing ? undefined : error}
      />

      {editing === 'replace' && (
        <Modal size="lg" onClose={close}>
          <ModalTitle>{t('models.customReplaceTitle', { name })}</ModalTitle>
          <ModalLede>{t('models.customReplaceLede')}</ModalLede>
          <CustomProviderForm
            initial={formFor(account)}
            policy={view.policy}
            busy={busy}
            serverError={error}
            submitLabel={t('models.customReplace')}
            replacing
            onSubmit={async (input) => {
              const saved = await onSubmit(input)
              if (saved) close()
              return saved
            }}
            onCancel={close}
            onClearError={onClearError}
          />
        </Modal>
      )}

      {editing === 'disconnect' && (
        <Modal size="sm" onClose={close}>
          <ModalTitle>{t('models.customDisconnectTitle', { name })}</ModalTitle>
          <ModalLede>{t('models.customDisconnectLede')}</ModalLede>
          <ModalActions>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void onDisconnect().then((done) => {
                  if (done) close()
                })
              }}
            >
              {busy ? t('models.customDisconnecting') : t('models.disconnect')}
            </Button>
          </ModalActions>
        </Modal>
      )}
    </Fragment>
  )
}
