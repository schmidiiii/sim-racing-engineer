import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { applyAccent, loadAccent } from '@/lib/accent'

// Before the first render, so the app never flashes the default colour on its
// way to the chosen one. The theme class is set by App, which re-applies it.
applyAccent(loadAccent())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
