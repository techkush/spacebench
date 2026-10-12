import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LabApp } from './lab/LabApp'
import { isLabWindow } from './lib/labLink'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLabWindow() ? <LabApp /> : <App />}
  </StrictMode>,
)
