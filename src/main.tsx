import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'
import './styles/app.css'

import App from './App'
import { installDiagnostics, mediaBase } from './lib/api'

installDiagnostics()

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root is missing from index.html')
}

// Resolve the backend address before the first render: every asset URL (logos,
// the API, the media socket) depends on it, and rendering early would paint
// broken images for a frame.
void mediaBase().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  // Only drop the boot splash once React has painted, so the window never flashes.
  requestAnimationFrame(() => {
    document.getElementById('boot')?.remove()
    document.body.classList.add('is-ready')
  })
})