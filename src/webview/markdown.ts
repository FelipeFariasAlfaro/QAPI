// Markdown seguro y sin dependencias para las respuestas del chat.
// Soporta bloques, encabezados H1-H6, separadores, listas, citas, links y código.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(value: string): string {
  const codeSpans: string[] = []
  let text = escapeHtml(value)
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`
    codeSpans.push(`<code>${code}</code>`)
    return token
  })
  text = text.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] || '')
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  const paragraph: string[] = []
  let list: 'ul' | 'ol' | null = null

  const closeParagraph = () => {
    if (!paragraph.length) return
    output.push(`<p>${paragraph.map(renderInline).join('<br/>')}</p>`)
    paragraph.length = 0
  }
  const closeList = () => {
    if (!list) return
    output.push(`</${list}>`)
    list = null
  }
  const closeBlocks = () => {
    closeParagraph()
    closeList()
  }
  const addListItem = (tag: 'ul' | 'ol', value: string) => {
    closeParagraph()
    if (list !== tag) {
      closeList()
      list = tag
      output.push(`<${tag}>`)
    }
    output.push(`<li>${renderInline(value)}</li>`)
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = /^```([\w-]*)\s*$/.exec(line)
    if (fence) {
      closeBlocks()
      const code: string[] = []
      index++
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      output.push(`<pre><code data-lang="${escapeHtml(fence[1])}">${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    if (!line.trim()) {
      closeBlocks()
      continue
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      closeBlocks()
      const level = heading[1].length
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeBlocks()
      output.push('<hr/>')
      continue
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (unordered) {
      addListItem('ul', unordered[1])
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (ordered) {
      addListItem('ol', ordered[1])
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      closeBlocks()
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`)
      continue
    }

    closeList()
    paragraph.push(line.trim())
  }

  closeBlocks()
  return output.join('')
}
