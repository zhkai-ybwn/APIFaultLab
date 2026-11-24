import { createApp } from 'vue'
import App from './App.vue'
import '../../lib/interface-theme.css'

const darkMode = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  document.documentElement.dataset.theme = darkMode.matches ? 'dark' : 'light'
}
applyTheme()
darkMode.addEventListener('change', applyTheme)

createApp(App).mount('#app')
