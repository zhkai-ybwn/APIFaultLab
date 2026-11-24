chrome.devtools.panels.create('APIFaultLab', 'icons/mark-16.png', 'workbench.html', () => {
  const error = chrome.runtime.lastError
  if (error) console.error('APIFaultLab could not register its DevTools panel:', error.message)
})
