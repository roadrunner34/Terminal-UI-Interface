import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import 'highlight.js/styles/github-dark-dimmed.css'
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

// Outside Electron (plain browser during UI work), use a scripted demo agent.
if (!window.agentDeck) {
  const { installDemoApi } = await import('./lib/demo')
  installDemoApi()
}

export default mount(App, { target: document.getElementById('app')! })
