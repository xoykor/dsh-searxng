export const name = 'web-search-searxng'
export const inject = ['web']

export function apply(ctx, config = {}) {
  const endpoint = String(config.baseURL ?? 'http://127.0.0.1:8888').replace(/\/$/, '')
  const provider = {
    id: 'searxng',
    available: () => true,
    async search(request, signal) {
      const url = new URL(`${endpoint}/search`)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      if (request.maxResults !== undefined) url.searchParams.set('number_of_results', String(request.maxResults))
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`)
      const payload = await response.json()
      const sources = Array.isArray(payload.results)
        ? payload.results.filter((item) => typeof item?.url === 'string' && item.url.length > 0).map((item) => ({
            url: item.url,
            ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
            ...(typeof item.content === 'string' && item.content.length > 0 ? { snippet: item.content } : {}),
            ...(typeof item.publishedDate === 'string' && item.publishedDate.length > 0 ? { publishedAt: item.publishedDate } : {})
          }))
        : []
      return { sources, truncated: false }
    }
  }
  ctx.web.registerSearchProvider(provider)
}
