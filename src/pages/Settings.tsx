import { useState } from 'react'
import { useAiStore, ProviderConfig, ProviderType } from '@/store/ai'

const PROVIDER_TABS: ProviderType[] = ['Ollama', 'OpenAI', 'Gemini']

function OllamaForm({ config, onChange }: {
  config: ProviderConfig
  onChange: (p: ProviderConfig) => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Ollama Base URL</label>
        <input
          type="text"
          className="w-full bg-secondary/50 text-foreground text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="http://localhost:11434"
          value={config.type === 'Ollama' ? (config.base_url ?? '') : 'http://localhost:11434'}
          onChange={e => onChange({ type: 'Ollama', base_url: e.target.value, model: config.model })}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Model</label>
        <input
          type="text"
          className="w-full bg-secondary/50 text-foreground text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="llama3"
          value={config.model}
          onChange={e => onChange({ ...config, type: 'Ollama' as const, model: e.target.value })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Runs locally. Start Ollama with <code className="bg-secondary px-1 rounded">ollama serve</code> and pull a model first.
      </p>
    </div>
  )
}

function ApiKeyForm({ providerType, config, onChange }: {
  providerType: 'OpenAI' | 'Gemini'
  config: ProviderConfig
  onChange: (p: ProviderConfig) => void
}) {
  const defaultModel = providerType === 'OpenAI' ? 'gpt-4o-mini' : 'gemini-1.5-flash'
  const currentKey = config.type === providerType ? (config.api_key ?? '') : ''
  const currentModel = config.type === providerType ? config.model : defaultModel

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground block mb-1">API Key</label>
        <input
          type="password"
          className="w-full bg-secondary/50 text-foreground text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={providerType === 'OpenAI' ? 'sk-...' : 'AIza...'}
          value={currentKey}
          onChange={e => onChange({ type: providerType, api_key: e.target.value, model: currentModel })}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Model</label>
        <input
          type="text"
          className="w-full bg-secondary/50 text-foreground text-sm rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={defaultModel}
          value={currentModel}
          onChange={e => onChange({ type: providerType, api_key: currentKey, model: e.target.value })}
        />
      </div>
    </div>
  )
}

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

  return (
    <div className="p-6 max-w-lg space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure your AI coaching provider.</p>
      </div>

      {/* Provider tabs */}
      <div className="space-y-4">
        <div className="flex gap-1 border-b border-border">
          {PROVIDER_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab)
                if (tab === 'Ollama') {
                  setDraft({
                    type: 'Ollama',
                    base_url: provider.type === 'Ollama' ? provider.base_url : 'http://localhost:11434',
                    model: provider.type === 'Ollama' ? provider.model : 'llama3',
                  })
                } else if (tab === 'OpenAI') {
                  setDraft({
                    type: 'OpenAI',
                    api_key: provider.type === 'OpenAI' ? provider.api_key : '',
                    model: provider.type === 'OpenAI' ? provider.model : 'gpt-4o-mini',
                  })
                } else {
                  setDraft({
                    type: 'Gemini',
                    api_key: provider.type === 'Gemini' ? provider.api_key : '',
                    model: provider.type === 'Gemini' ? provider.model : 'gemini-1.5-flash',
                  })
                }
              }}
              className={`text-sm px-4 py-2 transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="pt-2">
          {activeTab === 'Ollama' && (
            <OllamaForm config={draft} onChange={setDraft} />
          )}
          {activeTab === 'OpenAI' && (
            <ApiKeyForm providerType="OpenAI" config={draft} onChange={setDraft} />
          )}
          {activeTab === 'Gemini' && (
            <ApiKeyForm providerType="Gemini" config={draft} onChange={setDraft} />
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded hover:bg-primary/90 transition-colors"
        >
          Save
        </button>
        {saved && <span className="text-xs text-muted-foreground">Saved ✓</span>}
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          <strong>Active provider:</strong> {provider.type} — {provider.model}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Settings are saved to browser localStorage.
        </p>
      </div>
    </div>
  )
}
