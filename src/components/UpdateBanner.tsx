import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'

type UpdateState = 'idle' | 'available' | 'downloading' | 'done'

export default function UpdateBanner() {
  const t = useT()
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
            {t('updateInstalled').replace('{v}', newVersion)}
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold text-foreground">{t('updateAvailable').replace('{v}', newVersion)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('updateDescription')}</p>
            <button
              onClick={handleInstall}
              disabled={state === 'downloading'}
              className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {state === 'downloading' ? t('installing') : t('updateNow')}
            </button>
          </>
        )}
      </div>
      {state !== 'downloading' && (
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm leading-none mt-0.5"
          aria-label="Close"
        >
          ✕
        </button>
      )}
    </div>
  )
}
