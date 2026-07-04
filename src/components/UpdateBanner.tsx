import { useEffect, useState } from 'react'

type UpdateState = 'idle' | 'available' | 'downloading' | 'done'

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>('idle')
  const [newVersion, setNewVersion] = useState('')
  const [dismissed, setDismissed] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [updateObj, setUpdateObj] = useState<any>(null)

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    import('@tauri-apps/plugin-updater').then(({ check }) =>
      check()
        .then(u => { if (u?.available) { setUpdateObj(u); setNewVersion(u.version); setState('available') } })
        .catch(() => {})
    )
  }, [])

  if (state === 'idle' || dismissed) return null

  const handleInstall = async () => {
    setState('downloading')
    try {
      await updateObj.downloadAndInstall()
      setState('done')
    } catch {
      setState('available')
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-card border border-border rounded-xl shadow-xl px-4 py-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        {state === 'done' ? (
          <p className="text-sm text-foreground">
            Update installiert — App neu starten, um Version {newVersion} zu nutzen.
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold text-foreground">Update verfügbar: v{newVersion}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Eine neue Version von Sim Racing Engineer ist bereit.</p>
            <button
              onClick={handleInstall}
              disabled={state === 'downloading'}
              className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {state === 'downloading' ? 'Installiere…' : 'Jetzt updaten'}
            </button>
          </>
        )}
      </div>
      {state !== 'downloading' && (
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm leading-none mt-0.5"
          aria-label="Schließen"
        >
          ✕
        </button>
      )}
    </div>
  )
}
