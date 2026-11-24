import { createApp } from 'vue'
import App from './App.vue'
import '../../lib/interface-theme.css'
import './style.css'

const devtoolsTheme = chrome.devtools?.panels?.themeName
if (devtoolsTheme === 'dark' || devtoolsTheme === 'default') {
  document.documentElement.dataset.theme = devtoolsTheme === 'dark' ? 'dark' : 'light'
}

createApp(App).mount('#app')
