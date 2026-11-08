import '../zod-setup'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../shared-ui/styles.css'
import { App } from './App'

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
