import { resolve } from 'node:path'
import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  hooks: {
    'build:publicAssets': (wxt, files) => {
      for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
        files.push({ absoluteSrc: resolve(wxt.config.root, file), relativeDest: file })
      }
    },
  },
  manifest: {
    name: 'APIFaultLab 接口异常测试',
    description: '在当前开发页面模拟接口异常，查看命中结果并复用测试方案。',
    minimum_chrome_version: '128',
    icons: { 16: 'icons/mark-16.png', 32: 'icons/mark-32.png', 48: 'icons/mark-48.png', 128: 'icons/mark-128.png' },
    action: {
      default_title: '打开 APIFaultLab',
      default_icon: { 16: 'icons/mark-16.png', 32: 'icons/mark-32.png' },
    },
    permissions: ['activeTab', 'scripting', 'storage', 'webNavigation'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
})
