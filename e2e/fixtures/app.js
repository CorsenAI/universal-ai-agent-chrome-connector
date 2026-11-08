document.getElementById('inc').addEventListener('click', (event) => {
  if (!event.isTrusted) return // only real (trusted) input counts
  const el = document.getElementById('count')
  el.textContent = 'Count: ' + (Number(el.textContent.split(': ')[1]) + 1)
})
console.error('Boot failed: missing FEATURE_FLAG')
setTimeout(() => {
  fetch('/api/items', { headers: { authorization: 'Bearer abc.def' } }).then((r) => r.json())
  fetch('/api/broken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'p4ss' }) })
  fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'Viewer', query: 'query Viewer { me { id } }' }) })
  setTimeout(() => { throw new Error('Unhandled boom') }, 10)
}, 200)
