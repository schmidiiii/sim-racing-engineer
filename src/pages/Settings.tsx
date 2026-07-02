import { useState } from 'react'
import { useAiStore, ProviderConfig, ProviderType } from '@/store/ai'

const PROVIDERS: ProviderType[] = ['Ollama', 'OpenAI', 'Gemini']

export default function Settings() {
  const { provider, setProvider } = useAiStore()
  const [activeTab, setActiveTab] = useState<ProviderType>(provider.type)
  const [draft, setDraft] = useState<ProviderConfig>(provider)
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    setProvider(draft)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const inputCls = "w-full bg-input text-foreground text-sm rounded-lg px-3 py-2.5 border border-border focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground transition-colors"
  const labelCls = "text-xs font-medium text-muted-foreground block mb-1.5"

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h1 className="text-base font-semibold text-foreground">Settings</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Configure your AI coaching provider.</p>
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        {/* Provider tabs */}
        <div className="flex items-end gap-0.5 px-4 pt-3 border-b border-border">
          {PROVIDERS.map(tab => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab)
                if (tab === 'Ollama') setDraft({ type: 'Ollama', base_url: provider.type === 'Ollama' ? provider.base_url : 'http://localhost:11434', model: provider.type === 'Ollama' ? provider.model : 'llama3' })
                else if (tab === 'OpenAI') setDraft({ type: 'OpenAI', api_key: provider.type === 'OpenAI' ? provider.api_key : '', model: provider.type === 'OpenAI' ? provider.model : 'gpt-4o-mini' })
                else setDraft({ type: 'Gemini', api_key: provider.type === 'Gemini' ? provider.api_key : '', model: provider.type === 'Gemini' ? provider.model : 'gemini-1.5-flash' })
              }}
              className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                activeTab === tab
                  ? 'border-racing-amber text-racing-amber'
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
              <div>
                <label className={labelCls}>Base URL</label>
                <input type="text" className={inputCls} placeholder="http://localhost:11434"
                  value={draft.type === 'Ollama' ? (draft.base_url ?? '') : 'http://localhost:11434'}
                  onChange={e => setDraft({ type: 'Ollama' as const, base_url: e.target.value, model: draft.model })} />
              </div>
              <div>
                <label className={labelCls}>Model</label>
                <input type="text" className={inputCls} placeholder="llama3"
                  value={draft.model}
                  onChange={e => setDraft({ ...draft, type: 'Ollama' as const, model: e.target.value })} />
              </div>
              <p className="text-xs text-muted-foreground">Run <code className="bg-secondary px-1.5 py-0.5 rounded font-mono">ollama serve</code> locally and pull a model first.</p>
            </>
          )}
          {(activeTab === 'OpenAI' || activeTab === 'Gemini') && (
            <>
              <div>
                <label className={labelCls}>API Key</label>
                <input type="password" className={inputCls}
                  placeholder={activeTab === 'OpenAI' ? 'sk-...' : 'AIza...'}
                  value={draft.type === activeTab ? (draft.api_key ?? '') : ''}
                  onChange={e => setDraft({ type: activeTab, api_key: e.target.value, model: draft.type === activeTab ? draft.model : (activeTab === 'OpenAI' ? 'gpt-4o-mini' : 'gemini-1.5-flash') })} />
              </div>
              <div>
                <label className={labelCls}>Model</label>
                <input type="text" className={inputCls}
                  placeholder={activeTab === 'OpenAI' ? 'gpt-4o-mini' : 'gemini-1.5-flash'}
                  value={draft.type === activeTab ? draft.model : ''}
                  onChange={e => setDraft({ ...draft, type: activeTab, model: e.target.value })} />
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border bg-secondary/20 flex items-center gap-3">
          <button
            onClick={handleSave}
            className="bg-racing-amber hover:bg-racing-amber-dark text-background text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            Save
          </button>
          {saved && <span className="text-xs text-racing-green font-medium">Saved ✓</span>}
          <span className="ml-auto text-xs text-muted-foreground">
            Active: {provider.type} · {provider.model}
          </span>
        </div>
      </div>
    </div>
  )
}
