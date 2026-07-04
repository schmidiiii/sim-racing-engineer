import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAiStore, ProviderConfig, ProviderType } from '@/store/ai'
import { useT } from '@/lib/i18n'

const PROVIDERS: ProviderType[] = ['Ollama', 'OpenAI', 'Gemini']

export default function Settings() {
  const t = useT()
  const { provider, setProvider } = useAiStore()
  const [activeTab, setActiveTab] = useState<ProviderType>(provider.type)

  // Load persisted drafts so API keys survive app restarts and provider switches
  const [drafts, setDrafts] = useState<Record<ProviderType, ProviderConfig>>(() => {
    const defaults: Record<ProviderType, ProviderConfig> = {
      Ollama: { type: 'Ollama', base_url: 'http://localhost:11434', model: 'llama3' },
      OpenAI: { type: 'OpenAI', api_key: '', model: 'gpt-4o-mini' },
      Gemini: { type: 'Gemini', api_key: '', model: 'gemini-2.5-flash' },
    }
    try {
      const raw = localStorage.getItem('ai_provider_drafts')
      if (raw) return { ...defaults, ...JSON.parse(raw) }
    } catch {}
    return { ...defaults, [provider.type]: provider }
  })

  const draft = drafts[activeTab]
  const setDraft = (cfg: ProviderConfig | ((prev: ProviderConfig) => ProviderConfig)) =>
    setDrafts(d => {
      const next = { ...d, [activeTab]: typeof cfg === 'function' ? cfg(d[activeTab]) : cfg }
      localStorage.setItem('ai_provider_drafts', JSON.stringify(next))
      return next
    })
  const [saved, setSaved] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [geminiModels, setGeminiModels] = useState<string[]>([])
  const [modelsStatus, setModelsStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [geminiModelsStatus, setGeminiModelsStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [loadStatus, setLoadStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const fetchRef = useRef(0)

  const ollamaUrl = draft.type === 'Ollama' ? (draft.base_url ?? 'http://localhost:11434') : 'http://localhost:11434'

  const fetchOllamaModels = async (baseUrl: string) => {
    const id = ++fetchRef.current
    setModelsStatus('loading')
    try {
      const names = await invoke<string[]>('list_ollama_models', { baseUrl })
      if (id !== fetchRef.current) return
      setOllamaModels(names)
      setModelsStatus(names.length ? 'ok' : 'error')
      if (names.length && !names.includes((draft as { model: string }).model)) {
        setDraft(d => ({ ...d, type: 'Ollama' as const, model: names[0] }))
      }
    } catch {
      if (id !== fetchRef.current) return
      setOllamaModels([])
      setModelsStatus('error')
    }
  }

  const fetchGeminiModels = async (apiKey: string) => {
    if (!apiKey.trim()) return
    setGeminiModelsStatus('loading')
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=50`
      )
      if (!res.ok) throw new Error()
      const data = await res.json()
      // Filter to models that support generateContent
      const names: string[] = (data.models ?? [])
        .filter((m: { supportedGenerationMethods?: string[] }) =>
          m.supportedGenerationMethods?.includes('generateContent')
        )
        .map((m: { name: string }) => m.name.replace('models/', ''))
        .sort()
      setGeminiModels(names)
      setGeminiModelsStatus(names.length ? 'ok' : 'error')
      if (names.length) {
        const cur = draft.type === 'Gemini' ? draft.model : ''
        if (!cur || !names.includes(cur)) {
          // Prefer flash models
          const preferred = names.find(n => n.includes('flash') && !n.includes('preview') && !n.includes('tts') && !n.includes('audio'))
          setDraft(d => ({ ...d, type: 'Gemini' as const, model: preferred ?? names[0] }))
        }
      }
    } catch {
      setGeminiModels([])
      setGeminiModelsStatus('error')
    }
  }

  useEffect(() => {
    if (activeTab !== 'Ollama') return
    setModelsStatus('idle')
  }, [activeTab])

  const handleSave = () => {
    setProvider(drafts[activeTab])
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleLoadModel = async () => {
    setProvider(draft)
    if (draft.type !== 'Ollama') {
      setLoadStatus('ready')
      setTimeout(() => setLoadStatus('idle'), 3000)
      return
    }
    setLoadStatus('loading')
    try {
      await invoke('preload_ollama_model', { baseUrl: ollamaUrl, model: draft.model })
      setLoadStatus('ready')
      setTimeout(() => setLoadStatus('idle'), 4000)
    } catch {
      setLoadStatus('error')
      setTimeout(() => setLoadStatus('idle'), 4000)
    }
  }

  const inputCls = "w-full bg-input text-foreground text-sm rounded-lg px-3 py-2.5 border border-border focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground transition-colors"
  const labelCls = "text-xs font-medium text-muted-foreground block mb-1.5"

  return (
    <div className="p-6 space-y-4">
      <p className="text-xs text-muted-foreground">{t('configureProvider')}</p>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        {/* Provider tabs */}
        <div className="flex items-end gap-0.5 px-4 pt-3 border-b border-border">
          {PROVIDERS.map(tab => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab)
                setModelsStatus('idle')
                setGeminiModelsStatus('idle')
              }}
              className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4">
          {activeTab === 'Ollama' && (
            <>
              <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3 space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('setupGuide')}</p>
                {[
                  ['1', 'ollama.com', 'Download & install Ollama'],
                  ['2', 'Terminal', 'ollama serve'],
                  ['3', 'Terminal', 'ollama pull llama3'],
                  ['4', '↻', 'Click the refresh button to detect models'],
                ].map(([step, label, desc]) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <span className="shrink-0 w-4 h-4 rounded-full bg-primary/20 text-primary text-[9px] font-bold flex items-center justify-center mt-px">{step}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono text-foreground/70 text-[10px] bg-secondary px-1 rounded mr-1">{label}</span>
                      {desc}
                    </span>
                  </div>
                ))}
              </div>

              <div>
                <label className={labelCls}>{t('baseUrl')}</label>
                <div className="flex gap-2">
                  <input type="text" className={inputCls} placeholder="http://localhost:11434"
                    value={draft.type === 'Ollama' ? (draft.base_url ?? '') : 'http://localhost:11434'}
                    onChange={e => setDraft({ type: 'Ollama' as const, base_url: e.target.value, model: draft.model })} />
                  <button
                    onClick={() => fetchOllamaModels(ollamaUrl)}
                    className="shrink-0 text-xs px-3 py-2 rounded-lg border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                  >
                    {modelsStatus === 'loading' ? '…' : '↻'}
                  </button>
                </div>
              </div>
              <div>
                <label className={labelCls}>
                  {t('model')}
                  {modelsStatus === 'ok' && <span className="ml-2 text-[10px] text-muted-foreground font-normal">{ollamaModels.length} {t('available')}</span>}
                  {modelsStatus === 'error' && <span className="ml-2 text-[10px] text-muted-foreground font-normal">{t('ollamaNotReachable')}</span>}
                </label>
                {ollamaModels.length > 0 ? (
                  <select
                    className={inputCls}
                    value={draft.model}
                    onChange={e => setDraft({ ...draft, type: 'Ollama' as const, model: e.target.value })}
                  >
                    {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input type="text" className={inputCls}
                    placeholder={modelsStatus === 'loading' ? t('loadingModel') : 'llama3'}
                    value={draft.model}
                    onChange={e => setDraft({ ...draft, type: 'Ollama' as const, model: e.target.value })} />
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleLoadModel}
                  disabled={loadStatus === 'loading'}
                  className="text-xs font-semibold px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {loadStatus === 'loading' ? t('loadingModel') : t('loadModel')}
                </button>
                {loadStatus === 'ready' && <span className="text-xs font-medium text-green-600">{t('modelReady')}</span>}
                {loadStatus === 'error' && <span className="text-xs font-medium text-destructive">{t('failedToLoad')}</span>}
              </div>
            </>
          )}

          {activeTab === 'OpenAI' && (
            <>
              <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3 space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('setupGuide')}</p>
                {[
                  ['1', 'platform.openai.com/api-keys', 'Open in browser'],
                  ['2', '+ Create', 'Create a new API key'],
                  ['3', 'API Key', 'Paste key in the field below'],
                  ['4', t('save'), 'Save & start chatting'],
                ].map(([step, label, desc]) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <span className="shrink-0 w-4 h-4 rounded-full bg-primary/20 text-primary text-[9px] font-bold flex items-center justify-center mt-px">{step}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono text-foreground/70 text-[10px] bg-secondary px-1 rounded mr-1">{label}</span>
                      {desc}
                    </span>
                  </div>
                ))}
              </div>

              <div>
                <label className={labelCls}>{t('apiKey')}</label>
                <input type="password" className={inputCls} placeholder="sk-..."
                  value={draft.type === 'OpenAI' ? (draft.api_key ?? '') : ''}
                  onChange={e => setDraft({ type: 'OpenAI', api_key: e.target.value, model: draft.type === 'OpenAI' ? draft.model : 'gpt-4o-mini' })} />
              </div>
              <div>
                <label className={labelCls}>{t('model')}</label>
                <input type="text" className={inputCls} placeholder="gpt-4o-mini"
                  value={draft.type === 'OpenAI' ? draft.model : ''}
                  onChange={e => setDraft({ ...draft, type: 'OpenAI' as const, model: e.target.value })} />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleLoadModel}
                  disabled={loadStatus === 'loading'}
                  className="text-xs font-semibold px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {t('loadModel')}
                </button>
                {loadStatus === 'ready' && activeTab === 'OpenAI' && <span className="text-xs font-medium text-green-600">{t('modelReady')}</span>}
              </div>
            </>
          )}

          {activeTab === 'Gemini' && (
            <>
              <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3 space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{t('setupGuide')}</p>
                {[
                  ['1', 'aistudio.google.com', 'Open in browser'],
                  ['2', 'Get API key', 'Create a free API key'],
                  ['3', 'API Key', 'Paste key below & click ↻'],
                  ['4', t('save'), 'Choose a model & save'],
                ].map(([step, label, desc]) => (
                  <div key={step} className="flex items-start gap-2.5">
                    <span className="shrink-0 w-4 h-4 rounded-full bg-primary/20 text-primary text-[9px] font-bold flex items-center justify-center mt-px">{step}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono text-foreground/70 text-[10px] bg-secondary px-1 rounded mr-1">{label}</span>
                      {desc}
                    </span>
                  </div>
                ))}
              </div>

              <div>
                <label className={labelCls}>{t('apiKey')}</label>
                <div className="flex gap-2">
                  <input type="password" className={inputCls} placeholder="AIza..."
                    value={draft.type === 'Gemini' ? (draft.api_key ?? '') : ''}
                    onChange={e => setDraft({ type: 'Gemini', api_key: e.target.value, model: draft.type === 'Gemini' ? draft.model : 'gemini-2.5-flash' })} />
                  <button
                    onClick={() => fetchGeminiModels(draft.type === 'Gemini' ? (draft.api_key ?? '') : '')}
                    disabled={geminiModelsStatus === 'loading' || !(draft.type === 'Gemini' && draft.api_key)}
                    className="shrink-0 text-xs px-3 py-2 rounded-lg border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors disabled:opacity-40"
                    title="Verfügbare Modelle laden"
                  >
                    {geminiModelsStatus === 'loading' ? '…' : '↻'}
                  </button>
                </div>
              </div>
              <div>
                <label className={labelCls}>
                  {t('model')}
                  {geminiModelsStatus === 'ok' && <span className="ml-2 text-[10px] text-muted-foreground font-normal">{geminiModels.length} {t('available')}</span>}
                  {geminiModelsStatus === 'error' && <span className="ml-2 text-[10px] text-destructive font-normal">Fehler beim Laden</span>}
                </label>
                {geminiModels.length > 0 ? (
                  <select
                    className={inputCls}
                    value={draft.type === 'Gemini' ? draft.model : ''}
                    onChange={e => setDraft({ ...draft, type: 'Gemini' as const, model: e.target.value })}
                  >
                    {geminiModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input type="text" className={inputCls} placeholder="gemini-2.5-flash"
                    value={draft.type === 'Gemini' ? draft.model : ''}
                    onChange={e => setDraft({ ...draft, type: 'Gemini' as const, model: e.target.value })} />
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleLoadModel}
                  disabled={loadStatus === 'loading'}
                  className="text-xs font-semibold px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {t('loadModel')}
                </button>
                {loadStatus === 'ready' && activeTab === 'Gemini' && <span className="text-xs font-medium text-green-600">{t('modelReady')}</span>}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border bg-secondary/20 flex items-center gap-3">
          <button
            onClick={handleSave}
            className="border border-border bg-secondary hover:bg-secondary/70 text-foreground text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            {t('save')}
          </button>
          {saved && <span className="text-xs text-emerald-600 font-medium">{t('saved')}</span>}
          <span className="ml-auto text-xs text-muted-foreground">
            Active: {provider.type} · {provider.model}
          </span>
        </div>
      </div>
    </div>
  )
}
